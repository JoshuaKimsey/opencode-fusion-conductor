'use strict';

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..');

let mods;
before(async () => {
  const load = (name) => import(pathToFileURL(path.join(root, 'src', name)).href);
  const [agents, profiles, config, commands] = await Promise.all([
    load('agents.js'),
    load('profiles.js'),
    load('config.js'),
    load('commands.js'),
  ]);
  mods = {
    AGENTS: agents.AGENTS,
    PROFILES: profiles.PROFILES,
    applyConductor: config.applyConductor,
    COMMANDS: commands.COMMANDS,
  };
});

// mods is populated by the before() hook above; tests run after it resolves.
const applyConductor = (...args) => mods.applyConductor(...args);

// --- hand-rolled pattern matchers (ported from contracts.test.js) -------------

function wildcardMatches(pattern, command) {
  const normalizedPattern = pattern.replaceAll('\\', '/');
  const normalizedCommand = command.replaceAll('\\', '/');
  let source = normalizedPattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  if (source.endsWith(' .*')) {
    source = source.slice(0, -3) + '( .*)?';
  }
  // Case-sensitive on every platform, mirroring the source contracts.
  return new RegExp(`^${source}$`, 's').test(normalizedCommand);
}

// Last-match-wins over insertion-ordered entries.
function resolveBashRule(bashMap, command) {
  return Object.entries(bashMap).reduce(
    (decision, [pattern, value]) => (wildcardMatches(pattern, command) ? value : decision),
    undefined
  );
}

// The exact key order the build bash map must keep (YAML source order).
const BUILD_BASH_KEYS = [
  '*',
  'npm run lint*',
  'npm test*',
  'npm run build*',
  'npx tsc --noEmit*',
  'npx vitest run*',
  'git diff*',
  'git status*',
  'git log*',
  'git show*',
  'git add*',
  'git commit*',
  'git push*',
  'git push --force*',
  'git push -f*',
  'git push -uf*',
  'git push -fu*',
  'git push * --force*',
  'git push * -f*',
  'git push * -uf*',
  'git push * -fu*',
  'git push --mir*',
  'git push * --mir*',
  'git push --delete*',
  'git push * --delete*',
  'git push -d*',
  'git push * -d*',
  'git push --prune*',
  'git push * --prune*',
  'git push * :*',
  'git push * +*',
  'node --version*',
  'npm --version*',
  'git diff --output*',
  'git diff *--output*',
  'git log --output*',
  'git log *--output*',
  'git show --output*',
  'git show *--output*',
  'git log -p*',
  'git log -u*',
  'git log --patch*',
  'git log * -p*',
  'git log * -u*',
  'git log *--patch*',
  'npm run lint *--fix*',
  'npm test * -u*',
  'npm test *--update*',
  'npx vitest run -u*',
  'npx vitest run --update*',
  'npx vitest run * -u*',
  'npx vitest run *--update*',
  'npx tsc --noEmitOnError*',
];

const ROLES = ['build', 'plan', 'sidekick', 'research', 'design', 'reviewer', 'vision'];

const TASK_MAPS = {
  build: ['sidekick', 'explore', 'research', 'design', 'reviewer', 'vision'],
  plan: ['explore', 'research', 'reviewer'],
  sidekick: ['explore', 'research'],
  design: ['explore', 'research'],
  research: ['explore'],
  reviewer: ['explore'],
};

