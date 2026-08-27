// conductor-audit: read-only observability for the Conductor delegation tree.
// Ported from the legacy fusion-audit plugin. opencode's tool
// hooks do NOT expose the calling agent, so this plugin cannot enforce
// who-does-what (permissions do that). It logs the shape of delegation -
// subagent sessions as they spawn, and edit/write/apply_patch/task tool calls -
// so a maintainer can audit that the main agent delegated instead of editing.
// Logs go through input.client.app.log (service "conductor-audit"); view them
// in opencode's logs. This is an aid on top of the ground-truth session DB.
//
// Audit is opt-in: auditHook returns the event hook only when
// options.audit === true, otherwise undefined so the plugin registers no hook.
//
// src/index.js wires this module's return value as the plugin's single "event"
// hook, and opencode 1.18 dispatches tool-execution logging through the
// separate "tool.execute.after" trigger hook instead. A pure event hook
// observes tool executions via "message.part.updated" events whose part is a
// tool part reaching its final "completed" state - the same one-log-per-call
// behavior the source plugin got from tool.execute.after. Failed tool calls
// end in the "error" state and are not logged, matching the source (whose
// tool.execute.after fires only after a successful execute).

export function auditHook(input, options) {
  const opts = options ?? {};
  if (opts.audit !== true) return undefined;

  const client = input?.client;
  const log = (message, extra) => {
    if (!client?.app?.log) return;
    client.app.log({ body: { service: "conductor-audit", level: "info", message, extra } });
  };
  const messagesBySession = new Map();

  return async ({ event }) => {
    if (!event) return;
    if (event.type === "session.created") {
      const info = event.properties?.info ?? {};
      // A child session (has parentID) is a delegation. Root sessions have none.
      if (info.parentID) {
        log("subagent session spawned", {
          sessionID: info.id,
          parentID: info.parentID,
          title: info.title,
        });
      }
    }
    if (event.type === "message.updated") {
      const info = event.properties?.info;
      const tokens = info?.tokens;
      const values = [
        tokens?.input,
        tokens?.output,
        tokens?.reasoning,
        tokens?.cache?.read,
        tokens?.cache?.write,
      ];
      if (
        info?.role !== "assistant" ||
        typeof info.id !== "string" ||
        typeof info.sessionID !== "string" ||
        typeof info.mode !== "string" ||
        typeof info.modelID !== "string" ||
        !values.every(Number.isFinite)
      ) return;

      const messages = messagesBySession.get(info.sessionID) ?? new Map();
      messages.set(info.id, {
        agent: info.mode,
        modelID: info.modelID,
        providerID: typeof info.providerID === "string" ? info.providerID : undefined,
        input: tokens.input,
        output: tokens.output,
        reasoning: tokens.reasoning,
        cacheRead: tokens.cache.read,
        cacheWrite: tokens.cache.write,
        cost: Number.isFinite(info.cost) ? info.cost : undefined,
      });
      messagesBySession.set(info.sessionID, messages);
    }
    if (event.type === "message.part.updated") {
      // Tool executions arrive on the event stream as tool parts reaching their
      // completed state. Surface the file-mutating and delegation tools for the
      // audit trail; "apply_patch" is the third mutation tool gated by the edit
      // permission. Read-only tools stay out.
      const part = event.properties?.part;
      if (
        part?.type === "tool" &&
        part.state?.status === "completed" &&
        (part.tool === "edit" ||
          part.tool === "write" ||
          part.tool === "apply_patch" ||
          part.tool === "task")
      ) {
        log("tool executed", { tool: part.tool, sessionID: event.properties?.sessionID });
      }
    }
    if (event.type === "session.idle") {
      const sessionID = event.properties?.sessionID;
      const messages = messagesBySession.get(sessionID);
      if (!messages?.size) return;

      const totals = new Map();
      for (const item of messages.values()) {
        const key = `${item.agent}\u0000${item.modelID}`;
        const total = totals.get(key) ?? {
          agent: item.agent,
          modelID: item.modelID,
          ...(item.providerID ? { providerID: item.providerID } : {}),
          input: 0,
          output: 0,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0,
        };
        total.input += item.input;
        total.output += item.output;
        total.reasoning += item.reasoning;
        total.cacheRead += item.cacheRead;
        total.cacheWrite += item.cacheWrite;
        if (item.cost !== undefined) total.cost = (total.cost ?? 0) + item.cost;
        totals.set(key, total);
      }

      messagesBySession.delete(sessionID);
      const usage = [...totals.values()].sort(
        (a, b) => a.agent.localeCompare(b.agent) || a.modelID.localeCompare(b.modelID)
      );
      log("session token usage", { sessionID, usage });
    }
  };
}