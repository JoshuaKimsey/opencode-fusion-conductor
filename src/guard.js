// Schema-removal guard for the Conductor team (OpenCode V2).
//
// V2 permission `deny` rules block tool calls at execution time, but the
// denied tools may still be offered to the model in its tool schema. The V1
// plugin relied on opencode removing denied tools from the schema entirely,
// so this hook restores that half of the mechanical guarantee: for build and
// plan model requests it deletes the file-mutating and codebase-search tools
// from the outgoing request, leaving delegation via `subagent` as the only
// path to changing or searching files. Review-only `read` stays, and every
// other agent is untouched.

const STRIPPED_TOOLS = ["edit", "write", "patch", "grep", "glob", "list"];

export function guardContextHook(event) {
  if (event?.agent !== "build" && event?.agent !== "plan") return;
  if (!event?.tools || typeof event.tools !== "object") return;
  for (const name of STRIPPED_TOOLS) {
    if (name in event.tools) delete event.tools[name];
  }
}
