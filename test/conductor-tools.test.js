'use strict';

const { test, describe, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..');

let ENTRY;

let conductorTools;
let configureTool;
let statusTool;
let PROFILES;

before(async () => {
  const load = (name) => import(pathToFileURL(path.join(root, 'src', name)).href);
  const [toolsIndex, configure, status, profiles, constants] = await Promise.all([
    load('tools/index.js'),
    load('tools/configure.js'),
    load('tools/status.js'),
    load('profiles.js'),
    load('constants.js'),
  ]);
  conductorTools = toolsIndex.conductorTools;
  configureTool = configure.configureTool;
  statusTool = status.statusTool;
  PROFILES = profiles.PROFILES;
  ENTRY = constants.PACKAGE_NAME;
});

// The tools resolve the global config from XDG_CONFIG_HOME || ~/.config at
// execute time, so every test pins both variables to throwaway dirs (and the
// "~/.config fallback" test clears XDG itself). node:test runs the tests in
// this file sequentially, so process-level env mutation is safe; afterEach
// restores the original values.
let homeDir;
let xdgDir;
let savedHome;
let savedXdg;
let projectDirs;

beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-tools-home-'));
  xdgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-tools-xdg-'));
  savedHome = process.env.HOME;
  savedXdg = process.env.XDG_CONFIG_HOME;
  process.env.HOME = homeDir;
  process.env.XDG_CONFIG_HOME = xdgDir;
  projectDirs = [];
});

afterEach(() => {
  for (const dir of projectDirs) fs.rmSync(dir, { recursive: true, force: true });
  projectDirs = [];
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg;
  fs.rmSync(homeDir, { recursive: true, force: true });
  fs.rmSync(xdgDir, { recursive: true, force: true });
});

function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-tools-proj-'));
  projectDirs.push(dir);
  return dir;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Writes a project opencode.json whose plugin array holds a conductor entry;
// returns the config file path. options defaults to {} so the entry is always
// tuple-form unless bare=true (bare string form, optionally pinned).
function projectWithEntry(dir, { options = {}, version, bare = false } = {}) {
  const spec = version ? `${ENTRY}@${version}` : ENTRY;
  const file = path.join(dir, 'opencode.json');
  const entry = bare ? spec : [spec, options];
  writeJson(file, { plugin: [entry] });
  return file;
}

const configure = (args, context) =>
  configureTool().execute(args, { directory: context?.directory ?? makeProject(), agent: context?.agent ?? 'build' });

const status = (context) =>
  statusTool().execute({}, { directory: context?.directory ?? makeProject(), agent: context?.agent ?? 'build' });

describe('conductor_configure and conductor_status tool surface', () => {
  test('conductorTools returns exactly the two conductor tools', () => {
    assert.deepEqual(Object.keys(conductorTools({})).sort(), ['conductor_configure', 'conductor_status']);
    assert.deepEqual(Object.keys(conductorTools({ claude: true })).sort(), [
      'conductor_configure',
      'conductor_status',
    ]);
  });

  test('caller gate refuses every non-build/plan agent and allows build/plan', async () => {
    const tools = conductorTools();
    const directory = makeProject();
    for (const agent of ['sidekick', 'research', 'design', 'reviewer', 'vision', 'explore', undefined]) {
      await assert.rejects(
        tools.conductor_configure.execute({ profile: 'chatgpt' }, { directory, agent }),
        /only serve the build and plan agents/i
      );
      await assert.rejects(
        tools.conductor_status.execute({}, { directory, agent }),
        /only serve the build and plan agents/i
      );
    }
    // build/plan pass the gate: configure proceeds to entry discovery (which
    // errors because no config exists here) and status produces a report.
    await assert.rejects(
      tools.conductor_configure.execute({ profile: 'chatgpt' }, { directory, agent: 'build' }),
      /No opencode\.json containing the conductor plugin entry/i
    );
    await assert.rejects(
      tools.conductor_configure.execute({ profile: 'chatgpt' }, { directory, agent: 'plan' }),
      /No opencode\.json containing the conductor plugin entry/i
    );
    const report = await tools.conductor_status.execute({}, { directory, agent: 'build' });
    assert.match(report, /Conductor status/);
    assert.match(await tools.conductor_status.execute({}, { directory, agent: 'plan' }), /Conductor status/);
  });

  test('requires at least one of the five options', async () => {
    const file = projectWithEntry(makeProject());
    await assert.rejects(configure({}, { directory: path.dirname(file) }), /at least one of: profile, models, remove, audit, claude/);
  });
});