describe('AGENTS ported from agent/*.md', () => {
  test('AGENTS holds exactly the seven reviewed roles and no model fields', () => {
    assert.deepEqual(Object.keys(mods.AGENTS).sort(), [...ROLES].sort());
    for (const role of ROLES) {
      const agent = mods.AGENTS[role];
      assert.equal(typeof agent.description, 'string', `${role} missing description`);
      assert.equal(typeof agent.prompt, 'string', `${role} missing prompt`);
      assert.equal(typeof agent.permission, 'object', `${role} missing permission`);
      assert.ok(!('model' in agent), `${role} must not carry a model field (models come from profiles/options)`);
    }
  });

  test('rename is complete: no bare Fusion and no fusion_/fusion- identifiers remain', () => {
    for (const role of ROLES) {
      const text = `${mods.AGENTS[role].prompt} ${mods.AGENTS[role].description}`;
      for (const match of text.matchAll(/Fusion/g)) {
        assert.ok(
          text.slice(Math.max(0, match.index - 6), match.index) === 'Devin ',
          `${role} still uses bare "Fusion" (only "Devin Fusion" attribution is kept)`
        );
      }
      assert.ok(!/fusion_/.test(text), `${role} keeps a fusion_ identifier`);
      assert.ok(!/fusion-/.test(text), `${role} keeps a fusion- identifier`);
    }
    // The renamed identifiers must be the ones the plugin surface uses.
    assert.equal(mods.AGENTS.build.permission.conductor_claude_status, 'allow');
    assert.equal(mods.AGENTS.build.permission.conductor_claude_review, 'allow');
    assert.ok(mods.AGENTS.build.prompt.includes('`conductor_claude_review`'));
  });

  test('build denies edit, grep, glob, and list', () => {
    for (const key of ['edit', 'grep', 'glob', 'list']) {
      assert.equal(mods.AGENTS.build.permission[key], 'deny');
    }
  });

  test('research and reviewer have edit: deny', () => {
    for (const role of ['research', 'reviewer']) {
      assert.equal(mods.AGENTS[role].permission.edit, 'deny');
    }
  });

  test('vision is hidden and fully locked down', () => {
    const vision = mods.AGENTS.vision;
    assert.equal(vision.hidden, true);
    assert.equal(vision.permission.read, 'allow');
    assert.equal(vision.permission.edit, 'deny');
    assert.equal(vision.permission.bash, 'deny');
    assert.equal(vision.permission.task, 'deny');
  });

  test('build prompt still carries the discipline contracts', () => {
    const body = mods.AGENTS.build.prompt;
    const lower = body.toLowerCase();
    const parts = ['objective', 'files', 'interfaces', 'constraints', 'verification'];
    for (const part of parts) {
      assert.ok(lower.includes(part), `build prompt missing spec contract part: ${part}`);
    }
    assert.ok(body.includes('task_id'), 'build prompt must keep resumable task_id handling');
    assert.ok(lower.includes('least-allowed segment'), 'build prompt must explain chaining the corrected way');
    assert.ok(lower.includes('pipe'), 'build prompt must keep the pipe case');
    for (const claim of ['matches no pattern', 'blocks the entire line', 'blocks the whole line']) {
      assert.ok(!lower.includes(claim), `build prompt restates the disproven chaining claim: ${claim}`);
    }
    assert.ok(body.includes('Devin Fusion'), 'build prompt must keep the Devin Fusion attribution');
  });

  test('the raw AGENTS constant does not yet wire the conductor tools', () => {
    // The wiring happens at injection time (applyConductor) so the shared
    // constant stays a clean port.
    for (const role of ROLES) {
      assert.ok(!('conductor_configure' in mods.AGENTS[role].permission), `${role} must not bake conductor_configure into AGENTS`);
      assert.ok(!('conductor_status' in mods.AGENTS[role].permission), `${role} must not bake conductor_status into AGENTS`);
    }
  });
});

