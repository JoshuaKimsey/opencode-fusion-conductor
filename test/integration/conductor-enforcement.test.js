'use strict';

// Live integration tests for the Conductor PLUGIN: start the REAL opencode
// binary against a fake OpenAI-compatible provider and assert that the
// plugin's config-hook-injected agents are enforced on the wire exactly the
// way the old file-installed agents were (enforcement.test.js proves the
// file-based path; this suite proves the plugin path). The fake provider
// captures every request opencode sends, including the tool schema offered to
// the model - so "edit is denied" is asserted on the wire, not on the JSON.
//
// Nothing here writes config.agent entries or agent .md files: the conductor
// env (conductor-env.js) writes neither, so every injected agent must come
// from the plugin's config hook alone.
//
// Gated behind CONDUCTOR_INTEGRATION=1 (needs an opencode binary on PATH):
//   CONDUCTOR_INTEGRATION=1 node --test test/integration/conductor-enforcement.test.js
// Plain `npm test` skips this file and stays hermetic.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { FakeProvider, toolNames, systemText, toolResults } = require('./fake-provider');
const {
  createConductorEnv,
  profileInfo,
  runOpencode,
  opencodeAvailable,
  opencodeBin,
  toolName,
  taskArgs,
} = require('./conductor-env');

const enabled = process.env.CONDUCTOR_INTEGRATION === '1';
const available = !enabled || opencodeAvailable();
if (enabled && !available) {
  test('CONDUCTOR_INTEGRATION=1 requires an opencode binary on PATH', () => {
    assert.fail('CONDUCTOR_INTEGRATION=1 but no opencode binary is available on PATH');
  });
}
const skip = enabled
  ? available
    ? false
    : 'opencode availability is reported by the failing precondition test'
  : 'set CONDUCTOR_INTEGRATION=1 (runs the real opencode binary)';

// Tools whose absence from a restricted agent is real evidence: an
// unrestricted agent is offered them, so their absence is the permission layer
// removing them. Asserted with the inconclusive guard below.
const DENIED_REAL_TOOLS = ['edit', 'write', 'grep', 'glob'];

// Names this project also refuses to see, which no release under test offers
// to anyone: v1 has no apply_patch and neither has list; v2 has neither. Their
// absence proves nothing about enforcement, so they are asserted defensively
// (a future release adding one under a mutating alias should fail this suite)
// and deliberately kept out of the evidence-bearing list above.
const ABSENT_ALIAS_TOOLS = ['apply_patch', 'list'];

// v2 renamed bash -> shell and task -> subagent. Resolve those two through the
// harness so the same assertions run against either binary.
const BASH = toolName('bash');
const TASK = toolName('task');

// The build prompt also mentions "SIDEKICK", so a sidekick session is
// identified by the sidekick prompt's own opening line, nothing looser.
const SIDEKICK_MARKER = 'You are the SIDEKICK';

// The task tool's description ends with a permission-filtered enumeration of
// the subagents the current agent may spawn (the "denied subagents are
// filtered" behavior the old file-based suite relies on).
const TASK_AGENT_MARKER = 'Available agent types and the tools they have access to:';

/** Captured requests that carry a tool schema (drops title generation). */
function agentRequests(provider) {
  return provider.requests.filter((b) => Array.isArray(b.tools));
}

/** The task tool's schema object from the first tool-bearing request. */
function taskToolSchema(requests) {
  for (const b of requests) {
    if (!Array.isArray(b.tools)) continue;
    for (const t of b.tools) {
      const name = (t.function && t.function.name) || t.name;
      if (name === TASK) return t.function || t;
    }
  }
  return null;
}

/** Subagent names the task tool description enumerates after its marker. */
function enumeratedSubagents(taskTool) {
  const desc = (taskTool && taskTool.description) || '';
  const idx = desc.indexOf(TASK_AGENT_MARKER);
  if (idx === -1) return [];
  const tail = desc.slice(idx + TASK_AGENT_MARKER.length);
  return tail
    .split('\n')
    .filter((line) => /^-\s+(\w+)/.test(line))
    .map((line) => line.match(/^-\s+(\w+)/)[1]);
}

async function captureSchema(agent, route = () => ({ text: 'ok' }), envOptions = {}) {
  const provider = new FakeProvider(route);
  const baseURL = await provider.start();
  const envInfo = await createConductorEnv(baseURL, envOptions);
  try {
    const result = await runOpencode({ agent, message: 'integration probe', envInfo });
    return { provider, result };
  } finally {
    envInfo.cleanup();
    await provider.stop();
  }
}

