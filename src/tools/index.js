// The custom tools that back the /conductor slash command. Factories take the
// plugin context for session-aware directory resolution; plain definitions
// are returned for registration through ctx.tool.transform.

import { configureTool } from "./configure.js";
import { statusTool } from "./status.js";

export function conductorToolDefs(ctx, options) {
  void options;
  return [configureTool(ctx), statusTool(ctx)];
}
