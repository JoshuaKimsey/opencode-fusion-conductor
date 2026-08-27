'use strict';

// Builds a fully isolated opencode environment for the Conductor PLUGIN
// integration tests: a throwaway HOME with the plugin installed (NOT agent
// .md files), an opencode.json pointing every model at the fake provider and
// containing NO agent entries, and a scratch project directory. The user's
// real ~/.config/opencode is never read - opencode resolves everything
// through the redirected HOME.
//
// The plugin is installed one of two empirically verified mechanisms:
//
//   - "plugins-dir" (default): a shim at
//     <home>/.config/opencode/plugins/conductor.js whose entire content
//     re-exports the repo plugin by absolute path, e.g.
//       export { Conductor } from "<abs path to repo>/src/index.js"
//     opencode 1.18.x imports every *.js in {plugin,plugins}/ and treats
//     every function export as a plugin, so the re-exported named export is
//     picked up (verified live against opencode 1.18.20). A package.json
//     declaring "type": "module" sits next to it so Bun resolves the .js
//     shim as ESM deterministically. When plugin options are needed, the
//     shim wraps the plugin instead:
//       import { Conductor } from "...";
//       export const ConductorWithOptions = (input) => Conductor(input, { ...options });
//
//   - "plugin-array": the config "plugin" array entry
//       ["file://<abs path to repo>/src/index.js", { ...options }]
//     opencode 1.18.x resolves file: specs as local plugin paths and passes
//     the tuple's second element to the plugin as its options argument
//     (verified live: profile options reached the config hook). Preferred
//     for the options test because the options ride the actual plugin spec;
//     the wrapper shim above is the fallback that also works.
//
// The config declares the fake provider only. For profile option tests the
// provider is named after the profile's provider prefix (e.g. "opencode-go")
// and registers every model the profile references, so the profile-assigned
// models resolve against the fake provider and appear on the wire.
//
// This module is self-contained: the opencode-run helpers below (runOpencode,
// opencodeBin, isV2, toolName, taskArgs, opencodeAvailable) were absorbed from
// the legacy integration harness with the v2/dead code paths dropped - the
// conductor harness drives the v1 `opencode` binary only.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn, spawnSync } = require('node:child_process');

const repoRoot = path.join(__dirname, '..', '..');
const PLUGIN_ENTRY = path.join(repoRoot, 'src', 'index.js');
const PLUGIN_FILE_URL = pathToFileURL(PLUGIN_ENTRY).href;

const PASSTHROUGH_ENV = new Set([
  'path',
  'pathext',
  'systemroot',
  'comspec',
  'temp',
  'tmp',
  'tmpdir',
  'lang',
  'lc_all',
  'ci',
]);

/** The opencode executable under test. v1 only - the conductor harness
    drives the plain `opencode` binary on PATH. */
function opencodeBin() {
  return 'opencode';
}

/** v1 only: the v2 rename branching was dropped with the legacy harness. */
function isV2() {
  return false;
}

/** The name the binary under test exposes for a v1 tool name. */
function toolName(v1Name) {
  return v1Name;
}

/** Arguments for a delegation call. v1's `task` takes `subagent_type`;
    description and prompt are unchanged. */
function taskArgs({ agent, description, prompt }) {
  return { subagent_type: agent, description, prompt };
}

/** Seed an empty local catalog so startup never reads the developer's cache
    or reaches models.dev. The configured fake provider supplies its model. */
function seedCatalog(fakeHome) {
  const target = path.join(fakeHome, '.cache', 'opencode', 'models.json');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, '{}');
}

function isolatedProcessEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && PASSTHROUGH_ENV.has(key.toLowerCase())) env[key] = value;
  }
  return env;
}

