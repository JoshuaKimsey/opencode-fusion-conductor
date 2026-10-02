'use strict';

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..');

let mods;
before(async () => {
  const load = (name) => import(pathToFileURL(path.join(root, 'src', name)).href);
  const [agents, profiles, config, commands, permissions, resolve] = await Promise.all([
    load('agents.js'),
    load('profiles.js'),
    load('config.js'),
    load('commands.js'),
    load('permissions.js'),
    load('resolve.js'),
  ]);
  mods = {
    AGENTS: agents.AGENTS,
    PROFILES: profiles.PROFILES,
    resolveAgentDefinitions: config.resolveAgentDefinitions,
    registerConductor: config.registerConductor,
    ROLES: config.ROLES,
    COMMANDS: commands.COMMANDS,
    toPermissions: permissions.toPermissions,
    parseModelRef: resolve.parseModelRef,
  };
});

// mods is populated by the before() hook above; tests run after it resolves.
const resolveAgentDefinitions = (...args) => mods.resolveAgentDefinitions(...args);

// --- hand-rolled pattern matchers -------------------------------------------
// V2 evaluates ordered permission rules last-match-wins. `*` spans `/`,
// `?` is one char, and a shell pattern ending in " *" also matches the bare
// command (mirrors the documented V2 matching).

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
  return new RegExp(`^${source}$`, 's').test(normalizedCommand);
}

// Last-match-wins over the ordered rule array, filtered to one action.
function resolveRule(rules, action, resource) {
  let decision;
  for (const rule of rules) {
    if (rule.action === action && wildcardMatches(rule.resource, resource)) {
      decision = rule.effect;
    }
  }
  return decision;
}

