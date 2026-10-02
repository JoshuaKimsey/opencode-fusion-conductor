// Permission-shape conversion for the Conductor V2 port.
//
// The canonical per-agent rules still live as V1-style maps in agents.js
// (ordered keys, bash/task sub-maps) because that form keeps the exact
// wildcard-first ordering the original contracts were reviewed against.
// This module converts those maps to OpenCode V2 ordered `permissions`
// arrays at injection time:
//
//   scalar tool key (edit, grep, glob, list, read, webfetch, websearch,
//     skill, external_directory, conductor_*) -> { action: key, resource: "*", effect }
//   bash: "<pattern>" -> shell rules, "bash" deny-all string -> shell deny-all
//   task: "<agent>"  -> subagent rules, "task" deny-all string -> subagent deny-all
//
// V1 action renames applied: bash -> shell, task -> subagent
// (write/patch need no mapping: V2 folds them into the edit action, and the
// source maps never mention them).
// The conductor_configure/conductor_status tool rules are appended last.
// They only match their own action, so position is irrelevant under V2's
// last-match-wins evaluation; the in-tool caller gate
// (requireConductorCaller) enforces the build/plan-only contract regardless.

const SHELL_ACTION = "shell";
const SUBAGENT_ACTION = "subagent";
const WILDCARD = "*";

export function toPermissions(v1Permission, conductorEffect) {
  const rules = [];
  for (const [key, value] of Object.entries(v1Permission ?? {})) {
    if (key === "bash") {
      if (typeof value === "string") {
        rules.push({ action: SHELL_ACTION, resource: WILDCARD, effect: value });
      } else {
        for (const [pattern, effect] of Object.entries(value)) {
          rules.push({ action: SHELL_ACTION, resource: pattern, effect });
        }
      }
    } else if (key === "task") {
      if (typeof value === "string") {
        rules.push({ action: SUBAGENT_ACTION, resource: WILDCARD, effect: value });
      } else {
        for (const [agent, effect] of Object.entries(value)) {
          rules.push({ action: SUBAGENT_ACTION, resource: agent, effect });
        }
      }
    } else {
      rules.push({ action: key, resource: WILDCARD, effect: value });
    }
  }
  rules.push({ action: "conductor_configure", resource: WILDCARD, effect: conductorEffect });
  rules.push({ action: "conductor_status", resource: WILDCARD, effect: conductorEffect });
  return rules;
}
