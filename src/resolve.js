// Shared role -> model resolution for the Conductor plugin. This is exactly
// the resolution applyConductor applies at startup: an options.models override
// wins for a role, otherwise the selected profile's agents map supplies it.
// applyConductor and the conductor_status tool both read from this module so
// the reported "effective" models always match what the plugin would inject on
// the next restart. An unknown profile throws the same error applyConductor
// always threw, and the truthy-check semantics are preserved verbatim.

import { PROFILES } from "./profiles.js";
import { KNOWN_ROLES } from "./constants.js";

export function resolveRoleModels(profileName, models = {}) {
  let profile;
  if (profileName !== undefined) {
    profile = PROFILES[profileName];
    if (!profile) {
      throw new Error(
        `Unknown conductor profile "${profileName}". Available profiles: ${Object.keys(PROFILES).join(", ")}`
      );
    }
  }
  const byRole = {};
  for (const role of KNOWN_ROLES) {
    if (models[role]) byRole[role] = models[role];
    else if (profile?.agents?.[role]) byRole[role] = profile.agents[role];
  }
  return { profile, byRole };
}

// Parse a "provider/model-id" or "provider/model-id#variant" reference into
// the V2 Agent.Info model object shape { providerID, id, variant? } used by
// agent transforms (ctx.agent) and the model default (ctx.model).
export function parseModelRef(ref) {
  if (typeof ref !== "string") {
    throw new Error(`Model reference must be a string, got ${JSON.stringify(ref)}`);
  }
  const hash = ref.indexOf("#");
  const base = hash === -1 ? ref : ref.slice(0, hash);
  const variant = hash === -1 ? undefined : ref.slice(hash + 1);
  const slash = base.indexOf("/");
  if (slash <= 0 || slash === base.length - 1 || base.includes(" ", slash)) {
    throw new Error(`Model reference must be "provider/model-id" (optional "#variant"), got ${JSON.stringify(ref)}`);
  }
  const providerID = base.slice(0, slash);
  const id = base.slice(slash + 1);
  if (!providerID || !id || /\s/.test(base)) {
    throw new Error(`Model reference must be "provider/model-id" (optional "#variant"), got ${JSON.stringify(ref)}`);
  }
  return variant ? { providerID, id, variant } : { providerID, id };
}