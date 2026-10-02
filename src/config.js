// Conductor registration for OpenCode V2.
//
// V2 plugins cannot mutate a global config object. Instead setup() registers
// transforms on the domains that own each surface:
//   agents  -> ctx.agent.transform (upsert the seven team roles; update()
//              creates agents that do not exist yet, so the custom sidekick,
//              research, design, reviewer, and vision roles are registered the
//              same way the builtins build/plan are overridden)
//   explore -> model-only update, preserving the built-in definition
//   title   -> small_model from the profile becomes agents.title.model
//   default model -> ctx.model.transform default.set(providerID, modelID)
//   command -> ctx.command.transform (/conductor)
//   tools   -> ctx.tool.transform (conductor_configure/status, +claude bridge)
//   guard   -> ctx.session.hook("context") strips edit/write/patch/grep/glob
//              from build/plan model requests, restoring the V1 schema-removal
//              feel on top of the deny rules
//   audit   -> ctx.event.subscribe, opt-in via { audit: true }
//
// resolveAgentDefinitions() is pure and unit-tested: options.models[role]
// overrides the profile's agents map per role, unknown profiles throw with
// the available names.

import { AGENTS } from "./agents.js";
import { COMMANDS } from "./commands.js";
import { resolveRoleModels, parseModelRef } from "./resolve.js";
import { toPermissions } from "./permissions.js";
import { conductorToolDefs } from "./tools/index.js";
import { claudeTools } from "./claude.js";
import { guardContextHook } from "./guard.js";
import { registerAudit } from "./audit.js";
import { findPluginEntry, isPlainObject, copyObject } from "./tools/config-file.js";

export const ROLES = ["build", "plan", "sidekick", "research", "design", "reviewer", "vision"];

// Resolve the plugin options for this instance.
//
// Explicit ctx.options win (the normal case: an npm/Git package entry with an
// options object). When the plugin loads without configured options - notably
// through `.opencode/plugins/` or `~/.config/opencode/plugins/` discovery,
// which carries no options - fall back to the plugin's own opencode.json
// entry (both the V1 "plugin" tuple form and the V2 "plugins" object form),
// so a discovery-loaded install still honors a stored profile. Anything else
// (no entry anywhere) means unconfigured.
export function resolvePluginOptions(ctx) {
  const explicit = ctx?.options && typeof ctx.options === "object" ? ctx.options : {};
  if (Object.keys(explicit).length > 0) return { ...explicit };
  const directory =
    typeof ctx?.location?.directory === "string" && ctx.location.directory
      ? ctx.location.directory
      : process.cwd();
  const found = findPluginEntry(directory);
  if (found.found && isPlainObject(found.options)) return copyObject(found.options);
  return {};
}

export function resolveAgentDefinitions(options = {}) {
  const opts = { ...options };
  const { profile, byRole } = resolveRoleModels(opts.profile, opts.models ?? {});

  const defs = {};
  for (const role of ROLES) {
    const src = AGENTS[role];
    const def = {
      description: src.description,
      mode: src.mode,
      system: src.system,
      permissions: toPermissions(src.permission, role === "build" || role === "plan" ? "allow" : "deny"),
    };
    if (src.hidden) def.hidden = true;
    if (byRole[role]) def.model = parseModelRef(byRole[role]);
    defs[role] = def;
  }

  const out = { defs, profile };
  if (byRole.explore) out.exploreModel = parseModelRef(byRole.explore);
  if (byRole.build) out.defaultModel = parseModelRef(byRole.build);
  if (profile?.small_model) out.titleModel = parseModelRef(profile.small_model);
  return out;
}

function applyAgentDef(agent, def) {
  agent.description = def.description;
  agent.mode = def.mode;
  agent.system = def.system;
  agent.permissions = def.permissions;
  if (def.hidden !== undefined) agent.hidden = def.hidden;
  if (def.model !== undefined) agent.model = def.model;
  return agent;
}

export async function registerConductor(ctx, options = {}) {
  const opts = { ...options };
  const { defs, exploreModel, defaultModel, titleModel } = resolveAgentDefinitions(opts);

  await ctx.agent.transform((editor) => {
    for (const role of ROLES) {
      const def = defs[role];
      editor.update(role, (agent) => applyAgentDef(agent, def));
    }
    // explore is built-in: never replace its definition, only assign a model
    // when one resolved for it.
    if (exploreModel) {
      const existing = editor.get("explore");
      if (existing) editor.update("explore", (agent) => { agent.model = exploreModel; });
    }
    // V2 folds small_model into the built-in title agent.
    if (titleModel) {
      editor.update("title", (agent) => { agent.model = titleModel; });
    }
  });

  // The default session model follows the build (main) model, as config.model
  // did on V1.
  if (defaultModel) {
    await ctx.model.transform((editor) => {
      editor.default.set(defaultModel.providerID, defaultModel.id);
    });
  }

  await ctx.command.transform((editor) => {
    editor.add({
      name: "conductor",
      description: COMMANDS.conductor.description,
      execute: async (invocation) => {
        const args = invocation.prompt?.text?.trim() ?? "";
        const text = COMMANDS.conductor.template.replaceAll("$ARGUMENTS", args);
        await ctx.session.prompt({
          ...invocation.prompt,
          sessionID: invocation.sessionID,
          text,
          delivery: invocation.delivery,
        });
      },
    });
  });

  await ctx.tool.transform((editor) => {
    for (const def of conductorToolDefs(ctx, opts)) editor.add(def);
    if (opts.claude) {
      for (const def of Object.values(claudeTools())) editor.add(def);
    }
  });

  await ctx.session.hook("context", guardContextHook);

  // Optional audit subscription. Its cleanup aborts the event loop.
  return registerAudit(ctx, opts);
}