// The exact rule order the build shell allowlist must keep.
const BUILD_SHELL_RESOURCES = [
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

const SUBAGENT_MAPS = {
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
      assert.equal(typeof agent.system, 'string', `${role} missing system prompt`);
      assert.equal(typeof agent.permission, 'object', `${role} missing permission map`);
      assert.ok(!('model' in agent), `${role} must not carry a model field (models come from profiles/options)`);
    }
  });

  test('rename is complete: no bare Fusion and no fusion_/fusion- identifiers remain', () => {
    for (const role of ROLES) {
      const text = `${mods.AGENTS[role].system} ${mods.AGENTS[role].description}`;
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
    assert.ok(mods.AGENTS.build.system.includes('`conductor_claude_review`'));
  });

  test('V2 tool names are used in the prompts: subagent, not task; shell, not bash', () => {
    for (const role of ROLES) {
      const text = `${mods.AGENTS[role].system} ${mods.AGENTS[role].description}`;
      assert.ok(!/\\`task\\`/.test(text.replace(/`subagent`/g, '')), `${role} still names the V1 task tool`);
    }
    assert.ok(mods.AGENTS.build.system.includes('`subagent`'), 'build must delegate via the subagent tool');
    assert.ok(mods.AGENTS.build.system.includes('`shell`'), 'build must name the shell tool');
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

  test('build system prompt still carries the discipline contracts', () => {
    const body = mods.AGENTS.build.system;
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
    // The wiring happens at injection time (resolveAgentDefinitions) so the
    // shared constant stays a clean port.
    for (const role of ROLES) {
      assert.ok(!('conductor_configure' in mods.AGENTS[role].permission), `${role} must not bake conductor_configure into AGENTS`);
      assert.ok(!('conductor_status' in mods.AGENTS[role].permission), `${role} must not bake conductor_status into AGENTS`);
    }
  });
});

describe('toPermissions V1-map to V2-array conversion', () => {
  test('scalar tool keys become action rules with resource "*"', () => {
    const rules = mods.toPermissions({ edit: 'deny', grep: 'deny', webfetch: 'allow' }, 'deny');
    assert.deepEqual(rules.slice(0, 3), [
      { action: 'edit', resource: '*', effect: 'deny' },
      { action: 'grep', resource: '*', effect: 'deny' },
      { action: 'webfetch', resource: '*', effect: 'allow' },
    ]);
  });

  test('bash maps become ordered shell rules and task maps become subagent rules', () => {
    const rules = mods.toPermissions({ bash: { '*': 'deny', 'git status*': 'allow' }, task: { '*': 'deny', sidekick: 'allow' } }, 'allow');
    assert.deepEqual(rules.filter((r) => r.action === 'shell'), [
      { action: 'shell', resource: '*', effect: 'deny' },
      { action: 'shell', resource: 'git status*', effect: 'allow' },
    ]);
    assert.deepEqual(rules.filter((r) => r.action === 'subagent'), [
      { action: 'subagent', resource: '*', effect: 'deny' },
      { action: 'subagent', resource: 'sidekick', effect: 'allow' },
    ]);
  });

  test('deny-all bash/task strings become single deny-all rules', () => {
    const rules = mods.toPermissions({ bash: 'deny', task: 'deny' }, 'deny');
    assert.deepEqual(rules.slice(0, 2), [
      { action: 'shell', resource: '*', effect: 'deny' },
      { action: 'subagent', resource: '*', effect: 'deny' },
    ]);
  });

  test('conductor tool rules are appended with the given effect', () => {
    const rules = mods.toPermissions({ edit: 'deny' }, 'allow');
    assert.deepEqual(rules.slice(-2), [
      { action: 'conductor_configure', resource: '*', effect: 'allow' },
      { action: 'conductor_status', resource: '*', effect: 'allow' },
    ]);
    const denied = mods.toPermissions({ edit: 'allow' }, 'deny');
    assert.deepEqual(denied.slice(-2), [
      { action: 'conductor_configure', resource: '*', effect: 'deny' },
      { action: 'conductor_status', resource: '*', effect: 'deny' },
    ]);
  });
});

describe('parseModelRef', () => {
  test('parses provider/model and provider/model#variant', () => {
    assert.deepEqual(mods.parseModelRef('opencode-go/kimi-k3'), { providerID: 'opencode-go', id: 'kimi-k3' });
    assert.deepEqual(mods.parseModelRef('anthropic/claude-sonnet-4-5#high'), {
      providerID: 'anthropic', id: 'claude-sonnet-4-5', variant: 'high',
    });
  });

  test('refuses malformed references', () => {
    for (const bad of ['nope', '/x', 'x/', 'a b/c', '']) {
      assert.throws(() => mods.parseModelRef(bad), /provider\/model-id/);
    }
  });
});

describe('resolveAgentDefinitions', () => {
  test('resolves exactly the seven agents with V2 system/permissions fields', () => {
    const { defs } = resolveAgentDefinitions({});
    assert.deepEqual(Object.keys(defs).sort(), [...ROLES].sort());
    for (const role of ROLES) {
      assert.equal(typeof defs[role].description, 'string');
      assert.equal(typeof defs[role].system, 'string');
      assert.ok(Array.isArray(defs[role].permissions), `${role} permissions must be a V2 array`);
    }
  });

  test('build denies edit, grep, glob, and list in the resolved permissions', () => {
    const { defs } = resolveAgentDefinitions({});
    for (const action of ['edit', 'grep', 'glob', 'list']) {
      assert.equal(resolveRule(defs.build.permissions, action, 'anything'), 'deny');
    }
  });

  test('resolved shell rules keep their source wildcard-first order', () => {
    const { defs } = resolveAgentDefinitions({});
    // Deny-by-default maps lead with "*": deny.
    for (const role of ['build', 'plan', 'reviewer']) {
      const shell = defs[role].permissions.filter((r) => r.action === 'shell');
      assert.equal(shell[0].resource, '*', `${role} shell wildcard deny must appear first`);
      assert.equal(shell[0].effect, 'deny');
    }
    // Allow-by-default executors lead with "*": allow (source contract).
    for (const role of ['sidekick', 'design']) {
      const shell = defs[role].permissions.filter((r) => r.action === 'shell');
      assert.equal(shell[0].resource, '*', `${role} shell wildcard must appear first`);
      assert.equal(shell[0].effect, 'allow');
    }
    for (const role of ['research', 'vision']) {
      assert.deepEqual(
        defs[role].permissions.filter((r) => r.action === 'shell'),
        [{ action: 'shell', resource: '*', effect: 'deny' }],
        `${role} shell must be a full deny`
      );
    }
  });

  test('subagent rules are wildcard deny plus exact named allows', () => {
    const { defs } = resolveAgentDefinitions({});
    for (const [role, allows] of Object.entries(SUBAGENT_MAPS)) {
      const sub = defs[role].permissions.filter((r) => r.action === 'subagent');
      assert.equal(sub[0].resource, '*', `${role} subagent wildcard deny must appear first`);
      assert.equal(sub[0].effect, 'deny');
      assert.deepEqual(sub.slice(1).map((r) => r.resource).sort(), [...allows].sort(), `${role} subagent allows mismatch`);
      for (const rule of sub.slice(1)) assert.equal(rule.effect, 'allow');
    }
    assert.deepEqual(
      defs.vision.permissions.filter((r) => r.action === 'subagent'),
      [{ action: 'subagent', resource: '*', effect: 'deny' }]
    );
  });

  test('executors deny git commit and git push entirely', () => {
    const { defs } = resolveAgentDefinitions({});
    for (const role of ['sidekick', 'design']) {
      const rules = defs[role].permissions;
      for (const command of [
        'git commit -m change',
        'git -C . commit -m change',
        'git --git-dir .git push origin main',
        'env git push origin main',
        'git.exe commit -m change',
        'git.exe push origin main',
        'git.exe -C . commit -m change',
      ]) {
        assert.equal(resolveRule(rules, 'shell', command), 'deny', `${role} must deny ${command}`);
      }
    }
  });

  test('sidekick and design share identical shell guard rules', () => {
    const shellOf = (role) => resolveAgentDefinitions({}).defs[role].permissions.filter((r) => r.action === 'shell');
    assert.deepEqual(shellOf('design'), shellOf('sidekick'));
  });

  test('build asks on commit/push and denies dangerous push variants after the push ask', () => {
    const rules = resolveAgentDefinitions({}).defs.build.permissions;
    assert.equal(resolveRule(rules, 'shell', 'git add .'), 'allow');
    assert.equal(resolveRule(rules, 'shell', 'git commit -m x'), 'ask');
    assert.equal(resolveRule(rules, 'shell', 'git push origin feature'), 'ask');
    for (const command of [
      'git push origin feature--force',
      'git push origin feature--mirror',
      'git push origin feature--delete',
      'git push origin feature--prune',
    ]) {
      assert.equal(resolveRule(rules, 'shell', command), 'ask', `an ordinary push must ask: ${command}`);
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
      assert.equal(resolveRule(rules, 'shell', command), 'deny', `dangerous push must be denied: ${command}`);
    }
    // last-match-wins: every git push deny must sit after the broad "git push*" ask.
    const shell = rules.filter((r) => r.action === 'shell');
    const pushAsk = shell.findIndex((r) => r.resource === 'git push*');
    const pushDenies = shell.filter((r) => r.effect === 'deny' && r.resource.startsWith('git push'));
    assert.ok(pushDenies.length >= 4, 'build shell must keep the dangerous-push denylist');
    for (const deny of pushDenies) {
      assert.ok(shell.indexOf(deny) > pushAsk, `${deny.resource} must appear after "git push*" (last-match-wins)`);
    }
  });

  test('design is fenced to the workspace and can load the skill its prompt requires', () => {
    const { defs } = resolveAgentDefinitions({});
    assert.equal(resolveRule(defs.design.permissions, 'external_directory', '/elsewhere/x'), 'deny');
    assert.equal(resolveRule(defs.design.permissions, 'skill', 'anything'), 'allow');
    for (const role of ROLES.filter((r) => r !== 'design')) {
      assert.ok(
        !defs[role].permissions.some((r) => r.action === 'skill'),
        `${role} must not grant the skill permission`
      );
    }
  });

  test('read-only verification allowlists still deny file-writing argument forms', () => {
    const { defs } = resolveAgentDefinitions({});
    for (const role of ['build', 'plan', 'reviewer']) {
      const rules = defs[role].permissions;
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
        assert.equal(resolveRule(rules, 'shell', command), 'deny', `${role} must deny the file-writing form: ${command}`);
      }
      for (const command of ['git diff', 'git log --oneline', 'npm run lint', 'npm test', 'npx vitest run']) {
        assert.equal(resolveRule(rules, 'shell', command), 'allow', `${role} must still allow the read-only form: ${command}`);
      }
    }
  });

  test('conductor_configure and conductor_status are allowed only for build and plan', () => {
    const { defs } = resolveAgentDefinitions({});
    for (const role of ['build', 'plan']) {
      assert.equal(resolveRule(defs[role].permissions, 'conductor_configure', '*'), 'allow', `${role} must allow conductor_configure`);
      assert.equal(resolveRule(defs[role].permissions, 'conductor_status', '*'), 'allow', `${role} must allow conductor_status`);
    }
    for (const role of ['sidekick', 'research', 'design', 'reviewer', 'vision']) {
      assert.equal(resolveRule(defs[role].permissions, 'conductor_configure', '*'), 'deny', `${role} must deny conductor_configure`);
      assert.equal(resolveRule(defs[role].permissions, 'conductor_status', '*'), 'deny', `${role} must deny conductor_status`);
    }
  });

  test('the conductor tool rules are tool-level: never nested inside shell/subagent groups', () => {
    const { defs } = resolveAgentDefinitions({});
    for (const role of ROLES) {
      for (const rule of defs[role].permissions) {
        assert.ok(
          rule.action === 'shell' || rule.action === 'subagent' || !['bash', 'task'].includes(rule.action),
          `${role} must not nest conductor rules`
        );
      }
      // No blanket wildcard exists to shadow them.
      assert.ok(
        !defs[role].permissions.some((r) => r.action === '*' && r.resource === '*'),
        `${role} permissions must not add a *-on-* wildcard`
      );
    }
  });

  test('build shell rule order is preserved exactly', () => {
    const shell = resolveAgentDefinitions({}).defs.build.permissions.filter((r) => r.action === 'shell');
    assert.deepEqual(shell.map((r) => r.resource), BUILD_SHELL_RESOURCES);
  });

  test('repeated resolution does not mutate the shared AGENTS definitions', () => {
    const first = resolveAgentDefinitions({});
    const second = resolveAgentDefinitions({});
    for (const role of ROLES) {
      assert.equal(
        second.defs[role].permissions.length,
        first.defs[role].permissions.length,
        `${role} permissions must not accumulate rules across calls`
      );
      assert.ok(!('conductor_configure' in mods.AGENTS[role].permission));
      assert.ok(!('system' in mods.AGENTS[role]) || typeof mods.AGENTS[role].system === 'string');
    }
    assert.ok(!('permissions' in mods.AGENTS.build), 'raw AGENTS must keep V1 permission maps, not V2 arrays');
  });

  test('no legacy top-level config keys leak into the resolution', () => {
    const out = resolveAgentDefinitions({});
    assert.ok(!('subagent_depth' in out), 'V2 has no top-level subagent_depth: use experimental.subagent_depth');
    assert.ok(!('small_model' in out), 'small_model is folded into the title agent model');
    assert.ok(!('command' in out), 'commands register through ctx.command, not the resolution');
  });
});