describe('applyConductor injection', () => {
  test('injects exactly the seven agents plus the conductor command', () => {
    const config = applyConductor({});
    assert.deepEqual(Object.keys(config.agent).sort(), [...ROLES].sort());
    assert.deepEqual(Object.keys(config.command), ['conductor']);
    assert.equal(config.command.conductor, mods.COMMANDS.conductor);
    assert.equal(typeof config.command.conductor.description, 'string');
    assert.equal(typeof config.command.conductor.template, 'string');
    assert.ok(config.command.conductor.template.includes('$ARGUMENTS'));
  });

  test('the /conductor template drives status, configure, and the setup interview', () => {
    const template = mods.COMMANDS.conductor.template;
    assert.ok(template.includes('conductor_status'), 'template must call conductor_status first');
    assert.ok(template.includes('conductor_configure'), 'template must drive conductor_configure');
    assert.ok(
      template.includes('Restart opencode for changes to take effect.'),
      'template must keep the restart reminder'
    );
    assert.ok(template.includes('Setup state'), 'template must branch on the status Setup state line');
    assert.ok(template.includes('UNCONFIGURED'), 'template must branch on the unconfigured state');
    assert.ok(template.includes('SETUP INTERVIEW'), 'template must name the setup interview branch');
    assert.ok(
      template.includes('Available profiles'),
      'template must source the profile list from the status report'
    );
    assert.ok(
      template.includes('none of these - I\'ll pick models per role'),
      'template must offer the pick-models-per-role escape hatch'
    );
  });

  test('build denies edit, grep, glob, and list in the injected config', () => {
    const permission = applyConductor({}).agent.build.permission;
    for (const key of ['edit', 'grep', 'glob', 'list']) {
      assert.equal(permission[key], 'deny');
    }
  });

  test('injected bash maps keep their source wildcard-first key order', () => {
    const config = applyConductor({});
    // Deny-by-default maps lead with "*": "deny".
    for (const role of ['build', 'plan', 'reviewer']) {
      const bash = config.agent[role].permission.bash;
      assert.equal(typeof bash, 'object', `${role} bash must be a rule map`);
      const keys = Object.keys(bash);
      assert.equal(keys[0], '*', `${role} bash wildcard deny must appear first`);
      assert.equal(bash['*'], 'deny');
    }
    // Allow-by-default executors lead with "*": "allow" (source contract).
    for (const role of ['sidekick', 'design']) {
      const bash = config.agent[role].permission.bash;
      assert.equal(typeof bash, 'object', `${role} bash must be a rule map`);
      const keys = Object.keys(bash);
      assert.equal(keys[0], '*', `${role} bash wildcard must appear first`);
      assert.equal(bash['*'], 'allow');
    }
    for (const role of ['research', 'vision']) {
      assert.equal(config.agent[role].permission.bash, 'deny', `${role} bash must be a full deny`);
    }
  });

  test('task maps are wildcard deny plus exact named allows', () => {
    const config = applyConductor({});
    for (const [role, allows] of Object.entries(TASK_MAPS)) {
      const task = config.agent[role].permission.task;
      const keys = Object.keys(task);
      assert.equal(keys[0], '*', `${role} task wildcard deny must appear first`);
      assert.equal(task['*'], 'deny');
      assert.deepEqual(keys.filter((k) => k !== '*').sort(), [...allows].sort(), `${role} task allows mismatch`);
      for (const name of keys) {
        if (name !== '*') assert.equal(task[name], 'allow', `${role} task.${name} must be allow`);
      }
    }
    assert.equal(config.agent.vision.permission.task, 'deny');
  });

  test('executors deny git commit and git push entirely', () => {
    const config = applyConductor({});
    for (const role of ['sidekick', 'design']) {
      const bash = config.agent[role].permission.bash;
      for (const command of [
        'git commit -m change',
        'git -C . commit -m change',
        'git --git-dir .git push origin main',
        'env git push origin main',
        'git.exe commit -m change',
        'git.exe push origin main',
        'git.exe -C . commit -m change',
      ]) {
        assert.equal(resolveBashRule(bash, command), 'deny', `${role} must deny ${command}`);
      }
    }
  });

  test('sidekick and design share an identical bash guard map', () => {
    const rulesOf = (role) => Object.entries(applyConductor({}).agent[role].permission.bash);
    assert.deepEqual(rulesOf('design'), rulesOf('sidekick'));
  });

  test('build asks on commit/push and denies dangerous push variants after the push ask', () => {
    const bash = applyConductor({}).agent.build.permission.bash;
    assert.equal(bash['git add*'], 'allow');
    assert.equal(bash['git commit*'], 'ask');
    assert.equal(bash['git push*'], 'ask');
    for (const command of [
      'git push origin feature',
      'git push origin feature--force',
      'git push origin feature--mirror',
      'git push origin feature--delete',
      'git push origin feature--prune',
    ]) {
      assert.equal(resolveBashRule(bash, command), 'ask', `an ordinary push must ask: ${command}`);
    }
    for (const command of [
      'git push --force origin main',
      'git push -f origin main',
      'git push -uf origin main',
      'git push -d origin retired',
      'git push --delete origin retired',
      'git push --prune origin',
      'git push origin --prune',
      'git push --mir origin',
      'git push origin --mir',
      'git push origin :retired',
      'git push origin +main',
    ]) {
      assert.equal(resolveBashRule(bash, command), 'deny', `dangerous push must be denied: ${command}`);
    }
    // last-match-wins: every git push deny must sit after the broad "git push*" ask.
    const keys = Object.keys(bash);
    const pushAsk = keys.indexOf('git push*');
    const pushDenies = keys.filter((k) => bash[k] === 'deny' && k.startsWith('git push'));
    assert.ok(pushDenies.length >= 4, 'build bash must keep the dangerous-push denylist');
    for (const deny of pushDenies) {
      assert.ok(keys.indexOf(deny) > pushAsk, `${deny} must appear after "git push*" (last-match-wins)`);
    }
  });

  test('design is fenced to the workspace and can load the skill its prompt requires', () => {
    const design = applyConductor({}).agent.design;
    assert.equal(design.permission.external_directory, 'deny');
    assert.equal(design.permission.skill, 'allow');
    for (const role of ROLES.filter((r) => r !== 'design')) {
      assert.ok(!('skill' in applyConductor({}).agent[role].permission), `${role} must not grant the skill permission`);
    }
  });

  test('vision bash stays fully denied in the injected config', () => {
    assert.equal(applyConductor({}).agent.vision.permission.bash, 'deny');
  });

  test('build bash key order is preserved exactly', () => {
    assert.deepEqual(Object.keys(applyConductor({}).agent.build.permission.bash), BUILD_BASH_KEYS);
  });

  test('read-only verification allowlists still deny file-writing argument forms', () => {
    const config = applyConductor({});
    for (const role of ['build', 'plan', 'reviewer']) {
      const bash = config.agent[role].permission.bash;
      for (const command of [
        'git diff --output=hijack.txt',
        'git diff HEAD~1 --output=hijack.txt',
        'git log --output=hijack.txt',
        'git show HEAD --output=hijack.txt',
        'npm run lint -- --fix',
        'npm test -- -u',
        'npm test -- --update-snapshots',
        'npx vitest run -u',
        'npx vitest run --update',
        'npx vitest run src/app.test.ts -u',
      ]) {
        assert.equal(resolveBashRule(bash, command), 'deny', `${role} must deny the file-writing form: ${command}`);
      }
      for (const command of ['git diff', 'git log --oneline', 'npm run lint', 'npm test', 'npx vitest run']) {
        assert.equal(resolveBashRule(bash, command), 'allow', `${role} must still allow the read-only form: ${command}`);
      }
    }
  });

  test('conductor_configure and conductor_status are allowed only for build and plan', () => {
    const config = applyConductor({});
    for (const role of ['build', 'plan']) {
      assert.equal(config.agent[role].permission.conductor_configure, 'allow', `${role} must allow conductor_configure`);
      assert.equal(config.agent[role].permission.conductor_status, 'allow', `${role} must allow conductor_status`);
    }
    for (const role of ['sidekick', 'research', 'design', 'reviewer', 'vision']) {
      assert.equal(config.agent[role].permission.conductor_configure, 'deny', `${role} must deny conductor_configure`);
      assert.equal(config.agent[role].permission.conductor_status, 'deny', `${role} must deny conductor_status`);
    }
  });

  test('the conductor tool permissions are tool-level, unshadowed, and placed before bash', () => {
    const config = applyConductor({});
    for (const role of ROLES) {
      const permission = config.agent[role].permission;
      const keys = Object.keys(permission);
      // Tool-level keys: never inside the bash or task maps.
      for (const nested of ['bash', 'task']) {
        const value = permission[nested];
        if (value && typeof value === 'object') {
          assert.ok(!('conductor_configure' in value), `${role} conductor_configure must not live in ${nested}`);
          assert.ok(!('conductor_status' in value), `${role} conductor_status must not live in ${nested}`);
        }
      }
      // No top-level wildcard exists to shadow them, and they precede the bash
      // map so a later generic rule cannot win.
      assert.ok(!keys.includes('*'), `${role} permission must not add a top-level wildcard`);
      assert.ok(
        keys.indexOf('conductor_configure') < keys.indexOf('conductor_status'),
        `${role} conductor_configure must precede conductor_status`
      );
      if (permission.bash && typeof permission.bash === 'object') {
        assert.ok(
          keys.indexOf('conductor_configure') < keys.indexOf('bash'),
          `${role} conductor tool permissions must be placed before the bash map`
        );
      }
    }
  });

  test('repeated application does not mutate the shared AGENTS definitions', () => {
    const first = applyConductor({});
    const second = applyConductor({});
    for (const role of ROLES) {
      assert.equal(
        Object.keys(second.agent[role].permission).length,
        Object.keys(first.agent[role].permission).length,
        `${role} permission must not accumulate keys across calls`
      );
      assert.ok(!('conductor_configure' in mods.AGENTS[role].permission));
    }
  });
});