/** Route that makes build delegate to the sidekick once, then stop. */
function delegationRoute({ description = 'integration delegation probe', sidekickReply = 'sidekick reporting in' } = {}) {
  return (body) => {
    if (!Array.isArray(body.tools)) return { text: 'title' };
    if (systemText(body).includes(SIDEKICK_MARKER)) return { text: sidekickReply };
    if (toolResults(body).length === 0) {
      return {
        tool: {
          name: TASK,
          args: taskArgs({ agent: 'sidekick', description, prompt: 'reply with a short confirmation and stop' }),
        },
      };
    }
    return { text: 'delegation observed' };
  };
}

// A "denied tool is absent" assertion only proves enforcement when the tool
// exists to begin with. Sidekick denies none of the conductor tools' siblings
// in DENIED_REAL_TOOLS, so its schema is the reference for what the binary
// under test offers an unrestricted agent.
let offeredToSidekick = null;
async function binaryToolSurface() {
  if (offeredToSidekick) return offeredToSidekick;
  const { provider } = await captureSchema('build', delegationRoute());
  const sidekickReq = agentRequests(provider).find((b) =>
    systemText(b).includes(SIDEKICK_MARKER)
  );
  assert.ok(
    sidekickReq,
    `could not inventory ${opencodeBin()}'s tool surface - the sidekick session never ran`
  );
  offeredToSidekick = toolNames(sidekickReq);
  return offeredToSidekick;
}

/** Assert a denied tool is absent AND that its absence is enforcement rather
    than the tool not existing in this release. */
function assertDeniedAndReal(tools, denied, surface, role) {
  assert.ok(
    !tools.includes(denied),
    `${role} was offered denied tool "${denied}" (schema: ${tools.join(', ')})`
  );
  assert.ok(
    surface.includes(denied),
    `inconclusive: "${denied}" is absent from ${role}, but ${opencodeBin()} does not offer it to an unrestricted agent either, so its absence proves nothing about enforcement (surface: ${surface.join(', ')})`
  );
}

/** Assert a name this project refuses to see is absent, without claiming the
    absence proves enforcement. */
function assertAbsent(tools, name, role) {
  assert.ok(
    !tools.includes(name),
    `${role} was offered "${name}", which this suite expects no release to provide (schema: ${tools.join(', ')})`
  );
}

