'use strict';

// Cross-surface consistency for the Conductor rewrite. The plugin was forked
// and rebranded from opencode-fusion, and the docs/site carry the promise that
// the rebrand is complete: a stale `mihneaptu` URL or a leftover `npx skills
// add` install instruction on the marketing site would be a user-facing lie.
// These tests pin the surfaces to the code (package version, profile names,
// role names) and to each other, so a prose change that silently re-breaks the
// rebrand fails the suite.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const readme = read('README.md');
const sitePages = ['index.html', 'docs.html', 'llms.txt'].map((name) => ({
  name,
  text: read(path.join('site', name)),
}));

const PROFILES_MODULE = pathToFileURL(path.join(root, 'src', 'profiles.js')).href;
const CONSTANTS_MODULE = pathToFileURL(path.join(root, 'src', 'constants.js')).href;

describe('docs consistency', () => {
  test('README names the exact package/version that package.json ships', () => {
    const { name, version } = require(path.join(root, 'package.json'));
    assert.equal(name, 'opencode-fusion-conductor');
    assert.ok(
      readme.includes(`opencode-fusion-conductor@${version}`),
      `README must carry the install snippet "opencode-fusion-conductor@${version}"`
    );
  });

  test('every shipped profile appears in the README', async () => {
    const { PROFILES } = await import(PROFILES_MODULE);
    assert.ok(Object.keys(PROFILES).length >= 1, 'profiles.js must export at least one profile');
    for (const name of Object.keys(PROFILES)) {
      assert.ok(
        readme.includes(name),
        `README must mention the shipped profile "${name}"`
      );
    }
  });

  test('every known role appears in the README configuration section', async () => {
    const { KNOWN_ROLES } = await import(CONSTANTS_MODULE);
    assert.ok(KNOWN_ROLES.length >= 1, 'constants.js must export at least one known role');
    const configuration = readme.slice(readme.indexOf('## Configuration'));
    for (const role of KNOWN_ROLES) {
      assert.ok(
        configuration.includes(`\`${role}\``),
        `the README configuration section must name the role "${role}"`
      );
    }
  });

  test('README documents the restart caveat for model changes', () => {
    assert.match(
      readme,
      /restart/i,
      'README must discuss restarting opencode for changes to take effect'
    );
    assert.match(
      readme,
      /agent registry/i,
      'README must state the agent-registry materialization that makes restarts required'
    );
  });

  test('README documents the audit and claude options', () => {
    assert.match(readme, /\| `audit` \|/, 'README must document the audit option');
    assert.match(readme, /\| `claude` \|/, 'README must document the claude option');
    assert.match(
      readme,
      /conductor_claude_status/,
      'README must name the Claude bridge tools'
    );
  });

  test('README documents the version-pinned force-update command', () => {
    assert.ok(
      readme.includes('opencode plugin opencode-fusion-conductor@1.0.2 -g -f'),
      'README must carry the version-pinned force-update command "opencode plugin opencode-fusion-conductor@1.0.2 -g -f"'
    );
  });

  test('README keeps the upstream attribution', () => {
    assert.match(readme, /opencode-fusion/, 'README must credit the opencode-fusion fork');
    assert.match(readme, /mihneaptu/, 'README must keep the upstream author attribution');
    assert.match(readme, /Devin Fusion/, 'README must keep the Devin Fusion pattern credit');
  });

  for (const { name, text } of sitePages) {
    describe(`site/${name}`, () => {
      test('is rebranded: carries the new repo/pages identity', () => {
        assert.ok(
          text.includes('joshuakimsey.github.io/opencode-fusion-conductor') ||
          text.includes('github.com/JoshuaKimsey/opencode-fusion-conductor'),
          `site/${name} must reference the Conductor pages or repo URL`
        );
      });

      test('has no leftover upstream pages or skill-install instructions', () => {
        assert.ok(
          !text.includes('mihneaptu.github.io'),
          `site/${name} must not reference the old mihneaptu pages site`
        );
        assert.ok(
          !text.includes('npx skills add'),
          `site/${name} must not carry the old npx skills add install instruction`
        );
      });
    });
  }

  test('site/script.js reads star counts from the Conductor repo', () => {
    const script = read(path.join('site', 'script.js'));
    assert.ok(
      script.includes('https://api.github.com/repos/JoshuaKimsey/opencode-fusion-conductor'),
      'site/script.js must fetch star counts from the JoshuaKimsey/opencode-fusion-conductor repo'
    );
  });

  test('site/index.html and site/docs.html install snippet match the README', () => {
    const { version } = require(path.join(root, 'package.json'));
    for (const name of ['index.html', 'docs.html']) {
      const text = read(path.join('site', name));
      assert.ok(
        text.includes(`opencode-fusion-conductor@${version}`),
        `site/${name} must carry the install snippet "opencode-fusion-conductor@${version}"`
      );
    }
  });
});