describe('profile and model resolution', () => {
  test('each profile resolves its models onto the correct agents', () => {
    for (const [name, profile] of Object.entries(mods.PROFILES)) {
      const { defs, exploreModel, defaultModel, titleModel } = resolveAgentDefinitions({ profile: name });
      for (const [role, model] of Object.entries(profile.agents)) {
        if (role === 'explore') {
          assert.deepEqual(exploreModel, mods.parseModelRef(model), `${name}: explore model mismatch`);
          assert.ok(!('explore' in defs), 'explore stays model-only, never a full definition');
        } else {
          assert.deepEqual(defs[role].model, mods.parseModelRef(model), `${name}/${role} model mismatch`);
        }
      }
      assert.deepEqual(defaultModel, mods.parseModelRef(profile.model), `${name}: default model must be the profile build model`);
      assert.deepEqual(titleModel, mods.parseModelRef(profile.small_model), `${name}: title model mismatch`);
    }
  });

  test('roles the profile does not assign get no model key', () => {
    const { defs } = resolveAgentDefinitions({ profile: 'chatgpt' });
    for (const role of ['plan', 'design', 'vision']) {
      assert.ok(!('model' in defs[role]), `chatgpt must not assign ${role}`);
    }
  });

  test('options.models overrides the profile per role', () => {
    const out = resolveAgentDefinitions({
      profile: 'opencode-go',
      models: { sidekick: 'custom/fast', explore: 'custom/explore' },
    });
    assert.deepEqual(out.defs.sidekick.model, { providerID: 'custom', id: 'fast' });
    assert.deepEqual(out.exploreModel, { providerID: 'custom', id: 'explore' });
    // Roles without an override still come from the profile.
    assert.deepEqual(out.defs.build.model, { providerID: 'opencode-go', id: 'kimi-k3' });
    assert.deepEqual(out.defs.design.model, { providerID: 'opencode-go', id: 'qwen3.8-max' });
    assert.deepEqual(out.defs.reviewer.model, { providerID: 'opencode-go', id: 'glm-5.3-flash' });
    assert.deepEqual(out.defaultModel, { providerID: 'opencode-go', id: 'kimi-k3' });
    assert.deepEqual(out.titleModel, { providerID: 'opencode-go', id: 'deepseek-v4-flash' });
  });

  test('options.models work without a profile', () => {
    const out = resolveAgentDefinitions({ models: { build: 'custom/build', sidekick: 'custom/fast', explore: 'custom/explore' } });
    assert.deepEqual(out.defs.build.model, { providerID: 'custom', id: 'build' });
    assert.deepEqual(out.defs.sidekick.model, { providerID: 'custom', id: 'fast' });
    assert.deepEqual(out.exploreModel, { providerID: 'custom', id: 'explore' });
    assert.deepEqual(out.defaultModel, { providerID: 'custom', id: 'build' });
    assert.ok(!('titleModel' in out), 'title model must only come from a profile');
    for (const role of ['plan', 'research', 'design', 'reviewer', 'vision']) {
      assert.ok(!('model' in out.defs[role]), `${role} must not get a model from unrelated options`);
    }
  });

  test('unknown profile throws and names the available profiles', () => {
    assert.throws(
      () => resolveAgentDefinitions({ profile: 'nope' }),
      (err) => {
        assert.match(err.message, /Unknown conductor profile "nope"/);
        for (const name of Object.keys(mods.PROFILES)) {
          assert.ok(err.message.includes(name), `error must name available profile ${name}`);
        }
        return true;
      }
    );
  });

  test('with no profile and no models, agents get no model key and explore stays untouched', () => {
    const out = resolveAgentDefinitions({});
    for (const role of ROLES) {
      assert.ok(!('model' in out.defs[role]), `${role} must not get a model key`);
    }
    assert.ok(!('exploreModel' in out), 'explore must not resolve without a model');
    assert.ok(!('defaultModel' in out), 'no default model without a build model');
    assert.ok(!('titleModel' in out), 'no title model without a profile');
  });

  test('explore resolves only when a model resolves for it', () => {
    const withExplore = resolveAgentDefinitions({ models: { explore: 'x/explore' } });
    assert.deepEqual(withExplore.exploreModel, { providerID: 'x', id: 'explore' });
    const withoutExplore = resolveAgentDefinitions({ models: { build: 'x/build' } });
    assert.ok(!('exploreModel' in withoutExplore));
  });
});