function seedGitBoundary(projectDir) {
  const gitDir = path.join(projectDir, '.git');
  fs.mkdirSync(path.join(gitDir, 'objects'), { recursive: true });
  fs.mkdirSync(path.join(gitDir, 'refs', 'heads'), { recursive: true });
  fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(
    path.join(gitDir, 'config'),
    '[core]\n\trepositoryformatversion = 0\n\tbare = false\n'
  );
}

/** Resolve a subscription profile's provider name, model ids, and per-role
    bare model ids straight from src/profiles.js so the integration tests
    assert whatever the plugin's own resolution would assign. */
async function profileInfo(profileName) {
  const { PROFILES } = await import(pathToFileURL(path.join(repoRoot, 'src', 'profiles.js')).href);
  const profile = PROFILES[profileName];
  if (!profile) {
    throw new Error(
      `Unknown conductor profile "${profileName}". Available profiles: ${Object.keys(PROFILES).join(', ')}`
    );
  }
  const split = (spec) => {
    const slash = spec.indexOf('/');
    return slash === -1
      ? { provider: spec, model: spec }
      : { provider: spec.slice(0, slash), model: spec.slice(slash + 1) };
  };
  const { provider } = split(profile.model);
  const models = new Set();
  const modelByRole = {};
  const collect = (spec) => models.add(split(spec).model);
  collect(profile.model);
  collect(profile.small_model);
  for (const [role, spec] of Object.entries(profile.agents)) {
    modelByRole[role] = split(spec).model;
    collect(spec);
  }
  return { provider, models: [...models].sort(), modelByRole };
}

/** Create the isolated home + project with the plugin installed and NO agent
    entries or agent files. Returns paths, the env for spawning opencode, and
    a cleanup() that removes everything. Options:
      mechanism      - "plugins-dir" (default) | "plugin-array"
      pluginOptions  - options passed to the plugin (e.g. { profile: "..." })
      provider       - provider id to register under the fake baseURL
      models         - model ids to register under that provider
      model          - top-level model spec ("provider/model")
      smallModel     - top-level small_model spec */
async function createConductorEnv(baseURL, options = {}) {
  const {
    mechanism = 'plugins-dir',
    pluginOptions,
    provider,
    models,
    model,
    smallModel,
  } = options;

  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-int-home-'));
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-int-proj-'));
  const configDir = path.join(fakeHome, '.config', 'opencode');
  fs.mkdirSync(configDir, { recursive: true });
  // Deliberately NO agent/ directory and NO agent entries anywhere: everything
  // injected must come from the plugin's config hook, or the live tests fail.

  let providerName = provider;
  let modelIds = models;
  let topModel = model;
  let topSmall = smallModel;

  // A profile option implies the profile's provider prefix and models: the
  // fake provider must serve the exact models the profile assigns to roles.
  if (pluginOptions?.profile && !providerName) {
    const info = await profileInfo(pluginOptions.profile);
    providerName = info.provider;
    modelIds = info.models;
    topModel = info.modelByRole.build ? `${info.provider}/${info.modelByRole.build}` : undefined;
    topSmall = info.modelByRole.sidekick
      ? `${info.provider}/${info.modelByRole.sidekick}`
      : undefined;
  }
  providerName = providerName ?? 'fake';
  modelIds = modelIds ?? ['fake-model'];
  topModel = topModel ?? `${providerName}/${modelIds[0]}`;
  topSmall = topSmall ?? `${providerName}/${modelIds[0]}`;

  const config = {
    $schema: 'https://opencode.ai/config.json',
    model: topModel,
    small_model: topSmall,
    enabled_providers: [providerName],
    provider: {
      [providerName]: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Fake',
        options: { baseURL, apiKey: 'fake-test-key' },
        models: Object.fromEntries(modelIds.map((id) => [id, { name: `Fake ${id}` }])),
      },
    },
  };

  if (mechanism === 'plugin-array') {
    config.plugin = [[PLUGIN_FILE_URL, pluginOptions ?? {}]];
  } else if (mechanism === 'plugins-dir') {
    fs.mkdirSync(path.join(configDir, 'plugins'), { recursive: true });
    const shim = pluginOptions
      ? [
          `import { Conductor } from "${PLUGIN_ENTRY}";`,
          '',
          `export const ConductorWithOptions = (input) => Conductor(input, ${JSON.stringify(pluginOptions)});`,
          '',
        ].join('\n')
      : `export { Conductor } from "${PLUGIN_ENTRY}";\n`;
    fs.writeFileSync(path.join(configDir, 'plugins', 'conductor.js'), shim);
    // Bun resolves .js module format from the nearest package.json "type"
    // field; this makes the ESM shim load deterministically.
    fs.writeFileSync(path.join(configDir, 'package.json'), JSON.stringify({ type: 'module' }));
  } else {
    throw new Error(
      `Unknown conductor env mechanism "${mechanism}" (expected "plugins-dir" or "plugin-array")`
    );
  }

  const configText = JSON.stringify(config, null, 2);
  fs.writeFileSync(path.join(configDir, 'opencode.json'), configText);
  fs.writeFileSync(path.join(projectDir, 'opencode.json'), configText);
  fs.writeFileSync(path.join(projectDir, 'README.md'), 'conductor integration fixture\n');
  seedGitBoundary(projectDir);
  seedCatalog(fakeHome);

  const env = isolatedProcessEnv();
  Object.assign(env, {
    HOME: fakeHome,
    USERPROFILE: fakeHome, // Windows home resolution
    XDG_CONFIG_HOME: path.join(fakeHome, '.config'),
    XDG_DATA_HOME: path.join(fakeHome, '.local', 'share'),
    XDG_CACHE_HOME: path.join(fakeHome, '.cache'),
    XDG_STATE_HOME: path.join(fakeHome, '.local', 'state'),
  });

  return {
    fakeHome,
    projectDir,
    env,
    cleanup() {
      for (const dir of [fakeHome, projectDir]) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {
          // Windows can hold locks briefly; leftover temp dirs are harmless.
        }
      }
    },
  };
}

