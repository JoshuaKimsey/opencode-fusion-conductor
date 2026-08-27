// conductor_status: read-only health/config report for the Conductor setup.
// Never writes anything. Reports where the plugin entry lives and its raw
// options, the effective role -> model resolution (same logic as the startup
// config hook, via resolveRoleModels), migration hazards from a previous
// fusion install, and the pinned plugin version. Every filesystem read is
// tolerant: missing files and directories are reported as absent, never thrown.

import fs from "node:fs";
import path from "node:path";
import { tool } from "@opencode-ai/plugin";
import { PACKAGE_NAME, KNOWN_ROLES } from "../constants.js";
import { resolveRoleModels } from "../resolve.js";
import {
  configDir,
  copyObject,
  findPluginEntry,
  isPlainObject,
  requireConductorCaller,
} from "./config-file.js";

// Leftover file-based agents from the old fusion install override the
// plugin-injected agent config field-by-field, so their presence is a hazard.
const LEFT_OVER_AGENT_ROLES = [
  "build",
  "plan",
  "sidekick",
  "research",
  "design",
  "reviewer",
  "vision",
];
const LEFT_OVER_PLUGINS = ["fusion-audit.js", "fusion-claude.js"];

export function statusTool() {
  return tool({
    description:
      "Read-only status report for the Conductor setup: which opencode.json holds the plugin entry and its options, the effective role -> model resolution, leftover fusion-install hazards, and the pinned plugin version. Never modifies any file.",
    args: {},
    async execute(_args, context) {
      requireConductorCaller(context);
      const directory = context?.directory || process.cwd();
      return statusReport(directory);
    },
  });
}

function statusReport(directory) {
  const lines = [];
  lines.push("Conductor status");
  lines.push(`Plugin: ${PACKAGE_NAME}`);

  // (a) Config file holding the plugin entry + the raw options found there.
  const found = findPluginEntry(directory);
  let storedOptions = {};
  if (found.found) {
    storedOptions = copyObject(isPlainObject(found.options) ? found.options : {});
    lines.push(`Config file: ${found.file}`);
    lines.push(
      `Plugin entry: ${found.spec}${found.version ? ` (version pin: ${found.version})` : " (no version pin)"}`
    );
    lines.push(
      `Stored options: ${Object.keys(storedOptions).length ? JSON.stringify(storedOptions) : "none"}`
    );
  } else if (found.reason === "jsonc") {
    lines.push(`Config file: ${found.file} (JSONC - cannot be parsed by this tool)`);
    lines.push("Plugin entry: unknown - edit the .jsonc by hand");
  } else if (found.reason === "parse-error") {
    lines.push(`Config file: ${found.file} (present but not valid JSON: ${found.error.message})`);
  } else if (found.reason === "unreadable") {
    lines.push(`Config file: ${found.file} (present but could not be read: ${found.error.message})`);
  } else {
    lines.push(`Config file: not found (checked ${found.checked.join(", ")})`);
  }

  // (b) Effective role -> model resolution, identical to applyConductor.
  const models = isPlainObject(storedOptions.models) ? storedOptions.models : {};
  let byRole;
  try {
    byRole = resolveRoleModels(storedOptions.profile, models).byRole;
  } catch (error) {
    lines.push(`  WARN: ${error.message}`);
    byRole = resolveRoleModels(undefined, models).byRole;
  }
  lines.push("Effective role models:");
  for (const role of KNOWN_ROLES) {
    lines.push(`  ${role}: ${byRole[role] ?? "unset"}`);
  }

  // (c) Migration hazards from a previous fusion install.
  lines.push("Migration hazards:");
  const hazards = [];
  const globalDir = configDir();
  const agentDir = path.join(globalDir, "agent");
  const leftoverAgents = LEFT_OVER_AGENT_ROLES.filter((role) =>
    fs.existsSync(path.join(agentDir, `${role}.md`))
  );
  if (leftoverAgents.length) {
    hazards.push(
      `Leftover file-based agents override plugin-injected agent config field-by-field: ${leftoverAgents
        .map((role) => `${agentDir}/${role}.md`)
        .join(", ")}. Delete them (or run the old "undo fusion" skill first).`
    );
  }
  const pluginsDir = path.join(globalDir, "plugins");
  const leftoverPlugins = LEFT_OVER_PLUGINS.filter((name) =>
    fs.existsSync(path.join(pluginsDir, name))
  );
  if (leftoverPlugins.length) {
    hazards.push(
      `Old fusion plugin files still installed: ${leftoverPlugins
        .map((name) => `${pluginsDir}/${name}`)
        .join(", ")}.`
    );
  }
  const fusionManifest = path.join(globalDir, ".fusion-install.json");
  if (fs.existsSync(fusionManifest)) {
    hazards.push(
      `Old fusion install present (${fusionManifest}). Say "undo fusion" with the old fusion-setup skill first.`
    );
  }
  if (hazards.length === 0) hazards.push("none detected");
  for (const hazard of hazards) lines.push(`  ${hazard}`);

  return lines.join("\n");
}