describe('registerConductor V2 wiring', () => {
  function stubEditor(initial = {}) {
    const store = new Map(Object.entries(initial));
    return {
      store,
      list: () => [...store.values()],
      get: (id) => store.get(id),
      default: () => {},
      update: (id, fn) => {
        const current = store.get(id) ?? { id };
        fn(current);
        store.set(id, current);
      },
      remove: (id) => { store.delete(id); },
    };
  }

  function fakeCtx(options = {}) {
    const seen = { agentCb: null, modelCb: null, commands: [], tools: [], hooks: {}, defaultModel: null };
    const ctx = {
      options,
      location: { directory: '/test/location', project: { id: 'p1', directory: '/test/location', canonical: '/test/location' } },
      agent: {
        transform: async (cb) => { seen.agentCb = cb; },
        reload: async () => {},
      },
      model: {
        transform: async (cb) => {
          seen.modelCb = cb;
          cb({ default: { set: (providerID, id) => { seen.defaultModel = { providerID, id }; } } });
        },
        reload: async () => {},
      },
      command: {
        transform: async (cb) => { cb({ add: (def) => seen.commands.push(def) }); },
        reload: async () => {},
      },
      tool: {
        transform: async (cb) => { cb({ add: (def) => seen.tools.push(def) }); },
        reload: async () => {},
      },
      session: {
        hook: async (name, cb) => { seen.hooks[name] = cb; },
        get: async () => ({ data: { location: { directory: '/test/session' } } }),
        prompt: async () => {},
      },
      event: {
        subscribe: () => (async function* () {})(),
      },
    };
    return { ctx, seen };
  }

  test('upserts all seven roles and preserves existing explore/title entries', async () => {
    const { ctx, seen } = fakeCtx({ profile: 'opencode-go' });
    await mods.registerConductor(ctx, ctx.options);
    assert.equal(typeof seen.agentCb, 'function', 'must register an agent transform');

    const editor = stubEditor({
      build: { id: 'build', description: 'old', permissions: [] },
      explore: { id: 'explore', description: 'built-in', permissions: [{ action: 'x', resource: '*', effect: 'allow' }] },
      title: { id: 'title', permissions: [] },
    });
    seen.agentCb(editor);
    for (const role of ROLES) {
      const agent = editor.store.get(role);
      assert.ok(agent, `${role} must be registered`);
      assert.equal(typeof agent.system, 'string', `${role} must carry its system prompt`);
      assert.ok(Array.isArray(agent.permissions), `${role} must carry V2 permissions`);
    }
    assert.equal(editor.store.get('sidekick').model.providerID, 'opencode-go');
    // explore keeps its built-in definition fields, gaining only the model.
    assert.equal(editor.store.get('explore').description, 'built-in');
    assert.equal(editor.store.get('explore').model.id, 'deepseek-v4-flash');
    // title gains the profile small_model.
    assert.equal(editor.store.get('title').model.id, 'deepseek-v4-flash');
    // default session model follows the build model.
    assert.deepEqual(seen.defaultModel, { providerID: 'opencode-go', id: 'kimi-k3' });
  });

  test('registers the /conductor command, the conductor tools, and the context guard', async () => {
    const { ctx, seen } = fakeCtx({});
    await mods.registerConductor(ctx, ctx.options);
    assert.equal(seen.commands.length, 1);
    assert.equal(seen.commands[0].name, 'conductor');
    assert.equal(seen.commands[0].description, mods.COMMANDS.conductor.description);
    assert.equal(typeof seen.commands[0].execute, 'function');
    assert.deepEqual(seen.tools.map((t) => t.name).sort(), ['conductor_configure', 'conductor_status']);
    assert.equal(typeof seen.hooks.context, 'function', 'must register the context guard hook');
  });

  test('the /conductor command substitutes the invocation text for $ARGUMENTS', async () => {
    const { ctx, seen } = fakeCtx({});
    await mods.registerConductor(ctx, ctx.options);
    const prompts = [];
    ctx.session.prompt = async (input) => { prompts.push(input); };
    await seen.commands[0].execute({ sessionID: 'ses_1', prompt: { text: 'profile chatgpt' }, delivery: 'steer' });
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].sessionID, 'ses_1');
    assert.ok(prompts[0].text.includes('profile chatgpt'), 'invocation text must replace $ARGUMENTS');
    assert.ok(!prompts[0].text.includes('$ARGUMENTS'), 'no $ARGUMENTS may survive');
  });

  test('the context guard strips mutation/search tools only for build and plan', async () => {
    const { ctx, seen } = fakeCtx({});
    await mods.registerConductor(ctx, ctx.options);
    const tools = () => ({ edit: {}, write: {}, patch: {}, grep: {}, glob: {}, read: {}, subagent: {} });
    const buildEvent = { agent: 'build', tools: tools() };
    seen.hooks.context(buildEvent);
    assert.deepEqual(Object.keys(buildEvent.tools).sort(), ['read', 'subagent']);
    const planEvent = { agent: 'plan', tools: tools() };
    seen.hooks.context(planEvent);
    assert.deepEqual(Object.keys(planEvent.tools).sort(), ['read', 'subagent']);
    const sidekickEvent = { agent: 'sidekick', tools: tools() };
    seen.hooks.context(sidekickEvent);
    assert.equal(Object.keys(sidekickEvent.tools).length, 7, 'executors keep every tool');
  });

  test('unknown profile rejects registration with the available names', async () => {
    const { ctx } = fakeCtx({ profile: 'nope' });
    await assert.rejects(
      mods.registerConductor(ctx, ctx.options),
      (err) => {
        assert.match(err.message, /Unknown conductor profile "nope"/);
        return true;
      }
    );
  });
});


describe("title agent model", () => {
  test("the title model follows the profile small_model", () => {
    const out = mods.resolveAgentDefinitions({ profile: "chatgpt" });
    assert.deepEqual(out.titleModel, { providerID: "openai", id: "gpt-5.6-luna" });
  });

  test("there is no models.title override", () => {
    const out = mods.resolveAgentDefinitions({ profile: "opencode-go", models: { title: "custom/titles" } });
    assert.deepEqual(out.titleModel, { providerID: "opencode-go", id: "deepseek-v4-flash" });
  });
});