/** Run `opencode run` non-interactively for one agent and resolve with
    { code, stdout, stderr }. Kills the process if it exceeds timeoutMs.
    v1 only: `run` takes --dir and the harness keeps its own cwd. */
function runOpencode({ agent, message, envInfo, timeoutMs = 120000 }) {
  return new Promise((resolve, reject) => {
    // Single command string avoids the Windows args-with-shell pitfalls;
    // temp paths never contain quotes.
    const bin = opencodeBin();
    const command = [
      bin,
      'run',
      `--dir "${envInfo.projectDir}"`,
      `--agent ${agent}`,
      '--log-level ERROR',
      `"${message}"`,
    ].join(' ');
    const child = spawn(command, { env: envInfo.env, shell: true });
    child.stdin.end(); // opencode run waits for piped stdin until EOF on non-tty
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const killTimer = setTimeout(() => {
      if (process.platform === 'win32') {
        // shell:true wraps the real process; killing the wrapper alone would
        // leave a hung opencode running. taskkill fells the whole tree.
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
      } else {
        child.kill('SIGKILL');
      }
      reject(
        new Error(
          `${opencodeBin()} run --agent ${agent} timed out after ${timeoutMs}ms\nstderr: ${stderr.slice(-2000)}`
        )
      );
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(killTimer);
      reject(err);
    });
    child.on('exit', (code) => {
      clearTimeout(killTimer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** True when an opencode binary is reachable on PATH. */
function opencodeAvailable() {
  const probe = spawnSync(`${opencodeBin()} --version`, {
    shell: true,
    encoding: 'utf8',
    timeout: 30000,
  });
  return probe.status === 0;
}

module.exports = {
  createConductorEnv,
  profileInfo,
  runOpencode,
  opencodeAvailable,
  opencodeBin,
  isV2,
  toolName,
  taskArgs,
  PLUGIN_ENTRY,
  PLUGIN_FILE_URL,
};