// conductor_configure: deterministically edit the plugin's own options entry
// in opencode.json so users can swap role models without re-running any
// installer. Only the options of the entry that named this plugin ever change;
// every other config key keeps its value. A rolling backup
// (opencode.json.conductor-backup) is written before any change, the write is
// atomic (temp file + rename), the original permission mode is preserved, and
// the entry keeps its own form: V1 "plugin" tuples stay tuples, V2 "plugins"
// objects stay objects, and any pinned "@version" on the entry is kept
// exactly as found.

import fs from "node:fs";
import { PACKAGE_NAME, KNOWN_ROLES } from "../constants.js";
import { PROFILES } from "../profiles.js";
import {
  assign,
  atomicWrite,
  backupPathFor,
  copyObject,
  findPluginEntry,
  isPlainObject,
  nextEntryFor,
  requireConductorCaller,
  resolveToolDirectory,
} from "./config-file.js";

const MODEL_PATTERN = /^[^\s/]+\/[^\s/]+$/;
const OPTION_KEYS = ["profile", "models", "remove", "audit", "claude", "depth"];

export function configureTool(ctx) {
  return {
    name: "conductor_configure",
    description:
      "Configure the Conductor agent team by editing this plugin's own options entry in opencode.json: set the subscription profile, per-role model overrides, the audit/claude feature flags, and the subagent delegation depth. Only the conductor plugin entry's options change (plus top-level experimental.subagent_depth in the same file when depth is passed); everything else in the config is preserved. A backup (opencode.json.conductor-backup) is written before any change, and opencode must be restarted for the change to take effect.",
    input: {
      type: "object",
      properties: {
        profile: {
          type: "string",
          description: "Subscription profile name, e.g. opencode-go or chatgpt. Replaces the stored options.profile.",
        },
        models: {
          type: "object",
          description:
            'Per-role model overrides as role -> "provider/model-id", e.g. { sidekick: "openai/gpt-5.6-luna" }. Merges key-wise into the stored options.models.',
          additionalProperties: { type: "string" },
        },
        remove: {
          type: "array",
          items: { type: "string" },
          description: 'Roles whose model overrides should be deleted from the stored options.models, e.g. ["sidekick"].',
        },
        audit: {
          type: "boolean",
          description: "Enable (true) or disable (false) the conductor-audit event hook.",
        },
        claude: {
          type: "boolean",
          description: "Enable (true) or disable (false) the optional Claude Code review bridge.",
        },
      },
        depth: {
          anyOf: [{ type: "integer", minimum: 2 }, { type: "null" }],
          description: "Subagent delegation depth: sets top-level experimental.subagent_depth in the same file (integer 2 or higher; the sidekick needs at least 2 to delegate lookups). null removes the setting.",
        },
      additionalProperties: false,
    },
    async execute(args, context) {
      requireConductorCaller(context);
      const directory = await resolveToolDirectory(ctx, context);

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

      if (args.depth !== undefined && args.depth !== null) {
        if (!Number.isInteger(args.depth) || args.depth < 2) {
          throw new Error('"depth" must be an integer 2 or higher, or null to remove the setting (got ' + JSON.stringify(args.depth) + ')');
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
          + `Edit the file by hand: set the plugin entry to {"package": "${PACKAGE_NAME}", "options": { ... }} and restart opencode.`
        );
      }
      if (!found.found) {
        throw new Error(
          `No opencode.json containing the conductor plugin entry was found. Checked: ${found.checked.join(", ")}. `
          + `The conductor plugin may be running from a local plugins/ directory or from another config. `
          + `Add {"package": "${PACKAGE_NAME}", "options": {}} to the "plugins" array of your opencode.json (or ["${PACKAGE_NAME}", {}] to the V1 "plugin" array), then restart opencode.`
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

      // experimental.subagent_depth lives outside the plugin entry, in the
      // same file. null removes it; a validated number sets it.
      const hadExperimental = isPlainObject(found.parsed.experimental);
      const oldDepth = hadExperimental ? found.parsed.experimental.subagent_depth : undefined;
      let depthLine = null;
      let depthMoveLine = null;
      if (args.depth !== undefined) {
        if (args.depth === null) {
          if (hadExperimental) delete found.parsed.experimental.subagent_depth;
          if (hadExperimental && Object.keys(found.parsed.experimental).length === 0) {
            delete found.parsed.experimental;
          }
          if (oldDepth !== undefined) depthLine = "experimental.subagent_depth: " + valueLabel(oldDepth) + " -> <removed>";
        } else {
          if (!isPlainObject(found.parsed.experimental)) found.parsed.experimental = {};
          found.parsed.experimental.subagent_depth = args.depth;
          if (Object.hasOwn(found.parsed, "subagent_depth")) {
            const stale = found.parsed.subagent_depth;
            delete found.parsed.subagent_depth;
            depthMoveLine = "subagent_depth: " + JSON.stringify(stale) + " -> <moved to experimental.subagent_depth>";
          }
          if (!deepEqual(oldDepth, args.depth)) {
            depthLine = "experimental.subagent_depth: " + valueLabel(oldDepth) + " -> " + valueLabel(args.depth);
          }
        }
      }

      const summary = describeChanges(current, next);
      if (depthLine) summary.push(depthLine);
      if (depthMoveLine) summary.push(depthMoveLine);
      if (summary.length === 0) {
        return { content: `No changes needed - the stored conductor options already match. Config file: ${found.file}` };
      }

      // Preserve the entry form and version spec exactly as found.
      found.parsed[found.key][found.index] = nextEntryFor(found, next);

      const serialized = JSON.stringify(found.parsed, null, 2) + "\n";
      const newBytes = Buffer.from(serialized, "utf8");
      const mode = fs.statSync(found.file).mode & 0o777;
      const backup = backupPathFor(found.file);
      fs.writeFileSync(backup, found.bytes, { mode });
      atomicWrite(found.file, newBytes, mode);

      return {
        content: [
          `Updated ${found.file}`,
          ...summary,
          `Backup: ${backup}`,
          "Restart opencode for changes to take effect.",
        ].join("\n"),
      };
    },
  };
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
