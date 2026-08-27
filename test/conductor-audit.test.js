'use strict';

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// Ported from test/plugin.test.js (the fusion-audit plugin smoke test). The
// source plugin returned { event, 'tool.execute.after' }; the conductor plugin
// wires auditHook's return value as the single "event" hook, so tool-execution
// logging now rides the event stream (message.part.updated with completed tool
// parts) instead of the tool.execute.after trigger hook. Behavioral
// expectations are unchanged.
describe('conductor-audit event hook (ported from fusion-audit)', () => {
  let auditHook;
  let logged;
  let hook;

  before(async () => {
    ({ auditHook } = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'audit.js')).href));

    logged = [];
    const input = { client: { app: { log: (entry) => { logged.push(entry.body); } } } };
    hook = auditHook(input, { audit: true });
  });

  test('returns undefined when audit is off and an event hook function when on', () => {
    const input = { client: { app: { log: () => {} } } };
    assert.equal(auditHook(input, {}), undefined, 'audit must be opt-in');
    assert.equal(auditHook(input, { audit: false }), undefined, 'audit false must stay inert');
    assert.equal(typeof hook, 'function', 'audit on must return the event hook function');
    // The contract holds even when the plugin input (and thus the client) is
    // missing: the hook still exists but degrades to a no-op.
    assert.equal(typeof auditHook(undefined, { audit: true }), 'function');
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
    assert.equal(logged[0].service, 'conductor-audit');
    assert.equal(logged[0].message, 'subagent session spawned');
    assert.equal(logged[0].extra.parentID, 'ses_root');
  });

  test('logs edit/write/apply_patch/task tool executions and ignores read-only tools', async () => {
    logged.length = 0;
    // "apply_patch" is opencode's third mutation tool gated by the edit
    // permission. Tool executions reach the event hook as completed tool parts;
    // a tool part still running or in error is not a finished execution.
    for (const tool of ['edit', 'write', 'apply_patch', 'task', 'read', 'grep', 'bash']) {
      await hook({
        event: {
          type: 'message.part.updated',
          properties: { sessionID: 'ses_x', part: { type: 'tool', tool, state: { status: 'completed' } } },
        },
      });
    }
    assert.deepEqual(
      logged.map((entry) => entry.extra.tool),
      ['edit', 'write', 'apply_patch', 'task'],
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
      service: 'conductor-audit',
      level: 'info',
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