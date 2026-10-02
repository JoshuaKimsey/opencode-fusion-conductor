// Plugin entry point (OpenCode V2).
//
// A V2 plugin default-exports a definition with a stable id; setup()
// registers agent/command/tool transforms, session hooks, and event
// subscriptions through the plugin context. Plugin options come from
// ctx.options: { profile, models, audit, claude } as documented in README.md.

import { Plugin } from "@opencode/plugin";
import { registerConductor, resolvePluginOptions } from "./config.js";

export default Plugin.define({
  id: "opencode-fusion-conductor",
  async setup(ctx) {
    const opts = resolvePluginOptions(ctx);
    return registerConductor(ctx, opts);
  },
});