describe('conductor_configure entry discovery', () => {
  test('prefers the project opencode.json over the global one', async () => {
    const projectDir = makeProject();
    const projectFile = projectWithEntry(projectDir, { options: { profile: 'opencode-go' } });
    const globalFile = path.join(xdgDir, 'opencode', 'opencode.json');
    writeJson(globalFile, { plugin: [[ENTRY, { profile: 'chatgpt' }]] });

    const out = await configure({ profile: 'opencode-zen' }, { directory: projectDir });
    assert.ok(out.includes(projectFile), 'report must name the project config');
    assert.deepEqual(readJson(projectFile).plugin[0][1], { profile: 'opencode-zen' });
    // The global config must stay untouched.
    assert.deepEqual(readJson(globalFile).plugin[0][1], { profile: 'chatgpt' });
  });

  test('falls back to the XDG global config when the project has none', async () => {
    const projectDir = makeProject();
    const globalFile = path.join(xdgDir, 'opencode', 'opencode.json');
    writeJson(globalFile, { plugin: [ENTRY] });

    const out = await configure({ audit: true }, { directory: projectDir });
    assert.ok(out.includes(globalFile));
    assert.deepEqual(readJson(globalFile).plugin, [[ENTRY, { audit: true }]]);
  });

  test('falls back to ~/.config/opencode when XDG_CONFIG_HOME is unset or empty', async () => {
    const projectDir = makeProject();
    const globalFile = path.join(homeDir, '.config', 'opencode', 'opencode.json');
    writeJson(globalFile, { plugin: [ENTRY] });

    delete process.env.XDG_CONFIG_HOME;
    let out = await configure({ profile: 'chatgpt' }, { directory: projectDir });
    assert.ok(out.includes(globalFile));

    process.env.XDG_CONFIG_HOME = '';
    out = await configure({ audit: true }, { directory: projectDir });
    assert.ok(out.includes(globalFile));
    assert.deepEqual(readJson(globalFile).plugin, [[ENTRY, { profile: 'chatgpt', audit: true }]]);
  });

  test('matches all four plugin entry forms and preserves the spec on each', async () => {
    const forms = [
      { entry: ENTRY, spec: ENTRY },
      { entry: `${ENTRY}@1.2.3`, spec: `${ENTRY}@1.2.3` },
      { entry: [ENTRY, { profile: 'chatgpt' }], spec: ENTRY },
      { entry: [`${ENTRY}@1.2.3`, { profile: 'chatgpt' }], spec: `${ENTRY}@1.2.3` },
    ];
    for (const { entry, spec } of forms) {
      const projectDir = makeProject();
      const file = path.join(projectDir, 'opencode.json');
      writeJson(file, { plugin: [entry] });

      const out = await configure({ audit: true }, { directory: projectDir });
      assert.ok(out.includes('audit'), 'report must show the audit change');
      const config = readJson(file);
      assert.equal(config.plugin[0][0], spec, 'spec must be preserved on the written entry');
      assert.equal(config.plugin[0][1].audit, true);
    }
  });

  test('preserves the pinned version exactly when normalizing a bare string to tuple form', async () => {
    const projectDir = makeProject();
    const file = projectWithEntry(projectDir, { version: '2.0.0-beta.1', bare: true });
    await configure({ profile: 'chatgpt' }, { directory: projectDir });
    assert.deepEqual(readJson(file).plugin, [[`${ENTRY}@2.0.0-beta.1`, { profile: 'chatgpt' }]]);
  });

  test('preserves the pinned version exactly on an already-tuple entry', async () => {
    const projectDir = makeProject();
    const file = projectWithEntry(projectDir, { options: { profile: 'opencode-go' }, version: '1.2.3' });
    await configure({ models: { sidekick: 'custom/fast' } }, { directory: projectDir });
    assert.deepEqual(readJson(file).plugin, [
      [`${ENTRY}@1.2.3`, { profile: 'opencode-go', models: { sidekick: 'custom/fast' } }],
    ]);
  });

  test('a project opencode.json without the entry falls through to the global config', async () => {
    const projectDir = makeProject();
    writeJson(path.join(projectDir, 'opencode.json'), { theme: 'dark', plugin: ['some-other-plugin'] });
    const globalFile = path.join(xdgDir, 'opencode', 'opencode.json');
    writeJson(globalFile, { plugin: [ENTRY] });

    const out = await configure({ audit: true }, { directory: projectDir });
    assert.ok(out.includes(globalFile));
    const project = readJson(path.join(projectDir, 'opencode.json'));
    assert.equal(project.plugin[0], 'some-other-plugin', 'the foreign plugin entry must stay untouched');
    assert.equal(project.theme, 'dark');
  });
});

