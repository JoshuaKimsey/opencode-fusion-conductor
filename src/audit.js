// conductor-audit: read-only observability for the Conductor delegation tree.
//
// opencode's tool hooks do NOT expose the calling agent, so this module cannot
// enforce who-does-what (permissions do that). It logs the shape of
// delegation - subagent sessions as they spawn, and edit/write/apply_patch/
// subagent tool calls - so a maintainer can audit that the main agent
// delegated instead of editing. This is an aid on top of the ground-truth
// session DB.
//
// Audit is opt-in: auditHook returns the event handler only when
// options.audit === true, otherwise undefined so setup registers nothing.
// registerAudit wires the handler to ctx.event.subscribe() and returns a
// cleanup function that aborts the subscription.
//
// V1 normalized the V1 `event` hook payload ({ event }). V2 subscription items
// carry the same type discriminant; the payload may sit under `properties`
// (V1 shape) or `data` - normalize() accepts both, and anything unrecognized
// is ignored without throwing or logging.

export function normalizeEvent(event) {
  if (!event || typeof event !== "object") return undefined;
  if (event.properties !== undefined || event.data === undefined) return event;
  return { ...event, properties: event.data };
}

export function auditHook(options, log) {
  const opts = options ?? {};
  if (opts.audit !== true) return undefined;

  const emit = typeof log === "function"
    ? log
    : (message, extra) => console.log(JSON.stringify({ service: "conductor-audit", message, extra }));
  const messagesBySession = new Map();

  return async ({ event }) => {
    const normalized = normalizeEvent(event);
    if (!normalized) return;
    const type = normalized.type;
    const properties = normalized.properties ?? {};
    if (type === "session.created") {
      const info = properties.info ?? {};
      // A child session (has parentID) is a delegation. Root sessions have none.
      if (info.parentID) {
        emit("subagent session spawned", {
          sessionID: info.id,
          parentID: info.parentID,
          title: info.title,
        });
      }
    }
    if (type === "message.updated") {
      const info = properties.info;
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
    if (type === "message.part.updated") {
      // Tool executions arrive on the event stream as tool parts reaching their
      // completed state. Surface the file-mutating and delegation tools for the
      // audit trail; "apply_patch" is the third mutation tool gated by the edit
      // permission. Read-only tools stay out. (V1 called the delegation tool
      // "task"; V2 renamed it "subagent" - log both spellings.)
      const part = properties.part;
      if (
        part?.type === "tool" &&
        part.state?.status === "completed" &&
        (part.tool === "edit" ||
          part.tool === "write" ||
          part.tool === "apply_patch" ||
          part.tool === "task" ||
          part.tool === "subagent")
      ) {
        emit("tool executed", { tool: part.tool, sessionID: properties.sessionID });
      }
    }
    if (type === "session.idle") {
      const sessionID = properties.sessionID;
      const messages = messagesBySession.get(sessionID);
      if (!messages?.size) return;

      const totals = new Map();
      for (const item of messages.values()) {
        const key = `${item.agent}${item.modelID}`;
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
      emit("session token usage", { sessionID, usage });
    }
  };
}

export async function registerAudit(ctx, options = {}, log) {
  const handler = auditHook(options, log);
  if (!handler) return undefined;
  const controller = new AbortController();
  void (async () => {
    for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
      try {
        await handler({ event });
      } catch {
        // Observability must never break a session.
      }
    }
  })();
  return () => controller.abort();
}
