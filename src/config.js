// Config injection for the Conductor plugin. Mutates the passed config in
// place (opencode's plugin config hook hands over the config object to modify
// at startup) and returns it for convenience.
//
// Per-role model resolution order: options.models[role] overrides the
// profile's agents map. Unknown profiles throw with the available names.

import { AGENTS } from "./agents.js";
import { COMMANDS } from "./commands.js";
import { resolveRoleModels } from "./resolve.js";

const ROLES = ["build", "plan", "sidekick", "research", "design", "reviewer", "vision"];

/**
 * Build a copy of an agent's permission map with the conductor_configure and
 * conductor_status custom-tool keys inserted before the bash key (or appended
 * when there is no bash key). Placement stays at permission.tool level - never
 * inside the bash or task maps - and after any wildcard entries so the specific
 * tool permissions win under opencode's last-match-wins resolution. The source
 * permission maps have no top-level "*" key, so the insertion point before
 * `bash` keeps the conductor keys with the other scalar tool permissions.
 */
function withConductorToolPermissions(permission, value) {
  const out = {};
  let inserted = false;
  for (const [key, val] of Object.entries(permission)) {
    if (!inserted && key === "bash") {
      out.conductor_configure = value;
      out.conductor_status = value;
      inserted = true;
    }
    out[key] = val;
  }
  if (!inserted) {
    out.conductor_configure = value;
    out.conductor_status = value;
  }
  return out;
}

export function applyConductor(config, options = {}) {
  const opts = { ...options };
  // Per-role resolution is shared with the conductor_status tool (see
  // resolve.js): an options.models override wins per role, otherwise the
  // profile's agents map supplies it. Unknown profiles throw with the
  // available names, exactly as before.
  const { profile, byRole } = resolveRoleModels(opts.profile, opts.models ?? {});

  config.agent = config.agent ?? {};

  for (const role of ROLES) {
    const agent = { ...AGENTS[role] };
    agent.permission = withConductorToolPermissions(
      agent.permission,
      role === "build" || role === "plan" ? "allow" : "deny"
    );
    const resolvedModel = byRole[role];
    if (resolvedModel) agent.model = resolvedModel;
    config.agent[role] = agent;
  }

  // explore is built-in: never inject a full definition, only a model when one
  // resolved for it (preserving any existing explore entry).
  const exploreModel = byRole.explore;
  if (exploreModel) {
    config.agent.explore = { ...(config.agent.explore ?? {}), model: exploreModel };
  }

  const buildModel = byRole.build;
  if (buildModel) {
    config.model = buildModel;
  }
  if (profile && profile.small_model) {
    config.small_model = profile.small_model;
  }

  config.subagent_depth = Math.max(2, config.subagent_depth ?? 0);

  config.command = config.command ?? {};
  config.command.conductor = COMMANDS.conductor;

  return config;
}