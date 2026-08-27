// The two custom tools that back the /conductor slash command. options is
// currently unused by both tools (they read everything from the runtime
// context and the config file) but is accepted for future use.

import { configureTool } from "./configure.js";
import { statusTool } from "./status.js";

export function conductorTools(options) {
  return {
    conductor_configure: configureTool(),
    conductor_status: statusTool(),
  };
}