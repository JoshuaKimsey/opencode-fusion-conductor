'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..');
const PROFILES_MODULE = pathToFileURL(path.join(root, 'src', 'profiles.js')).href;
const CONSTANTS_MODULE = pathToFileURL(path.join(root, 'src', 'constants.js')).href;

// The shipped set is public surface; adding or removing a profile must keep
// every consumer (check-profiles, the plugin docs) in step.
const EXPECTED_PROFILES = [
  'chatgpt',
  'github-copilot',
  'opencode-go',
  'opencode-zen',
  'opencode-zen-free',
];

const MODEL_REF = /^[^/\s]+\/\S+$/;

describe('src/profiles.js', () => {
  test('the shipped profile set is exactly the documented one', async () => {
    const { PROFILES } = await import(PROFILES_MODULE);
    assert.deepEqual(Object.keys(PROFILES).sort(), [...EXPECTED_PROFILES].sort());
  });

  test('every profile carries model, small_model, and an agents map', async () => {
    const { PROFILES } = await import(PROFILES_MODULE);
    for (const name of EXPECTED_PROFILES) {
      const profile = PROFILES[name];
      assert.ok(profile, `profile ${name} is missing`);
      assert.equal(typeof profile.model, 'string', `${name}: model must be a string`);
      assert.equal(typeof profile.small_model, 'string', `${name}: small_model must be a string`);
      assert.equal(typeof profile.agents, 'object', `${name}: agents must be an object`);
    }
  });

  test('every agents role is a KNOWN_ROLES role', async () => {
    const [{ PROFILES }, { KNOWN_ROLES }] = await Promise.all([
      import(PROFILES_MODULE),
      import(CONSTANTS_MODULE),
    ]);
    for (const name of EXPECTED_PROFILES) {
      for (const role of Object.keys(PROFILES[name].agents)) {
        assert.ok(KNOWN_ROLES.includes(role), `${name}: agents key "${role}" is not a known role`);
      }
    }
  });

  test('every model value matches the provider/model shape', async () => {
    const { PROFILES } = await import(PROFILES_MODULE);
    for (const name of EXPECTED_PROFILES) {
      const profile = PROFILES[name];
      const refs = [profile.model, profile.small_model, ...Object.values(profile.agents)];
      for (const ref of refs) {
        assert.match(ref, MODEL_REF, `${name}: malformed model reference "${ref}" (expected provider/model-id)`);
      }
    }
  });

  test('every profile assigns at least build and sidekick', async () => {
    const { PROFILES } = await import(PROFILES_MODULE);
    for (const name of EXPECTED_PROFILES) {
      assert.ok(PROFILES[name].agents.build, `${name}: agents must include build`);
      assert.ok(PROFILES[name].agents.sidekick, `${name}: agents must include sidekick`);
    }
  });
});