describe('profile and model resolution', () => {
  test('each profile resolves its models onto the correct agents', () => {
    for (const [name, profile] of Object.entries(mods.PROFILES)) {
      const config = applyConductor({}, { profile: name });
      for (const [role, model] of Object.entries(profile.agents)) {
        if (role === 'explore') {
          assert.deepEqual(config.agent.explore, { model }, `${name}: explore must get only { model }`);
        } else {
          assert.equal(config.agent[role].model, model, `${name}/${role} model mismatch`);
        }
      }
      assert.equal(config.model, profile.model, `${name}: config.model must be the profile build model`);
      assert.equal(config.small_model, profile.small_model, `${name}: config.small_model mismatch`);
    }
  });

  test('roles the profile does not assign get no model key', () => {
    const config = applyConductor({}, { profile: 'chatgpt' });
    for (const role of ['plan', 'design', 'vision']) {
      assert.ok(!('model' in config.agent[role]), `chatgpt must not assign ${role}`);
    }
  });

  test('options.models overrides the profile per role', () => {
    const config = applyConductor({}, {
      profile: 'opencode-go',
      models: { sidekick: 'custom/fast', explore: 'custom/explore' },
    });
    assert.equal(config.agent.sidekick.model, 'custom/fast');
    assert.deepEqual(config.agent.explore, { model: 'custom/explore' });
    // Roles without an override still come from the profile.
    assert.equal(config.agent.build.model, 'opencode-go/kimi-k3');
    assert.equal(config.agent.design.model, 'opencode-go/qwen3.8-max');
    assert.equal(config.agent.reviewer.model, 'opencode-go/glm-5.3-flash');
    assert.equal(config.model, 'opencode-go/kimi-k3');
    assert.equal(config.small_model, 'opencode-go/deepseek-v4-flash');
  });

  test('options.models work without a profile', () => {
    const config = applyConductor({}, { models: { build: 'custom/build', sidekick: 'custom/fast', explore: 'custom/explore' } });
    assert.equal(config.agent.build.model, 'custom/build');
    assert.equal(config.agent.sidekick.model, 'custom/fast');
    assert.deepEqual(config.agent.explore, { model: 'custom/explore' });
    assert.equal(config.model, 'custom/build');
    assert.ok(!('small_model' in config), 'small_model must only come from a profile');
    for (const role of ['plan', 'research', 'design', 'reviewer', 'vision']) {
      assert.ok(!('model' in config.agent[role]), `${role} must not get a model from unrelated options`);
    }
  });

  test('unknown profile throws and names the available profiles', () => {
    assert.throws(
      () => applyConductor({}, { profile: 'nope' }),
      (err) => {
        assert.match(err.message, /Unknown conductor profile "nope"/);
        for (const name of Object.keys(mods.PROFILES)) {
          assert.ok(err.message.includes(name), `error must name available profile ${name}`);
        }
        return true;
      }
    );
  });

  test('subagent_depth floors at 2', () => {
    assert.equal(applyConductor({}).subagent_depth, 2);
    assert.equal(applyConductor({ subagent_depth: 0 }).subagent_depth, 2);
    assert.equal(applyConductor({ subagent_depth: 1 }).subagent_depth, 2);
    assert.equal(applyConductor({ subagent_depth: 3 }).subagent_depth, 3);
  });

  test('with no profile and no models, agents get no model key and explore stays untouched', () => {
    const config = applyConductor({});
    for (const role of ROLES) {
      assert.ok(!('model' in config.agent[role]), `${role} must not get a model key`);
    }
    assert.ok(!('explore' in config.agent), 'explore must not be injected without a resolved model');
    assert.ok(!('model' in config), 'config.model must not be set without a build model');
    assert.ok(!('small_model' in config), 'config.small_model must not be set without a profile');
  });

  test('explore gets only { model } and only when a model resolves for it', () => {
    const withExplore = applyConductor({}, { models: { explore: 'x/explore' } });
    assert.deepEqual(withExplore.agent.explore, { model: 'x/explore' });
    const withoutExplore = applyConductor({}, { models: { build: 'x/build' } });
    assert.ok(!('explore' in withoutExplore.agent));
  });

  test('config.model and small_model come only from resolved profile data', () => {
    const fromModels = applyConductor({}, { models: { build: 'custom/build' } });
    assert.equal(fromModels.model, 'custom/build');
    assert.ok(!('small_model' in fromModels));
    const fromProfile = applyConductor({}, { profile: 'chatgpt' });
    assert.equal(fromProfile.model, 'openai/gpt-5.6-sol');
    assert.equal(fromProfile.small_model, 'openai/gpt-5.6-luna');
  });
});