describe('conductor_configure validation', () => {
  test('unknown profile is refused, lists valid names, and leaves the file byte-identical', async () => {
    const projectDir = makeProject();
    const file = projectWithEntry(projectDir, { options: { profile: 'opencode-go' } });
    const original = fs.readFileSync(file, 'utf8');

    await assert.rejects(
      configure({ profile: 'nope' }, { directory: projectDir }),
      (error) => {
        assert.match(error.message, /Unknown conductor profile "nope"/);
        for (const name of Object.keys(PROFILES)) {
          assert.ok(error.message.includes(name), `error must name available profile ${name}`);
        }
        return true;
      }
    );
    assert.equal(fs.readFileSync(file, 'utf8'), original, 'file must stay byte-identical');
    assert.ok(!fs.existsSync(`${file}.conductor-backup`), 'no backup may be written on refusal');
  });

  test('unknown role in models or remove is refused', async () => {
    const projectDir = makeProject();
    const file = projectWithEntry(projectDir);
    const original = fs.readFileSync(file, 'utf8');

    await assert.rejects(
      configure({ models: { nope: 'a/b' } }, { directory: projectDir }),
      /Unknown role "nope" in models/
    );
    await assert.rejects(
      configure({ remove: ['nope'] }, { directory: projectDir }),
      /Unknown role "nope" in remove/
    );
    assert.equal(fs.readFileSync(file, 'utf8'), original);
  });

  test('malformed model values are refused', async () => {
    const projectDir = makeProject();
    const file = projectWithEntry(projectDir);
    const original = fs.readFileSync(file, 'utf8');
    for (const bad of ['nope', 'a/b/c', '/x', 'x/', 'a/ b', 'a b/c', '']) {
      await assert.rejects(
        configure({ models: { sidekick: bad } }, { directory: projectDir }),
        /provider\/model-id/,
        `model ${JSON.stringify(bad)} must be refused`
      );
    }
    assert.equal(fs.readFileSync(file, 'utf8'), original);
  });

  test('non-object models and non-array remove arguments are refused', async () => {
    const projectDir = makeProject();
    const file = projectWithEntry(projectDir);
    await assert.rejects(configure({ models: 'nope' }, { directory: projectDir }), /"models" must be an object/);
    await assert.rejects(configure({ remove: 'sidekick' }, { directory: projectDir }), /"remove" must be an array/);
    assert.deepEqual(readJson(file).plugin, [[ENTRY, {}]]);
  });

  test('a malformed JSON config errors, names the file, and stays untouched', async () => {
    const projectDir = makeProject();
    const file = path.join(projectDir, 'opencode.json');
    const original = '{ this is not valid json';
    fs.writeFileSync(file, original);
    await assert.rejects(
      configure({ profile: 'chatgpt' }, { directory: projectDir }),
      (error) => {
        assert.ok(error.message.includes(file));
        assert.match(error.message, /not valid JSON/);
        assert.match(error.message, /No changes were made/);
        return true;
      }
    );
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    assert.ok(!fs.existsSync(`${file}.conductor-backup`));
  });

  test('an opencode.jsonc-only setup is refused with a hand-edit message', async () => {
    const projectDir = makeProject();
    const jsonc = path.join(projectDir, 'opencode.jsonc');
    fs.writeFileSync(jsonc, '{ /* comment */ "plugin": [] }');
    await assert.rejects(
      configure({ profile: 'chatgpt' }, { directory: projectDir }),
      (error) => {
        assert.ok(error.message.includes(jsonc));
        assert.match(error.message, /\.jsonc files cannot be parsed or edited safely/);
        assert.ok(error.message.includes(ENTRY));
        return true;
      }
    );
    assert.ok(!fs.existsSync(path.join(projectDir, 'opencode.json')));
    assert.ok(!fs.existsSync(path.join(projectDir, 'opencode.json.conductor-backup')));
  });

  test('missing plugin entry everywhere produces an actionable error', async () => {
    const projectDir = makeProject();
    // No config at all: same actionable error.
    await assert.rejects(
      configure({ profile: 'chatgpt' }, { directory: projectDir }),
      (error) => {
        assert.match(error.message, /No opencode\.json containing the conductor plugin entry/);
        assert.ok(error.message.includes(path.join(projectDir, 'opencode.json')));
        assert.ok(error.message.includes(path.join(xdgDir, 'opencode', 'opencode.json')));
        assert.ok(error.message.includes(`["${ENTRY}", {}]`), 'error must suggest the tuple entry');
        return true;
      }
    );

    // A project config that exists but holds no conductor entry: same error,
    // still nothing written anywhere.
    const file = path.join(projectDir, 'opencode.json');
    const original = JSON.stringify({ plugin: ['other-plugin'] });
    fs.writeFileSync(file, original);
    await assert.rejects(configure({ profile: 'chatgpt' }, { directory: projectDir }), /No opencode\.json containing the conductor plugin entry/);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
  });

  test('__proto__ in the models argument cannot pollute anything', async () => {
    const projectDir = makeProject();
    const file = projectWithEntry(projectDir);
    const evil = JSON.parse('{"models":{"__proto__":{"build":"evil/model"}}}');
    await assert.rejects(
      configure(evil, { directory: projectDir }),
      /Unknown role "__proto__" in models/
    );
    assert.equal({}.build, undefined, 'Object.prototype must not be polluted');
    assert.equal({}.sidekick, undefined);
    assert.deepEqual(readJson(file).plugin, [[ENTRY, {}]], 'stored options must stay untouched');
  });
});