describe('live plugin enforcement (real opencode, fake provider)', { skip }, () => {
  test('build agent tool schema has no mutation or search tools (plugin config hook)', async () => {
    const surface = await binaryToolSurface();
    const { provider, result } = await captureSchema('build');
    assert.equal(result.code, 0, `opencode exited ${result.code}: ${result.stderr.slice(-800)}`);
    const requests = agentRequests(provider);
    assert.ok(requests.length >= 1, 'no tool-bearing request reached the fake provider');
    const tools = toolNames(requests[0]);
    for (const denied of DENIED_REAL_TOOLS) {
      assertDeniedAndReal(tools, denied, surface, 'build agent');
    }
    for (const name of ABSENT_ALIAS_TOOLS) assertAbsent(tools, name, 'build agent');
    for (const required of [BASH, 'read', TASK]) {
      assert.ok(
        tools.includes(required),
        `build agent is missing expected tool "${required}" (schema: ${tools.join(', ')})`
      );
    }
    assert.ok(
      tools.includes('conductor_configure'),
      `build agent is missing custom tool "conductor_configure" (schema: ${tools.join(', ')})`
    );
    assert.ok(
      tools.includes('conductor_status'),
      `build agent is missing custom tool "conductor_status" (schema: ${tools.join(', ')})`
    );
  });

  test('build task tool description enumerates allowed subagents and filters denied ones', async () => {
    const { provider, result } = await captureSchema('build');
    assert.equal(result.code, 0, `opencode exited ${result.code}: ${result.stderr.slice(-800)}`);
    const requests = agentRequests(provider);
    assert.ok(requests.length >= 1, 'no tool-bearing request reached the fake provider');
    const taskTool = taskToolSchema(requests);
    assert.ok(taskTool, `build agent was not offered the "${TASK}" tool`);
    const enumerated = enumeratedSubagents(taskTool);
    assert.ok(
      enumerated.length >= 1,
      `task tool description enumerates no subagents - did ${opencodeBin()} stop appending the agent list?`
    );
    // Allowed for build -> enumerated.
    for (const allowed of ['sidekick', 'explore', 'research', 'design', 'reviewer', 'vision']) {
      assert.ok(
        enumerated.includes(allowed),
        `build task tool does not enumerate allowed subagent "${allowed}" (enumerated: ${enumerated.join(', ')})`
      );
    }
    // Denied for build (the "*" catch-all denies general, v1 filters denied
    // subagents out of the task description) -> filtered.
    assert.ok(
      !enumerated.includes('general'),
      `build task tool enumerates denied subagent "general" (enumerated: ${enumerated.join(', ')})`
    );
  });

  test('build delegates to sidekick, whose schema includes edit and excludes the conductor tools', async () => {
    // Script: build's first turn calls task(sidekick); the sidekick turn
    // replies text; build's follow-up (carrying the tool result) stops.
    const route = delegationRoute();
    const { provider, result } = await captureSchema('build', route);
    assert.equal(result.code, 0, `opencode exited ${result.code}: ${result.stderr.slice(-800)}`);

    const sidekickReq = agentRequests(provider).find((b) =>
      systemText(b).includes(SIDEKICK_MARKER)
    );
    assert.ok(sidekickReq, 'sidekick session never called the model - task delegation did not run');
    const tools = toolNames(sidekickReq);
    for (const required of ['edit', 'write', BASH, 'grep', 'glob']) {
      assert.ok(
        tools.includes(required),
        `sidekick is missing executor tool "${required}" (schema: ${tools.join(', ')})`
      );
    }
    // withConductorToolPermissions marks the conductor tools "deny" for
    // every role except build/plan, so the offered schema must drop them.
    assert.ok(
      !tools.includes('conductor_configure'),
      `sidekick was offered denied tool "conductor_configure" (schema: ${tools.join(', ')})`
    );
    assert.ok(
      !tools.includes('conductor_status'),
      `sidekick was offered denied tool "conductor_status" (schema: ${tools.join(', ')})`
    );
    // Denied subagents are filtered for sidekick too: its task allowlist is
    // explore + research only, so vision (denied) must not be enumerated.
    const taskTool = taskToolSchema([sidekickReq]);
    assert.ok(taskTool, `sidekick was not offered the "${TASK}" tool`);
    const enumerated = enumeratedSubagents(taskTool);
    for (const allowed of ['explore', 'research']) {
      assert.ok(
        enumerated.includes(allowed),
        `sidekick task tool does not enumerate allowed subagent "${allowed}" (enumerated: ${enumerated.join(', ')})`
      );
    }
    assert.ok(
      !enumerated.includes('vision'),
      `sidekick task tool enumerates denied subagent "vision" (enumerated: ${enumerated.join(', ')})`
    );
  });

  test('plugin options (profile) assign per-role models observed on the wire', async () => {
    const profile = 'opencode-go';
    const info = await profileInfo(profile);
    assert.ok(info.modelByRole.build, `profile "${profile}" assigns no build model`);
    assert.ok(info.modelByRole.sidekick, `profile "${profile}" assigns no sidekick model`);

    const route = delegationRoute();
    const { provider, result } = await captureSchema('build', route, {
      pluginOptions: { profile },
      mechanism: 'plugin-array',
    });
    assert.equal(result.code, 0, `opencode exited ${result.code}: ${result.stderr.slice(-800)}`);
    const requests = agentRequests(provider);
    assert.ok(requests.length >= 1, 'no tool-bearing request reached the fake provider');

    const buildReq = requests[0];
    assert.equal(
      buildReq.model,
      info.modelByRole.build,
      `build request went to model "${buildReq.model}", expected profile model "${info.modelByRole.build}"`
    );
    const sidekickReq = requests.find((b) => systemText(b).includes(SIDEKICK_MARKER));
    assert.ok(sidekickReq, 'sidekick session never ran under the profile env');
    assert.equal(
      sidekickReq.model,
      info.modelByRole.sidekick,
      `sidekick request went to model "${sidekickReq.model}", expected profile model "${info.modelByRole.sidekick}"`
    );
  });

  test('conductor integration environment is hermetic and enables only the fake provider', async () => {
    process.env.CONDUCTOR_TEST_SECRET = 'must-not-leak';
    const envInfo = await createConductorEnv('http://127.0.0.1:12345/v1');
    try {
      assert.equal(envInfo.env.CONDUCTOR_TEST_SECRET, undefined);
      assert.equal(envInfo.env.NODE_OPTIONS, undefined);

      const configDir = path.join(envInfo.fakeHome, '.config', 'opencode');
      const config = JSON.parse(
        fs.readFileSync(path.join(configDir, 'opencode.json'), 'utf8')
      );
      assert.deepEqual(config.enabled_providers, ['fake']);
      assert.equal(
        config.agent,
        undefined,
        'conductor env must not write config.agent entries - the plugin config hook is the only agent source'
      );
      assert.ok(
        !fs.existsSync(path.join(configDir, 'agent')),
        'conductor env must not install agent .md files'
      );
      assert.ok(fs.existsSync(path.join(envInfo.projectDir, '.git', 'HEAD')));
      const projectConfig = JSON.parse(
        fs.readFileSync(path.join(envInfo.projectDir, 'opencode.json'), 'utf8')
      );
      assert.deepEqual(projectConfig.enabled_providers, ['fake']);
      assert.deepEqual(Object.keys(projectConfig.provider), ['fake']);
      assert.equal(
        fs.readFileSync(path.join(envInfo.fakeHome, '.cache', 'opencode', 'models.json'), 'utf8'),
        '{}'
      );
    } finally {
      delete process.env.CONDUCTOR_TEST_SECRET;
      envInfo.cleanup();
    }
  });
});