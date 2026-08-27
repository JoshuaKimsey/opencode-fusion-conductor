// Shared config-file plumbing for the conductor_configure and conductor_status
// tools: locating the opencode.json whose "plugin" array holds this plugin's
// entry, safely copying/merging the options object, and the atomic
// write-with-backup helpers (ported from the legacy fusion-setup installer).
//
// Search order mirrors how opencode resolves configs: the project's
// opencode.json first, then the global one at $XDG_CONFIG_HOME/opencode/
// opencode.json (falling back to ~/.config/opencode/opencode.json when
// XDG_CONFIG_HOME is unset or empty, matching opencode's own "||" fallback).
// A .jsonc counterpart is never parsed - JSONC cannot be round-tripped
// safely, so callers get a clear refusal instead.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { PACKAGE_NAME } from "../constants.js";

const ALLOWED_AGENTS = new Set(["build", "plan"]);

export function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Plain assignment would hit the prototype setter for a key named "__proto__"
// and silently drop or pollute that subtree; defineProperty always creates an
// ordinary own property (same guard as the legacy installer).
export function assign(target, source) {
  for (const [key, value] of Object.entries(source)) {
    Object.defineProperty(target, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return target;
}

export function copyObject(source) {
  return assign({}, source);
}

// opencode's global config base: XDG_CONFIG_HOME || ~/.config, then "opencode".
// An empty XDG_CONFIG_HOME counts as unset.
export function configDir() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "opencode");
}

export function requireConductorCaller(context) {
  const agent = context?.agent;
  if (!ALLOWED_AGENTS.has(agent)) {
    throw new Error(
      `The conductor_configure and conductor_status tools only serve the build and plan agents (caller: ${agent ?? "unknown"}).`
    );
  }
}

// Strip only a trailing "@<semver|dist-tag>" from a package spec. Scoped names
// start with "@" (the scope delimiter), so the version delimiter is the LAST
// "@" and only counts if what follows could be a version token - a token never
// contains a "/", so that single check keeps package paths intact.
export function stripVersionSpec(spec) {
  const at = spec.lastIndexOf("@");
  if (at <= 0) return spec;
  const suffix = spec.slice(at + 1);
  if (!suffix || suffix.includes("/")) return spec;
  return spec.slice(0, at);
}

function findEntryInConfig(parsed) {
  if (!isPlainObject(parsed)) return undefined;
  const plugin = parsed.plugin;
  if (!Array.isArray(plugin)) return undefined;
  for (let index = 0; index < plugin.length; index++) {
    const raw = plugin[index];
    let spec;
    let options;
    if (typeof raw === "string") {
      spec = raw;
    } else if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === "string") {
      spec = raw[0];
      if (isPlainObject(raw[1])) options = raw[1];
    } else {
      continue;
    }
    const stripped = stripVersionSpec(spec);
    if (stripped === PACKAGE_NAME) {
      const version = stripped === spec ? undefined : spec.slice(stripped.length + 1);
      return { index, spec, version, options, raw };
    }
  }
  return undefined;
}

// Locate the opencode.json whose "plugin" array holds this plugin's entry.
// Result shapes:
//   { found: true, file, bytes, parsed, checked, index, spec, version, options, raw }
//   { found: false, reason: "missing", checked }
//   { found: false, reason: "jsonc", file, checked }
//   { found: false, reason: "parse-error" | "unreadable", file, error, checked }
// The first existing config that fails to parse (or the first .jsonc-only
// location) stops the search: writing to a later config while an earlier one
// is broken or hand-editable would be wrong.
export function findPluginEntry(directory) {
  const checked = [];
  const candidates = [
    path.join(directory, "opencode.json"),
    path.join(configDir(), "opencode.json"),
  ];
  for (const file of candidates) {
    checked.push(file);
    if (fs.existsSync(file)) {
      let bytes;
      try {
        bytes = fs.readFileSync(file);
      } catch (error) {
        return { found: false, reason: "unreadable", file, error, checked };
      }
      let parsed;
      try {
        parsed = JSON.parse(bytes.toString("utf8"));
      } catch (error) {
        return { found: false, reason: "parse-error", file, error, checked };
      }
      const entry = findEntryInConfig(parsed);
      if (entry) return { found: true, file, bytes, parsed, checked, ...entry };
      continue;
    }
    const jsonc = file.replace(/\.json$/, ".jsonc");
    if (fs.existsSync(jsonc)) {
      return { found: false, reason: "jsonc", file: jsonc, checked };
    }
  }
  return { found: false, reason: "missing", checked };
}

export function backupPathFor(file) {
  return path.join(path.dirname(file), "opencode.json.conductor-backup");
}

// Atomic replace on POSIX: write a sibling temp file (same directory, so the
// rename never crosses filesystems), fsync-free like the installer, then
// rename over the target. The temp file is removed even on failure so no
// *.tmp-* litter survives. Windows gets the installer's read-only-target
// mitigation before the rename.
export function atomicWrite(target, bytes, mode) {
  const tmp = `${target}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  try {
    fs.writeFileSync(tmp, bytes, { flag: "wx", mode });
    fs.chmodSync(tmp, mode);
    let readonlyMode = null;
    if (process.platform === "win32") {
      try {
        const targetMode = fs.statSync(target).mode & 0o777;
        if (!(targetMode & 0o200)) {
          readonlyMode = targetMode;
          fs.chmodSync(target, 0o666);
        }
      } catch {
        /* no target or unreadable - let rename decide */
      }
    }
    try {
      fs.renameSync(tmp, target);
    } catch (error) {
      if (readonlyMode !== null) {
        try {
          fs.chmodSync(target, readonlyMode);
        } catch {
          /* original error wins */
        }
      }
      throw error;
    }
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}