describe('conductor_configure update semantics and write safety', () => {
  test('profile replaces the stored profile', async () => {
    const projectDir = makeProject();
    const file = projectWithEntry(projectDir, { options: { profile: 'opencode-go', claude: true } });
    const out = await configure({ profile: 'chatgpt' }, { directory: projectDir });
    assert.match(out, /profile: "opencode-go" -> "chatgpt"/);
    assert.deepEqual(readJson(file).plugin[0][1], { profile: 'chatgpt', claude: true });
  });

  test('models merge key-wise into the stored overrides', async () => {
    const projectDir = makeProject();
    const file = projectWithEntry(projectDir, {
      options: { profile: 'opencode-go', models: { build: 'old/build', sidekick: 'old/fast' } },
    });
    const out = await configure({ models: { sidekick: 'new/fast' } }, { directory: projectDir });
    assert.match(out, /models\.sidekick: "old\/fast" -> "new\/fast"/);
    assert.deepEqual(readJson(file).plugin[0][1].models, { build: 'old/build', sidekick: 'new/fast' });
  });

  test('remove clears the listed overrides and drops an emptied models object', async () => {
    const projectDir = makeProject();
    const file = projectWithEntry(projectDir, {
      options: { profile: 'opencode-go', models: { sidekick: 'a/b', build: 'c/d' } },
    });
    const out = await configure({ remove: ['sidekick', 'build'] }, { directory: projectDir });
    assert.match(out, /models\.sidekick: "a\/b" -> <removed>/);
    assert.match(out, /models\.build: "c\/d" -> <removed>/);
    const options = readJson(file).plugin[0][1];
    assert.deepEqual(options, { profile: 'opencode-go' }, 'empty models object must be dropped entirely');
    assert.ok(!('models' in options));
  });

  test('remove only clears the named roles', async () => {
    const projectDir = makeProject();
    const file = projectWithEntry(projectDir, {
      options: { models: { sidekick: 'a/b', build: 'c/d' } },
    });
    await configure({ remove: ['sidekick'] }, { directory: projectDir });
    assert.deepEqual(readJson(file).plugin[0][1].models, { build: 'c/d' });
  });

  test('audit and claude flags are set and cleared', async () => {
    const projectDir = makeProject();
    const file = projectWithEntry(projectDir);
    let out = await configure({ audit: true, claude: true }, { directory: projectDir });
    assert.match(out, /audit: \(not set\) -> true/);
    assert.match(out, /claude: \(not set\) -> true/);
    assert.deepEqual(readJson(file).plugin[0][1], { audit: true, claude: true });

    out = await configure({ audit: false, claude: false }, { directory: projectDir });
    assert.match(out, /audit: true -> false/);
    assert.deepEqual(readJson(file).plugin[0][1], { audit: false, claude: false });
  });

  test('a no-op invocation reports no changes and does not touch the file', async () => {
    const projectDir = makeProject();
    const file = projectWithEntry(projectDir, { options: { profile: 'chatgpt' } });
    const original = fs.readFileSync(file, 'utf8');
    const out = await configure({ profile: 'chatgpt' }, { directory: projectDir });
    assert.match(out, /No changes needed/);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    assert.ok(!fs.existsSync(`${file}.conductor-backup`), 'no backup for a no-op run');
  });

  test('the backup holds the original bytes and rolls over on each run', async () => {
    const projectDir = makeProject();
    const file = projectWithEntry(projectDir);
    const original = fs.readFileSync(file, 'utf8');

    await configure({ profile: 'chatgpt' }, { directory: projectDir });
    assert.equal(fs.readFileSync(`${file}.conductor-backup`, 'utf8'), original);

    // Second run: the rolling backup now holds the immediately-previous bytes.
    const beforeSecond = fs.readFileSync(file, 'utf8');
    await configure({ audit: true }, { directory: projectDir });
    assert.equal(fs.readFileSync(`${file}.conductor-backup`, 'utf8'), beforeSecond);
  });

  test('the write is atomic: no *.tmp-* litter and the original mode is preserved', async () => {
    const projectDir = makeProject();
    const file = projectWithEntry(projectDir);
    fs.chmodSync(file, 0o640);
    await configure({ profile: 'chatgpt' }, { directory: projectDir });

    const litter = fs.readdirSync(projectDir).filter((name) => name.includes('.tmp-'));
    assert.deepEqual(litter, [], 'no temp files may be left behind');
    assert.equal(fs.statSync(file).mode & 0o777, 0o640, 'original permission mode must be preserved');
    assert.ok(fs.readFileSync(file, 'utf8').endsWith('\n'), 'file must end with a trailing newline');
    assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(readJson(file), null, 2) + '\n');
  });

  test('unrelated config keys are preserved through the rewrite', async () => {
    const projectDir = makeProject();
    const file = path.join(projectDir, 'opencode.json');
    writeJson(file, {
      theme: 'dark',
      model: 'keep/model',
      provider: { x: { y: 1 } },
      agent: { custom: { model: 'm/n' } },
      plugin: [[ENTRY, { profile: 'opencode-go' }]],
    });
    await configure({ profile: 'chatgpt' }, { directory: projectDir });
    const config = readJson(file);
    assert.equal(config.theme, 'dark');
    assert.equal(config.model, 'keep/model');
    assert.deepEqual(config.provider, { x: { y: 1 } });
    assert.deepEqual(config.agent, { custom: { model: 'm/n' } });
    assert.equal(config.plugin.length, 1);
    assert.equal(config.plugin[0][1].profile, 'chatgpt');
  });

  test('other plugin entries in the same array are preserved', async () => {
    const projectDir = makeProject();
    const file = path.join(projectDir, 'opencode.json');
    writeJson(file, {
      plugin: [
        ['another-plugin@3.0.0', { some: 'option' }],
        [ENTRY, {}],
        'plain-plugin',
      ],
    });
    await configure({ audit: true }, { directory: projectDir });
    const config = readJson(file);
    assert.deepEqual(config.plugin, [
      ['another-plugin@3.0.0', { some: 'option' }],
      [ENTRY, { audit: true }],
      'plain-plugin',
    ]);
  });
});

