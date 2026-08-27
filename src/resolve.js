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