'use strict';

// Cross-platform launcher for the live Conductor integration tests: sets the
// CONDUCTOR_INTEGRATION gate (env assignment in npm scripts is not portable
// to Windows) and runs every conductor-*.test.js in the integration dir
// against the real opencode binary. Helper modules (fake-provider.js,
// conductor-env.js) are excluded by the conductor-*.test.js naming pattern.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { opencodeBin } = require('../test/integration/conductor-env.js');

const integrationDir = path.join(__dirname, '..', 'test', 'integration');
const testFiles = fs
  .readdirSync(integrationDir)
  .filter((name) => name.startsWith('conductor-') && name.endsWith('.test.js'))
  .map((name) => path.join(integrationDir, name))
  .sort();

if (testFiles.length === 0) {
  process.stderr.write('no conductor-*.test.js files found in test/integration\n');
  process.exit(1);
}

// Same resolver the harness uses, so the probe and the spawned runs can never
// disagree about which binary is under test.
const bin = opencodeBin();
const version = spawnSync(`${bin} --version`, {
  shell: true,
  encoding: 'utf8',
  timeout: 30000,
});
if (version.status !== 0) {
  process.stderr.write(`integration tests require a ${bin} binary on PATH\n`);
  if (version.stderr) process.stderr.write(version.stderr);
  process.exit(1);
}
process.stdout.write(`testing with ${bin} ${version.stdout.trim()}\n`);

const result = spawnSync(process.execPath, ['--test', ...testFiles], {
  stdio: 'inherit',
  env: { ...process.env, CONDUCTOR_INTEGRATION: '1' },
});

process.exit(result.status === null ? 1 : result.status);
