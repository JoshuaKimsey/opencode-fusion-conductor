'use strict';

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..');

let claudeTools;
let Conductor;
before(async () => {
  const load = (name) => import(pathToFileURL(path.join(root, 'src', name)).href);
  const [claude, index] = await Promise.all([load('claude.js'), load('index.js')]);
  claudeTools = claude.claudeTools;
  Conductor = index.Conductor;
});

describe('Conductor Claude Code bridge (claudeTools factory)', () => {
  // claudeTools(options) is a tool-factory function: tests inject the process
  // runner, environment, and timeouts through options. A bogus PATH guarantees
  // that a wiring bug can never reach the real claude CLI from a unit test.
  const toolsWith = (options = {}) =>
    claudeTools({
      environment: { PATH: 'conductor-test-no-such-path' },
      ...options,
    });

  const recordingRun = (results) => {
    const calls = [];
    const run = async (options) => {
      calls.push(options);
      return typeof results === 'function' ? results(options) : results.shift();
    };
    return { calls, run };
  };

  const flagValue = (args, flag) => {
    const index = args.indexOf(flag);
    assert.notEqual(index, -1, `missing Claude CLI flag: ${flag}`);
    return args[index + 1];
  };

  const authResult = (overrides = {}) => ({
    code: 0,
    stdout: JSON.stringify({
      loggedIn: true,
      authMethod: 'claude.ai',
      apiProvider: 'firstParty',
      subscriptionType: 'pro',
      email: 'must-not-leak@example.com',
      ...overrides,
    }),
    stderr: '',
  });

  const reviewResult = (result = 'PLAN_APPROVED\nThe plan is focused and testable.', model = 'claude-opus-5') => ({
    code: 0,
    stdout: JSON.stringify({
      result,
      modelUsage: { [model]: { inputTokens: 10, outputTokens: 8 } },
    }),
    stderr: '',
  });

  test('claudeTools returns exactly the two renamed tools', () => {
    const tools = toolsWith({ run: async () => authResult() });
    assert.deepEqual(Object.keys(tools).sort(), ['conductor_claude_review', 'conductor_claude_status']);
  });

  test('index.js wires the conductor tools and the claude tools only when opts.claude is true', async () => {
    const withClaude = await Conductor(undefined, { claude: true });
    assert.deepEqual(Object.keys(withClaude.tool).sort(), [
      'conductor_claude_review',
      'conductor_claude_status',
      'conductor_configure',
      'conductor_status',
    ]);

    const withoutClaude = await Conductor(undefined, {});
    assert.deepEqual(Object.keys(withoutClaude.tool).sort(), ['conductor_configure', 'conductor_status']);
  });

  test('status verifies first-party Pro/Max auth without returning identity data', async () => {
    const tools = toolsWith({ run: async () => authResult() });
    const output = await tools.conductor_claude_status.execute({}, { directory: 'C:/workspace', agent: 'build' });
    assert.match(output, /bridge ready.*PRO.*claude-opus-5/i);
    assert.doesNotMatch(output, /must-not-leak|@example\.com/i);
  });

  test('review pins safe CLI flags as pairs, sends the packet over stdin, and removes API routing', async () => {
    const { calls, run } = recordingRun([authResult(), reviewResult('PLAN_REVISE\nAdd a rollback test.')]);
    const environment = {
      PATH: 'test-path',
      ANTHROPIC_API_KEY: 'api-secret',
      ANTHROPIC_AUTH_TOKEN: 'auth-secret',
      ANTHROPIC_BASE_URL: 'https://proxy.invalid',
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_OAUTH_TOKEN: 'official-cli-token',
    };
    const tools = toolsWith({ run, environment });
    const packet = 'Task and proposed plan';
    const output = await tools.conductor_claude_review.execute({ packet }, { worktree: 'C:/workspace', agent: 'plan' });

    assert.match(output, /PLAN_REVISE\nAdd a rollback test\./);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].args, ['auth', 'status', '--json']);
    assert.equal(calls[1].input, packet);
    assert.equal(calls[1].args.includes(packet), false, 'review packet must not be exposed in process arguments');
    assert.ok(calls[1].args.includes('-p'));
    assert.ok(calls[1].args.includes('--safe-mode'));
    assert.ok(calls[1].args.includes('--no-session-persistence'));
    assert.equal(flagValue(calls[1].args, '--model'), 'claude-opus-5');
    assert.equal(flagValue(calls[1].args, '--effort'), 'high');
    assert.equal(flagValue(calls[1].args, '--tools'), '');
    assert.equal(flagValue(calls[1].args, '--permission-mode'), 'dontAsk');
    assert.equal(flagValue(calls[1].args, '--prompt-suggestions'), 'false');
    assert.equal(flagValue(calls[1].args, '--output-format'), 'json');
    assert.equal(flagValue(calls[1].args, '--max-turns'), '1');
    assert.match(flagValue(calls[1].args, '--system-prompt'), /PLAN_APPROVED or PLAN_REVISE/);
    for (const env of [calls[0].env, calls[1].env]) {
      assert.equal(env.ANTHROPIC_API_KEY, undefined);
      assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
      assert.equal(env.ANTHROPIC_BASE_URL, undefined);
      assert.equal(env.CLAUDE_CODE_USE_BEDROCK, undefined);
      assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
      assert.equal(env.PATH, 'test-path');
    }
  });

  test('scrubs routing variables case-insensitively - Windows env names ignore case', async () => {
    const { calls, run } = recordingRun([authResult(), reviewResult()]);
    const environment = {
      PATH: 'test-path',
      Anthropic_Api_Key: 'api-secret',
      claude_code_use_vertex: '1',
      ANTHROPIC_CUSTOM_HEADERS: 'x-proxy: on',
      Claude_Code_Use_Foundry: '1',
    };
    const tools = toolsWith({ run, environment });
    await tools.conductor_claude_review.execute({ packet: 'plan' }, { directory: 'C:/workspace', agent: 'build' });
    for (const env of [calls[0].env, calls[1].env]) {
      assert.equal(env.Anthropic_Api_Key, undefined);
      assert.equal(env.claude_code_use_vertex, undefined);
      assert.equal(env.ANTHROPIC_CUSTOM_HEADERS, undefined);
      assert.equal(env.Claude_Code_Use_Foundry, undefined);
      assert.equal(env.PATH, 'test-path');
    }
  });

  test('the caller can pick a Claude model and effort within safe bounds', async () => {
    const { calls, run } = recordingRun((options) =>
      options.args[0] === 'auth' ? authResult() : reviewResult('PLAN_APPROVED\nSolid.', 'claude-opus-4-8')
    );
    const tools = toolsWith({ run });
    const output = await tools.conductor_claude_review.execute(
      { packet: 'plan', model: 'claude-opus-4-8', effort: 'max' },
      { directory: 'C:/workspace', agent: 'plan' }
    );
    assert.equal(flagValue(calls[1].args, '--model'), 'claude-opus-4-8');
    assert.equal(flagValue(calls[1].args, '--effort'), 'max');
    assert.match(output, /claude-opus-4-8.*effort max/i);
  });

  test('rejects unsafe model or effort choices before any claude invocation', async () => {
    const { calls, run } = recordingRun([authResult(), reviewResult()]);
    const tools = toolsWith({ run });
    for (const [args, pattern] of [
      [{ packet: 'plan', model: 'gpt-5' }, /full claude-\* model id/i],
      [{ packet: 'plan', model: 'claude-opus-5 --dangerously-skip-permissions' }, /full claude-\* model id/i],
      [{ packet: 'plan', model: 'claude-a-' }, /full claude-\* model id/i],
      [{ packet: 'plan', model: 'claude--x' }, /full claude-\* model id/i],
      [{ packet: 'plan', model: 'CLAUDE-OPUS-5' }, /full claude-\* model id/i],
      [{ packet: 'plan', model: ' claude-opus-5' }, /full claude-\* model id/i],
      [{ packet: 'plan', effort: 'ultra' }, /effort must be one of/i],
    ]) {
      await assert.rejects(
        tools.conductor_claude_review.execute(args, { directory: 'C:/workspace', agent: 'build' }),
        pattern
      );
    }
    assert.equal(calls.length, 0, 'invalid choices must never reach the claude CLI');
  });

  test('runs Claude from a neutral temporary directory, never the workspace', async () => {
    const { calls, run } = recordingRun([authResult(), reviewResult()]);
    const tools = toolsWith({ run });
    await tools.conductor_claude_review.execute({ packet: 'plan' }, { worktree: 'C:/workspace', directory: 'C:/workspace', agent: 'build' });
    assert.equal(calls[0].cwd, os.tmpdir());
    assert.equal(calls[1].cwd, os.tmpdir());
  });

  test('refuses callers other than the build and plan agents', async () => {
    const { calls, run } = recordingRun([authResult()]);
    const tools = toolsWith({ run });
    for (const agent of ['sidekick', 'reviewer', 'explore', undefined]) {
      await assert.rejects(
        tools.conductor_claude_status.execute({}, { directory: 'C:/workspace', agent }),
        /only serve the build and plan agents/i
      );
      await assert.rejects(
        tools.conductor_claude_review.execute({ packet: 'plan' }, { directory: 'C:/workspace', agent }),
        /only serve the build and plan agents/i
      );
    }
    assert.equal(calls.length, 0, 'a refused caller must never reach the claude CLI');
  });

  test('passes the session abort signal through to the Claude process runner', async () => {
    const { calls, run } = recordingRun([authResult(), reviewResult()]);
    const abort = new AbortController();
    const tools = toolsWith({ run });
    await tools.conductor_claude_review.execute({ packet: 'plan' }, { directory: 'C:/workspace', agent: 'plan', abort: abort.signal });
    assert.equal(calls[0].signal, abort.signal);
    assert.equal(calls[1].signal, abort.signal);
  });

  test('rejects immediately when the session was already canceled', async () => {
    const { calls, run } = recordingRun([authResult()]);
    const abort = new AbortController();
    abort.abort();
    const tools = toolsWith({ run });
    await assert.rejects(
      tools.conductor_claude_review.execute({ packet: 'plan' }, { directory: 'C:/workspace', agent: 'build', abort: abort.signal }),
      /canceled/i
    );
    assert.equal(calls.length, 0);
  });

  test('rejects API-key, proxy, and non-subscription auth, naming what it found', async () => {
    for (const invalid of [
      { authMethod: 'api_key' },
      { apiProvider: 'bedrock' },
      { subscriptionType: 'api' },
      { loggedIn: false },
    ]) {
      const tools = toolsWith({ run: async () => authResult(invalid) });
      await assert.rejects(
        tools.conductor_claude_status.execute({}, { directory: 'C:/workspace', agent: 'build' }),
        /first-party Claude Pro or Max/i
      );
    }
    const tools = toolsWith({ run: async () => authResult({ authMethod: 'api_key' }) });
    await assert.rejects(
      tools.conductor_claude_status.execute({}, { directory: 'C:/workspace', agent: 'build' }),
      /found .*authMethod=api_key/i
    );
  });

  test('a failing auth check reports the exit code and redacted stderr detail', async () => {
    const tools = toolsWith({
      run: async () => ({ code: 1, stdout: '', stderr: 'keychain locked for user@example.com\nsecond line' }),
    });
    await assert.rejects(
      tools.conductor_claude_status.execute({}, { directory: 'C:/workspace', agent: 'build' }),
      (error) => {
        assert.match(error.message, /exit code 1/);
        assert.match(error.message, /keychain locked/);
        assert.doesNotMatch(error.message, /user@example\.com/);
        assert.doesNotMatch(error.message, /second line/);
        assert.match(error.message, /claude auth login/);
        return true;
      }
    );
  });

  test('a failing review run reports the exit code and stderr detail', async () => {
    const tools = toolsWith({
      run: async (options) => options.args[0] === 'auth'
        ? authResult()
        : { code: 2, stdout: '', stderr: 'error: unknown option --frobnicate' },
    });
    await assert.rejects(
      tools.conductor_claude_review.execute({ packet: 'plan' }, { directory: 'C:/workspace', agent: 'build' }),
      (error) => {
        assert.match(error.message, /exit code 2/);
        assert.match(error.message, /unknown option --frobnicate/);
        return true;
      }
    );
  });

  test('valid but non-object CLI JSON is a controlled error, not a crash', async () => {
    const nullAuth = await toolsWith({ run: async () => ({ code: 0, stdout: 'null', stderr: '' }) });
    await assert.rejects(
      nullAuth.conductor_claude_status.execute({}, { directory: 'C:/workspace', agent: 'build' }),
      /unexpected JSON/i
    );

    const primitiveReview = await toolsWith({
      run: async (options) => options.args[0] === 'auth'
        ? authResult()
        : { code: 0, stdout: '"PLAN_APPROVED"', stderr: '' },
    });
    await assert.rejects(
      primitiveReview.conductor_claude_review.execute({ packet: 'plan' }, { directory: 'C:/workspace', agent: 'build' }),
      /unexpected JSON/i
    );

    const arrayAuth = await toolsWith({ run: async () => ({ code: 0, stdout: '[]', stderr: '' }) });
    await assert.rejects(
      arrayAuth.conductor_claude_status.execute({}, { directory: 'C:/workspace', agent: 'build' }),
      /unexpected JSON/i
    );

    const malformed = await toolsWith({ run: async () => ({ code: 0, stdout: 'not json', stderr: '' }) });
    await assert.rejects(
      malformed.conductor_claude_status.execute({}, { directory: 'C:/workspace', agent: 'build' }),
      /invalid JSON/i
    );
  });

  test('rejects an unstructured review or a response from another model', async () => {
    const badSignal = await toolsWith({
      run: async (options) => options.args[0] === 'auth' ? authResult() : reviewResult('Looks good'),
    });
    await assert.rejects(
      badSignal.conductor_claude_review.execute({ packet: 'plan' }, { directory: 'C:/workspace', agent: 'build' }),
      /required PLAN_APPROVED or PLAN_REVISE/i
    );

    const wrongModel = await toolsWith({
      run: async (options) => options.args[0] === 'auth'
        ? authResult()
        : { ...reviewResult(), stdout: JSON.stringify({ result: 'PLAN_APPROVED', modelUsage: { 'claude-sonnet-5': {} } }) },
    });
    await assert.rejects(
      wrongModel.conductor_claude_review.execute({ packet: 'plan' }, { directory: 'C:/workspace', agent: 'build' }),
      /pinned claude-opus-5/i
    );
  });

  test('the model tamper check accepts only the exact id or a dated variant of it', async () => {
    // A shorter family name must not be satisfied by a longer model id.
    const shortName = await toolsWith({
      run: async (options) => options.args[0] === 'auth'
        ? authResult()
        : reviewResult('PLAN_APPROVED\nOk.', 'claude-opus-5'),
    });
    await assert.rejects(
      shortName.conductor_claude_review.execute(
        { packet: 'plan', model: 'claude-opus' },
        { directory: 'C:/workspace', agent: 'build' }
      ),
      /pinned claude-opus model/
    );

    // A date-stamped variant of the exact chosen id stays acceptable.
    const dated = await toolsWith({
      run: async (options) => options.args[0] === 'auth'
        ? authResult()
        : reviewResult('PLAN_APPROVED\nOk.', 'claude-opus-5-20260115'),
    });
    const output = await dated.conductor_claude_review.execute(
      { packet: 'plan' },
      { directory: 'C:/workspace', agent: 'build' }
    );
    assert.match(output, /PLAN_APPROVED/);
  });

  test('stderr redaction strips key-shaped tokens and applies to review errors too', async () => {
    const authLeak = await toolsWith({
      run: async () => ({ code: 1, stdout: '', stderr: 'rejected key sk-ant-api03-AbCdEfGh12 for user@example.com' }),
    });
    await assert.rejects(
      authLeak.conductor_claude_status.execute({}, { directory: 'C:/workspace', agent: 'build' }),
      (error) => {
        assert.doesNotMatch(error.message, /sk-ant-api03/);
        assert.doesNotMatch(error.message, /user@example\.com/);
        assert.match(error.message, /<redacted>/);
        return true;
      }
    );

    const reviewLeak = await toolsWith({
      run: async (options) => options.args[0] === 'auth'
        ? authResult()
        : { code: 2, stdout: '', stderr: 'auth for user@example.com failed' },
    });
    await assert.rejects(
      reviewLeak.conductor_claude_review.execute({ packet: 'plan' }, { directory: 'C:/workspace', agent: 'build' }),
      (error) => {
        assert.doesNotMatch(error.message, /user@example\.com/);
        assert.match(error.message, /<redacted>/);
        return true;
      }
    );
  });

  test('a missing claude executable produces an actionable install error', async () => {
    // No injected runner: this exercises the real spawn wrapper. The empty
    // PATH directory guarantees resolution fails on every platform.
    const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-claude-nobin-'));
    try {
      const tools = toolsWith({ environment: { PATH: emptyBin } });
      await assert.rejects(
        tools.conductor_claude_status.execute({}, { directory: 'C:/workspace', agent: 'build' }),
        (error) => {
          assert.match(error.message, /native build/i);
          assert.match(error.message, /npm shim/i);
          return true;
        }
      );
    } finally {
      fs.rmSync(emptyBin, { recursive: true, force: true });
    }
  });

  // A copy of the node binary named claude, plus NODE_OPTIONS --require, makes
  // the real spawn wrapper controllable: the required file runs before node
  // parses the claude-shaped args, so it can hang or spam output on demand.
  const fakeClaudeBin = (requireSource) => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-claude-lifebin-'));
    const fake = path.join(bin, process.platform === 'win32' ? 'claude.exe' : 'claude');
    fs.copyFileSync(process.execPath, fake);
    fs.chmodSync(fake, 0o755);
    const environment = {
      PATH: bin,
      SYSTEMROOT: process.env.SYSTEMROOT ?? process.env.SystemRoot ?? '',
      WINDIR: process.env.WINDIR ?? process.env.windir ?? '',
    };
    if (requireSource) {
      const hook = path.join(bin, 'hook.js');
      fs.writeFileSync(hook, requireSource);
      // Quote the hook path so spaces in temp dirs survive on Windows; use
      // forward slashes because NODE_OPTIONS parsing eats backslashes inside
      // quotes (Node treats \ as an escape), and forward slashes work on Win32.
      environment.NODE_OPTIONS = `--require "${hook.replace(/\\/g, '/')}"`;
    }
    return { bin, environment };
  };

  const BLOCK_FOREVER = 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);';

  // Deleting the fake-claude dir right after a kill can hit EPERM on Windows:
  // the pid is gone (process.kill(pid, 0) already throws) but the OS can hold
  // the .exe lock for a moment while the process finishes tearing down
  // (observed on windows-latest CI). Retry briefly before giving up.
  const removeBinDir = async (bin, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        fs.rmSync(bin, { recursive: true, force: true });
        return;
      } catch (error) {
        if (Date.now() > deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  };

  // Poll for the review/status child's pidfile instead of a fixed sleep - the
  // real spawn takes a variable amount of time to boot node on each platform.
  const readPidWhenReady = async (pidfile, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const raw = fs.readFileSync(pidfile, 'utf8').trim();
        if (raw) return Number(raw);
      } catch {
        /* not written yet */
      }
      if (Date.now() > deadline) throw new Error(`pidfile ${pidfile} never appeared`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  // Proves the kill actually terminated the hung child: process.kill(pid, 0)
  // throws once the process is gone.
  const waitForExit = async (pid, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        process.kill(pid, 0);
      } catch {
        return;
      }
      if (Date.now() > deadline) throw new Error(`process ${pid} still alive after ${timeoutMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  test('a mid-flight cancel kills the real child process and reports cancellation', async () => {
    const writePidThenBlock = `require("node:fs").writeFileSync(require("node:path").join(__dirname, "status.pid"), String(process.pid)); ${BLOCK_FOREVER}`;
    const { bin, environment } = fakeClaudeBin(writePidThenBlock);
    const pidfile = path.join(bin, 'status.pid');
    try {
      const abort = new AbortController();
      const tools = toolsWith({ environment });
      const pending = assert.rejects(
        tools.conductor_claude_status.execute({}, { directory: 'C:/workspace', agent: 'build', abort: abort.signal }),
        /canceled/i
      );
      const pid = await readPidWhenReady(pidfile);
      abort.abort();
      await pending;
      // The kill must have actually terminated the hung child, not just
      // rejected the promise.
      await waitForExit(pid);
    } finally {
      await removeBinDir(bin);
    }
  });

  // The tree-kill guarantee is Windows-specific (taskkill /T); on POSIX the
  // bridge kills only the direct child, so this proof is skipped there.
  test('canceling kills the whole process tree, including a detached grandchild', { skip: process.platform !== 'win32' }, async () => {
    // Claude Code is a multi-process CLI. The fake child spawns a detached
    // grandchild (plain node blocking forever, NODE_OPTIONS stripped so the
    // hook does not recurse) and then blocks itself; after the cancel BOTH
    // pids must be gone, which on Windows only a tree kill can guarantee.
    const hookSource = [
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      'const { spawn } = require("node:child_process");',
      'fs.writeFileSync(path.join(__dirname, "tree-child.pid"), String(process.pid));',
      'const env = { ...process.env };',
      'delete env.NODE_OPTIONS;',
      `const grandchild = spawn(process.execPath, ["-e", ${JSON.stringify(BLOCK_FOREVER)}], { detached: true, stdio: "ignore", env });`,
      'fs.writeFileSync(path.join(__dirname, "tree-grandchild.pid"), String(grandchild.pid));',
      BLOCK_FOREVER,
    ].join('\n');
    const { bin, environment } = fakeClaudeBin(hookSource);
    try {
      const abort = new AbortController();
      const tools = toolsWith({ environment });
      const pending = assert.rejects(
        tools.conductor_claude_status.execute({}, { directory: 'C:/workspace', agent: 'build', abort: abort.signal }),
        /canceled/i
      );
      const childPid = await readPidWhenReady(path.join(bin, 'tree-child.pid'));
      const grandchildPid = await readPidWhenReady(path.join(bin, 'tree-grandchild.pid'));
      abort.abort();
      await pending;
      await waitForExit(childPid);
      await waitForExit(grandchildPid, 10000);
    } finally {
      await removeBinDir(bin);
    }
  });

  test('a slow auth check times out and reports the configured budget', async () => {
    const { bin, environment } = fakeClaudeBin(BLOCK_FOREVER);
    try {
      const tools = toolsWith({ environment, timeouts: { authMs: 1000 } });
      await assert.rejects(
        tools.conductor_claude_status.execute({}, { directory: 'C:/workspace', agent: 'build' }),
        /timed out after 1 second/
      );
    } finally {
      await removeBinDir(bin);
    }
  });

  test('a cancel between auth and review kills the hung review child', async () => {
    // Dual-phase fake: the auth call answers with a valid first-party status
    // and exits before node treats "auth" as a script; the review call writes
    // its pid and blocks forever so the test can cancel it and prove the kill.
    const authJson = authResult().stdout;
    const hookSource = [
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      'if (process.argv.includes("auth")) {',
      `  fs.writeSync(1, ${JSON.stringify(authJson)});`,
      '  process.exit(0);',
      '}',
      'fs.writeFileSync(path.join(__dirname, "review.pid"), String(process.pid));',
      BLOCK_FOREVER,
    ].join('\n');
    const { bin, environment } = fakeClaudeBin(hookSource);
    const pidfile = path.join(bin, 'review.pid');
    try {
      const abort = new AbortController();
      const tools = toolsWith({ environment });
      const pending = assert.rejects(
        tools.conductor_claude_review.execute({ packet: 'plan' }, { directory: 'C:/workspace', agent: 'build', abort: abort.signal }),
        /canceled/i
      );
      const pid = await readPidWhenReady(pidfile);
      abort.abort();
      await pending;
      await waitForExit(pid);
    } finally {
      await removeBinDir(bin);
    }
  });

  test('sends the documented time and output budgets to the runner', async () => {
    const { calls, run } = recordingRun([authResult(), reviewResult()]);
    const tools = toolsWith({ run });
    await tools.conductor_claude_review.execute({ packet: 'plan' }, { directory: 'C:/workspace', agent: 'build' });
    assert.equal(calls[0].timeoutMs, 20000);
    assert.equal(calls[0].maxOutputBytes, 64 * 1024);
    assert.equal(calls[1].timeoutMs, 600000);
    assert.equal(calls[1].maxOutputBytes, 2 * 1024 * 1024);
  });

  test('a Max subscription is reported as ready', async () => {
    const tools = toolsWith({ run: async () => authResult({ subscriptionType: 'max' }) });
    const output = await tools.conductor_claude_status.execute({}, { directory: 'C:/workspace', agent: 'build' });
    assert.match(output, /MAX/);
  });

  test('output beyond the byte limit kills the real child process with a clear error', async () => {
    // fs.writeSync on fd 1 with a retry loop, NOT process.stdout.write: on
    // POSIX, stdout to a pipe is async, and the blocked event loop below
    // would strand whatever did not fit the pipe buffer on the first try -
    // observed on macOS CI, where the 80 KiB spam arrived short of the 64 KiB
    // limit and the test timed out instead of overflowing. The blocking
    // writeSync loop delivers every byte before the child freezes.
    const spamThenBlock = [
      'const fs = require("node:fs");',
      'const spam = Buffer.alloc(80 * 1024, 97);',
      'let off = 0;',
      'while (off < spam.length) {',
      '  try { off += fs.writeSync(1, spam, off); }',
      '  catch (e) { if (e.code !== "EAGAIN") throw e; }',
      '}',
      BLOCK_FOREVER,
    ].join('\n');
    const { bin, environment } = fakeClaudeBin(spamThenBlock);
    try {
      const tools = toolsWith({ environment });
      await assert.rejects(
        tools.conductor_claude_status.execute({}, { directory: 'C:/workspace', agent: 'build' }),
        /more output than the bridge allows/i
      );
    } finally {
      await removeBinDir(bin);
    }
  });

  test('a real child process failure propagates its exit code through the spawn wrapper', async () => {
    // A copy of the node binary named claude exercises the real spawn, pipe
    // collection, and close handling: `node auth status --json` exits nonzero
    // with a module-not-found error on stderr.
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-claude-fakebin-'));
    const fake = path.join(bin, process.platform === 'win32' ? 'claude.exe' : 'claude');
    fs.copyFileSync(process.execPath, fake);
    fs.chmodSync(fake, 0o755);
    try {
      const tools = toolsWith({
        environment: {
          PATH: bin,
          // node.exe needs SystemRoot to boot on Windows; harmless elsewhere.
          SYSTEMROOT: process.env.SYSTEMROOT ?? process.env.SystemRoot ?? '',
          WINDIR: process.env.WINDIR ?? process.env.windir ?? '',
        },
      });
      await assert.rejects(
        tools.conductor_claude_status.execute({}, { directory: 'C:/workspace', agent: 'build' }),
        (error) => {
          assert.match(error.message, /exit code 1/);
          assert.match(error.message, /module|MODULE|auth/i);
          return true;
        }
      );
    } finally {
      await removeBinDir(bin);
    }
  });
});
