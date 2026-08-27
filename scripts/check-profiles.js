#!/usr/bin/env node
'use strict';

// Live check that every model id shipped in src/profiles.js still exists on
// models.dev - the registry opencode resolves built-in providers against.
// Network-dependent by design: runs via `npm run check-profiles` and in the
// integration CI lane, never as part of the offline `npm test`.
//
// Errors (exit 1): a profile names a provider or model id the registry does
// not know - that profile would install a config opencode cannot serve.
// Warnings (exit 0): image-input mismatches - worth a look when refreshing a
// profile, not worth blocking on.
//
// Usage: node scripts/check-profiles.js [--api <url>]

const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..');

function apiUrl(argv) {
  const index = argv.indexOf('--api');
  if (index === -1) return 'https://models.dev/api.json';
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error('--api requires a URL value');
  return value;
}

// A model reference is "provider/model-id". Profiles are hand-authored, so a
// malformed one must surface as a clear error, not mangled slicing.
function splitRef(ref) {
  const slash = ref.indexOf('/');
  if (slash < 1 || slash === ref.length - 1) return null;
  return [ref.slice(0, slash), ref.slice(slash + 1)];
}

// Every provider/model pair a profile relies on: the top-level model and
// small_model plus the per-role agents map.
function modelRefs(profile) {
  const refs = new Set();
  for (const value of [profile.model, profile.small_model]) {
    if (typeof value === 'string') refs.add(value);
  }
  for (const spec of Object.values(profile.agents || {})) {
    if (typeof spec === 'string') refs.add(spec);
  }
  return [...refs].sort();
}

function readsImages(entry) {
  return Boolean(entry.attachment) || (entry.modalities?.input || []).includes('image');
}

async function main() {
  const response = await fetch(apiUrl(process.argv));
  if (!response.ok) throw new Error(`models.dev fetch failed: HTTP ${response.status}`);
  const registry = await response.json();

  const { PROFILES } = await import(pathToFileURL(path.join(root, 'src', 'profiles.js')).href);
  const names = Object.keys(PROFILES).sort();
  if (names.length === 0) throw new Error('no profiles found in src/profiles.js');

  let errors = 0;
  let warnings = 0;

  for (const name of names) {
    const profile = PROFILES[name];
    const issues = [];

    for (const ref of modelRefs(profile)) {
      const parts = splitRef(ref);
      if (!parts) {
        issues.push({ level: 'error', text: `invalid model reference "${ref}" (expected provider/model-id)` });
        continue;
      }
      const [providerId, modelId] = parts;
      const provider = registry[providerId];
      if (!provider) {
        issues.push({ level: 'error', text: `provider "${providerId}" is not on models.dev` });
        continue;
      }
      const entry = (provider.models || {})[modelId];
      if (!entry) {
        issues.push({ level: 'error', text: `${ref} is not on models.dev` });
        continue;
      }
    }

    const registryEntry = (ref) => {
      const parts = splitRef(ref);
      return parts ? registry[parts[0]]?.models?.[parts[1]] : undefined;
    };
    const visionModel = profile.agents?.vision;
    const visionEntry = visionModel && registryEntry(visionModel);
    if (visionEntry && !readsImages(visionEntry)) {
      issues.push({ level: 'warn', text: `vision model ${visionModel} does not accept image input` });
    }
    const buildModel = profile.agents?.build;
    const buildEntry = buildModel && registryEntry(buildModel);
    if (buildEntry && !readsImages(buildEntry) && !visionModel) {
      issues.push({ level: 'warn', text: `build model ${buildModel} lacks image input and the profile has no vision role` });
    }

    if (issues.length === 0) {
      console.log(`ok    ${name} (${modelRefs(profile).length} model refs)`);
    } else {
      for (const issue of issues) {
        console.log(`${issue.level === 'error' ? 'ERROR' : 'warn '} ${name}: ${issue.text}`);
        if (issue.level === 'error') errors++;
        else warnings++;
      }
    }
  }

  console.log(`\n${names.length} profile(s) checked: ${errors} error(s), ${warnings} warning(s)`);
  if (errors > 0) process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(`check-profiles: ${err.message}\n`);
  process.exitCode = 1;
});
