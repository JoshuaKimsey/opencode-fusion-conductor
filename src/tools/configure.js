// conductor_configure: deterministically edit the plugin's own options entry
// in opencode.json so users can swap role models without re-running any
// installer. Only the options of the entry that named this plugin ever change;
// every other config key keeps its value. A rolling backup
// (opencode.json.conductor-backup) is written before any change, the write is
// atomic (temp file + rename), the original permission mode is preserved, and
// the pinned "@version" on the entry is kept exactly as found.

import fs from "node:fs";
import { tool } from "@opencode-ai/plugin";
import { PACKAGE_NAME, KNOWN_ROLES } from "../constants.js";
import { PROFILES } from "../profiles.js";
import {
  assign,
  atomicWrite,
  backupPathFor,
  copyObject,
  findPluginEntry,
  isPlainObject,
  requireConductorCaller,
} from "./config-file.js";

const MODEL_PATTERN = /^[^\s/]+\/[^\s/]+$/;
const OPTION_KEYS = ["profile", "models", "remove", "audit", "claude"];

export function configureTool() {
  return tool({
    description:
      "Configure the Conductor agent team by editing this plugin's own options entry in opencode.json: set the subscription profile, per-role model overrides, and the audit/claude feature flags. Only the conductor plugin entry's options change; everything else in the config is preserved. A backup (opencode.json.conductor-backup) is written before any change, and opencode must be restarted for the change to take effect.",
    args: {
      profile: tool.schema
        .string()
        .describe("Subscription profile name, e.g. opencode-go or chatgpt. Replaces the stored options.profile.")
        .optional(),
      models: tool.schema
        .record(tool.schema.string(), tool.schema.string())
        .describe('Per-role model overrides as role -> "provider/model-id", e.g. { sidekick: "openai/gpt-5.6-luna" }. Merges key-wise into the stored options.models.')
        .optional(),
      remove: tool.schema
        .array(tool.schema.string())
        .describe('Roles whose model overrides should be deleted from the stored options.models, e.g. ["sidekick"].')
        .optional(),
      audit: tool.schema
        .boolean()
        .describe("Enable (true) or disable (false) the conductor-audit event hook.")
        .optional(),
      claude: tool.schema
        .boolean()
        .describe("Enable (true) or disable (false) the optional Claude Code review bridge.")
        .optional(),
    },
    async execute(args, context) {
      requireConductorCaller(context);
      const directory = context?.directory || process.cwd();

      const provided = OPTION_KEYS.filter((key) => args[key] !== undefined);
      if (provided.length === 0) {
        throw new Error(`conductor_configure needs at least one of: ${OPTION_KEYS.join(", ")}`);
      }
      if (args.profile !== undefined && !Object.hasOwn(PROFILES, args.profile)) {
        throw new Error(
          `Unknown conductor profile "${args.profile}". Available profiles: ${Object.keys(PROFILES).join(", ")}`
        );
      }
      if (args.models !== undefined && !isPlainObject(args.models)) {
        throw new Error('"models" must be an object of role -> "provider/model-id" pairs');
      }
      if (args.remove !== undefined && !Array.isArray(args.remove)) {
        throw new Error('"remove" must be an array of role names');
      }
      const models = args.models ?? {};
      for (const [role, model] of Object.entries(models)) {
        if (!KNOWN_ROLES.includes(role)) {
          throw new Error(`Unknown role "${role}" in models. Known roles: ${KNOWN_ROLES.join(", ")}`);
        }
        if (typeof model !== "string" || !MODEL_PATTERN.test(model)) {
          throw new Error(
            `Model for role "${role}" must be a "provider/model-id" string, got ${JSON.stringify(model)}`
          );
        }
      }
      for (const role of args.remove ?? []) {
        if (typeof role !== "string" || !KNOWN_ROLES.includes(role)) {
          throw new Error(`Unknown role "${role}" in remove. Known roles: ${KNOWN_ROLES.join(", ")}`);
        }
      }

      const found = findPluginEntry(directory);
      if (found.reason === "parse-error") {
        throw new Error(
          `Cannot update ${found.file}: it is not valid JSON (${found.error.message}). No changes were made.`
        );
      }
      if (found.reason === "unreadable") {
        throw new Error(
          `Cannot update ${found.file}: it could not be read (${found.error.message}). No changes were made.`
        );
      }
      if (found.reason === "jsonc") {
        throw new Error(
          `Found ${found.file}, but .jsonc files cannot be parsed or edited safely by this tool. `
          + `Edit the file by hand: set the plugin entry to ["${PACKAGE_NAME}", { ... }] and restart opencode.`
        );
      }
      if (!found.found) {
        throw new Error(
          `No opencode.json containing the conductor plugin entry was found. Checked: ${found.checked.join(", ")}. `
          + `The conductor plugin may be running from a local plugins/ directory or from another config. `
          + `Add ["${PACKAGE_NAME}", {}] to the "plugin" array of your opencode.json, then restart opencode.`
        );
      }

      // Compute the next options object. Stored keys we do not manage are
      // carried through untouched; profile replaces, models merges key-wise
      // (via __proto__-safe assignment), remove deletes roles, and the two
      // booleans replace.
      const current = copyObject(isPlainObject(found.options) ? found.options : {});
      const next = copyObject(current);
      const currentModels = copyObject(isPlainObject(current.models) ? current.models : {});
      const nextModels = copyObject(currentModels);

      if (args.profile !== undefined) next.profile = args.profile;
      if (args.models !== undefined) assign(nextModels, args.models);
      for (const role of args.remove ?? []) delete nextModels[role];
      if (Object.keys(nextModels).length === 0) delete next.models;
      else next.models = nextModels;
      if (args.audit !== undefined) next.audit = args.audit;
      if (args.claude !== undefined) next.claude = args.claude;

      const summary = describeChanges(current, next);
      if (summary.length === 0) {
        return `No changes needed - the stored conductor options already match. Config file: ${found.file}`;
      }

      // Preserve the version spec exactly as found and only normalize a bare
      // string entry to tuple form when there are options to write.
      const nextEntry =
        Object.keys(next).length > 0 || Array.isArray(found.raw) ? [found.spec, next] : found.spec;
      found.parsed.plugin[found.index] = nextEntry;

      const serialized = JSON.stringify(found.parsed, null, 2) + "\n";
      const newBytes = Buffer.from(serialized, "utf8");
      const mode = fs.statSync(found.file).mode & 0o777;
      const backup = backupPathFor(found.file);
      fs.writeFileSync(backup, found.bytes, { mode });
      atomicWrite(found.file, newBytes, mode);

      return [
        `Updated ${found.file}`,
        ...summary,
        `Backup: ${backup}`,
        "Restart opencode for changes to take effect.",
      ].join("\n");
    },
  });
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function valueLabel(value) {
  return value === undefined ? "(not set)" : JSON.stringify(value);
}

// Old -> new per key, models reported per role. Keys that did not change are
// omitted. An empty result means nothing would change.
function describeChanges(current, next) {
  const lines = [];
  for (const key of [...new Set([...Object.keys(current), ...Object.keys(next)])]) {
    if (key === "models") continue;
    if (!deepEqual(current[key], next[key])) {
      lines.push(`${key}: ${valueLabel(current[key])} -> ${valueLabel(next[key])}`);
    }
  }
  const currentModels = isPlainObject(current.models) ? current.models : {};
  const nextModels = isPlainObject(next.models) ? next.models : {};
  for (const role of [...new Set([...Object.keys(currentModels), ...Object.keys(nextModels)])]) {
    const before = currentModels[role];
    const after = nextModels[role];
    if (!deepEqual(before, after)) {
      lines.push(
        `models.${role}: ${valueLabel(before)} -> ${after === undefined ? "<removed>" : valueLabel(after)}`
      );
    }
  }
  return lines;
}