describe('conductor_status report', () => {
  test('reports the config file, raw options, and effective resolution from profile + overrides', async () => {
    const projectDir = makeProject();
    const file = projectWithEntry(projectDir, {
      options: { profile: 'opencode-go', models: { sidekick: 'custom/fast' } },
    });
    const out = await status({ directory: projectDir });
    assert.ok(out.includes(`Config file: ${file}`));
    assert.match(out, /Stored options: \{"profile":"opencode-go","models":\{"sidekick":"custom\/fast"\}\}/);
    assert.match(out, /build: opencode-go\/kimi-k3/, 'unoverridden role comes from the profile');
    assert.match(out, /sidekick: custom\/fast/, 'override wins for its role');
    assert.match(out, /explore: opencode-go\/deepseek-v4-flash/);
    assert.match(out, /plan: unset/, 'roles the profile does not assign stay unset');
    assert.match(out, /reviewer: opencode-go\/grok-4\.5/);
  });

  test('a fresh entry with empty options is reported as unconfigured for setup purposes', async () => {
    const projectDir = makeProject();
    projectWithEntry(projectDir);
    const out = await status({ directory: projectDir });
    assert.ok(
      out.includes(
        'Setup state: unconfigured (no profile, no model overrides - run /conductor with no arguments to set up, or pass arguments directly)'
      ),
      'a fresh entry must carry the unconfigured setup-state line'
    );
  });

  test('a configured entry (profile and/or models) is reported as configured', async () => {
    const profileDir = makeProject();
    projectWithEntry(profileDir, { options: { profile: 'chatgpt' } });
    let out = await status({ directory: profileDir });
    assert.ok(out.includes('Setup state: configured (profile: chatgpt, no model overrides)'));

    const modelsDir = makeProject();
    projectWithEntry(modelsDir, { options: { models: { sidekick: 'custom/fast' } } });
    out = await status({ directory: modelsDir });
    assert.ok(out.includes('Setup state: configured (no profile, 1 model override)'));

    const bothDir = makeProject();
    projectWithEntry(bothDir, {
      options: { profile: 'opencode-go', models: { sidekick: 'custom/fast', explore: 'custom/e' } },
    });
    out = await status({ directory: bothDir });
    assert.ok(out.includes('Setup state: configured (profile: opencode-go, 2 model overrides)'));
  });

  test('audit/claude-only options still count as unconfigured for setup purposes', async () => {
    const projectDir = makeProject();
    projectWithEntry(projectDir, { options: { audit: true, claude: true } });
    const out = await status({ directory: projectDir });
    assert.ok(
      out.includes('Setup state: unconfigured (no profile, no model overrides'),
      'feature flags alone must not flip the setup state to configured'
    );
  });

  test('the report lists every available profile with its assignments', async () => {
    const projectDir = makeProject();
    projectWithEntry(projectDir);
    const out = await status({ directory: projectDir });
    assert.ok(out.includes('Available profiles:'), 'report must carry the Available profiles section');
    for (const [name, profile] of Object.entries(PROFILES)) {
      assert.ok(out.includes(name), `profile "${name}" must be listed`);
      for (const [role, model] of Object.entries(profile.agents)) {
        assert.ok(out.includes(`${role}=${model}`), `"${name}" must list ${role}=${model}`);
      }
      assert.ok(
        out.includes(`small_model=${profile.small_model}`),
        `"${name}" must list its small_model`
      );
    }
  });

  test('reports the pinned version spec on the entry', async () => {
    const projectDir = makeProject();
    const file = projectWithEntry(projectDir, { options: { profile: 'chatgpt' }, version: '1.4.2' });
    const out = await status({ directory: projectDir });
    assert.ok(out.includes(`${ENTRY}@1.4.2 (version pin: 1.4.2)`));

    const unpinnedDir = makeProject();
    projectWithEntry(unpinnedDir);
    const unpinned = await status({ directory: unpinnedDir });
    assert.match(unpinned, /no version pin/);
  });

  test('an unknown stored profile is reported as a warning, not thrown', async () => {
    const projectDir = makeProject();
    projectWithEntry(projectDir, { options: { profile: 'nope', models: { sidekick: 'custom/fast' } } });
    const out = await status({ directory: projectDir });
    assert.match(out, /WARN: Unknown conductor profile "nope"/);
    assert.match(out, /sidekick: custom\/fast/);
    assert.match(out, /build: unset/);
  });

  test('warns on leftover fusion agent files, fusion plugins, and the fusion manifest', async () => {
    delete process.env.XDG_CONFIG_HOME;
    const globalDir = path.join(homeDir, '.config', 'opencode');
    for (const role of ['build', 'plan', 'sidekick']) {
      fs.mkdirSync(path.join(globalDir, 'agent'), { recursive: true });
      fs.writeFileSync(path.join(globalDir, 'agent', `${role}.md`), '# leftover fusion prompt\n');
    }
    fs.mkdirSync(path.join(globalDir, 'plugins'), { recursive: true });
    fs.writeFileSync(path.join(globalDir, 'plugins', 'fusion-audit.js'), 'export const x = 1;\n');
    fs.writeFileSync(path.join(globalDir, 'plugins', 'fusion-claude.js'), 'export const x = 1;\n');
    fs.writeFileSync(path.join(globalDir, '.fusion-install.json'), '{}');
    const globalFile = path.join(globalDir, 'opencode.json');
    writeJson(globalFile, { plugin: [[ENTRY, {}]] });

    const projectDir = makeProject();
    const out = await status({ directory: projectDir });
    assert.ok(out.includes(`Config file: ${globalFile}`));
    assert.match(out, /Leftover file-based agents/);
    assert.ok(out.includes('build.md') && out.includes('plan.md') && out.includes('sidekick.md'));
    assert.match(out, /Old fusion plugin files still installed/);
    assert.ok(out.includes('fusion-audit.js') && out.includes('fusion-claude.js'));
    assert.match(out, /Old fusion install present/);
    assert.match(out, /"undo fusion"/);
  });

  test('tolerates a completely empty environment', async () => {
    const projectDir = makeProject();
    const out = await status({ directory: projectDir });
    assert.match(out, /Conductor status/);
    assert.match(out, /Config file: not found/);
    assert.match(out, /Effective role models:/);
    assert.match(out, /build: unset/);
    assert.match(out, /Migration hazards:/);
    assert.match(out, /none detected/);
  });

  test('reports a .jsonc-only config and never throws on it', async () => {
    const projectDir = makeProject();
    fs.writeFileSync(path.join(projectDir, 'opencode.jsonc'), '{ /* comment */ }');
    const out = await status({ directory: projectDir });
    assert.match(out, /JSONC - cannot be parsed by this tool/);
    assert.match(out, /edit the \.jsonc by hand/i);
  });
});