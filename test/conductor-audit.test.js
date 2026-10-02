'use strict';

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// The V2 audit module exposes a pure event handler (auditHook) plus a
// subscription wiring helper (registerAudit). Tool-execution logging rides the
// event stream (message.part.updated with completed tool parts). Behavioral
// expectations are unchanged from the V1 event hook.
describe('conductor-audit event hook', () => {
  let auditHook;
  let registerAudit;
  let logged;
  let hook;

  before(async () => {
    ({ auditHook, registerAudit } = await import(
      pathToFileURL(path.join(__dirname, '..', 'src', 'audit.js')).href
    ));

    logged = [];
    hook = auditHook({ audit: true }, (message, extra) => { logged.push({ message, extra }); });
  });

  test('returns undefined when audit is off and an event hook function when on', () => {
    assert.equal(auditHook({}, () => {}), undefined, 'audit must be opt-in');
    assert.equal(auditHook({ audit: false }, () => {}), undefined, 'audit false must stay inert');
    assert.equal(typeof hook, 'function', 'audit on must return the event hook function');
    // The contract holds even without a log sink: the hook still exists.
    assert.equal(typeof auditHook({ audit: true }), 'function');
  });

  test('registerAudit returns undefined when audit is off', async () => {
    const seen = [];
    const ctx = { event: { subscribe: () => (async function* () {})() } };
    assert.equal(await registerAudit(ctx, {}, (m, e) => seen.push([m, e])), undefined);
    assert.equal(seen.length, 0);
  });

  test('registerAudit subscribes and returns a cleanup function when on', async () => {
    const events = [
      { type: 'session.created', properties: { info: { id: 'ses_child', parentID: 'ses_root' } } },
    ];
    const seen = [];
    const ctx = {
      event: {
        subscribe: () => (async function* () {
          yield events[0];
        })(),
      },
    };
    const cleanup = await registerAudit(ctx, { audit: true }, (m, e) => seen.push([m, e]));
    assert.equal(typeof cleanup, 'function');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(seen.length, 1);
    assert.equal(seen[0][0], 'subagent session spawned');
    cleanup();
  });

  test('logs child session spawns and ignores root sessions', async () => {
    logged.length = 0;
    await hook({
      event: {
        type: 'session.created',
        properties: { info: { id: 'ses_child', parentID: 'ses_root', title: 'delegated work' } },
      },
    });
    await hook({
      event: { type: 'session.created', properties: { info: { id: 'ses_root' } } },
    });
    await hook({ event: { type: 'message.updated', properties: {} } });

    assert.equal(logged.length, 1, 'only the child session spawn should be logged');
    assert.equal(logged[0].message, 'subagent session spawned');
    assert.equal(logged[0].extra.parentID, 'ses_root');
  });

  test('accepts the V2 data envelope as well as properties', async () => {
    logged.length = 0;
    await hook({
      event: {
        type: 'session.created',
        data: { info: { id: 'ses_child2', parentID: 'ses_root' } },
      },
    });
    assert.equal(logged.length, 1);
    assert.equal(logged[0].extra.sessionID, 'ses_child2');
  });

  test('logs edit/write/apply_patch/subagent tool executions and ignores read-only tools', async () => {
    logged.length = 0;
    // "apply_patch" is the third mutation tool gated by the edit permission.
    // Tool executions reach the event hook as completed tool parts; a tool
    // part still running or in error is not a finished execution. V2 renamed
    // the delegation tool from "task" to "subagent"; both spellings log.
    for (const tool of ['edit', 'write', 'apply_patch', 'task', 'subagent', 'read', 'grep', 'shell']) {
      await hook({
        event: {
          type: 'message.part.updated',
          properties: { sessionID: 'ses_x', part: { type: 'tool', tool, state: { status: 'completed' } } },
        },
      });
    }
    assert.deepEqual(
      logged.map((entry) => entry.extra.tool),
      ['edit', 'write', 'apply_patch', 'task', 'subagent'],
      'only file-mutating and delegation tools belong in the audit trail'
    );
  });

  test('aggregates assistant token usage by agent and model when a session becomes idle', async () => {
    logged.length = 0;
    const update = (info) => hook({
      event: { type: 'message.updated', properties: { info: { role: 'assistant', ...info } } },
    });

    await update({
      id: 'msg_build_1', sessionID: 'ses_usage', mode: 'build',
      providerID: 'openai', modelID: 'gpt-main', cost: 0.125,
      tokens: { input: 10, output: 4, reasoning: 1, cache: { read: 2, write: 3 } },
    });
    await update({
      id: 'msg_build_2', sessionID: 'ses_usage', mode: 'build',
      providerID: 'openai', modelID: 'gpt-main',
      tokens: { input: 5, output: 6, reasoning: 0, cache: { read: 1, write: 0 } },
    });
    await update({
      id: 'msg_sidekick', sessionID: 'ses_usage', mode: 'sidekick',
      providerID: 'other', modelID: 'fast-model', cost: 0.5,
      tokens: { input: 7, output: 8, reasoning: 2, cache: { read: 4, write: 0 } },
    });
    // A later update for the same message replaces its earlier cumulative totals.
    await update({
      id: 'msg_sidekick', sessionID: 'ses_usage', mode: 'sidekick',
      providerID: 'other', modelID: 'fast-model', cost: 0.25,
      tokens: { input: 9, output: 10, reasoning: 3, cache: { read: 5, write: 1 } },
    });
    await hook({ event: { type: 'session.idle', properties: { sessionID: 'ses_usage' } } });

    assert.deepEqual(logged, [{
      message: 'session token usage',
      extra: {
        sessionID: 'ses_usage',
        usage: [
          {
            agent: 'build', modelID: 'gpt-main', providerID: 'openai',
            input: 15, output: 10, reasoning: 1, cacheRead: 3, cacheWrite: 3, cost: 0.125,
          },
          {
            agent: 'sidekick', modelID: 'fast-model', providerID: 'other',
            input: 9, output: 10, reasoning: 3, cacheRead: 5, cacheWrite: 1, cost: 0.25,
          },
        ],
      },
    }]);

    await hook({ event: { type: 'session.idle', properties: { sessionID: 'ses_usage' } } });
    assert.equal(logged.length, 1, 'an idle session with no new messages must not log twice');
  });

  test('ignores malformed and empty event payloads without throwing or logging', async () => {
    logged.length = 0;
    await assert.doesNotReject(async () => {
      await hook({});
      await hook({ event: {} });
      await hook({ event: { type: 'message.updated' } });
      await hook({
        event: {
          type: 'message.updated',
          properties: {
            info: {
              id: 'msg_bad', sessionID: 'ses_bad', role: 'assistant', modelID: 'model',
              tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } },
            },
          },
        },
      });
      await hook({
        event: {
          type: 'message.updated',
          properties: {
            info: {
              id: 'msg_bad_tokens', sessionID: 'ses_bad', role: 'assistant', mode: 'build',
              modelID: 'model', tokens: { input: '1', output: 2, reasoning: 3, cache: {} },
            },
          },
        },
      });
      // Tool parts that are not completed executions must not log either.
      await hook({
        event: {
          type: 'message.part.updated',
          properties: { sessionID: 'ses_bad', part: { type: 'tool', tool: 'edit', state: { status: 'running' } } },
        },
      });
      await hook({
        event: {
          type: 'message.part.updated',
          properties: { sessionID: 'ses_bad', part: { type: 'tool', tool: 'edit', state: { status: 'error' } } },
        },
      });
      await hook({ event: { type: 'session.idle', properties: { sessionID: 'ses_bad' } } });
      await hook({ event: { type: 'session.idle', properties: {} } });
    });
    assert.equal(logged.length, 0);
  });
});
