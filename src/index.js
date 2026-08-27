// Plugin entry point. opencode treats EVERY export of this module as a plugin,
// so Conductor must be the only export. The loader calls it as
// Conductor(input, options) where options is the tuple options from
// config "plugin": [["@joshuakimsey/opencode-conductor@1.0.0", { ...options }]].

import { applyConductor } from "./config.js";
import { conductorTools } from "./tools/index.js";
import { auditHook } from "./audit.js";
import { claudeTools } from "./claude.js";

export const Conductor = async (input, options) => {
  const opts = options ?? {};
  const event = auditHook(input, opts);
  return {
    config: async (cfg) => applyConductor(cfg, opts),
    tool: { ...conductorTools(opts), ...(opts.claude ? claudeTools(opts) : {}) },
    ...(event ? { event } : {}),
  };
};