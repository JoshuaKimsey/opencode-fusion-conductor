// Shared config-file plumbing for the conductor_configure and conductor_status
// tools: locating the opencode.json whose plugin array holds this plugin's
// entry, safely copying/merging the options object, and the atomic
// write-with-backup helpers (ported from the legacy fusion-setup installer).
//
// Search order mirrors how opencode resolves configs: the project's
// opencode.json first, then the global one at $XDG_CONFIG_HOME/opencode/
// opencode.json (falling back to ~/.config/opencode/opencode.json when
// XDG_CONFIG_HOME is unset or empty, matching opencode's own "||" fallback).
// A .jsonc counterpart is never parsed - JSONC cannot be round-tripped
// safely, so callers get a clear refusal instead.
//
// Both plugin keys are supported: the V1 "plugin" array (bare specs and
// [spec, options] tuples) and the native V2 "plugins" array (bare specs and
// { package, options } objects). The key that holds the entry is reported as
// `key` so writers preserve the file's own form.

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

// Normalize one array element to { spec, options, raw } or undefined when it
// is not an object/string entry we understand. `key` selects the V1 tuple
// form ("plugin") or the V2 object form ("plugins").
function normalizeEntry(raw, key) {
  if (typeof raw === "string") {
    return { spec: raw, options: undefined, raw };
  }
  if (key === "plugin" && Array.isArray(raw) && raw.length > 0 && typeof raw[0] === "string") {
    return { spec: raw[0], options: isPlainObject(raw[1]) ? raw[1] : undefined, raw };
  }
  if (key === "plugins" && isPlainObject(raw) && typeof raw.package === "string") {
    return { spec: raw.package, options: isPlainObject(raw.options) ? raw.options : undefined, raw };
  }
  return undefined;
}

// Build the replacement array element preserving the file's own form:
// V1 strings normalize to tuples only when there are options to write;
// V2 strings normalize to { package, options } objects under the same rule,
// and V2 objects keep every key they already carry.
export function nextEntryFor(entry, next) {
  const hasOptions = Object.keys(next).length > 0;
  if (entry.key === "plugins") {
    if (typeof entry.raw === "string") {
      return hasOptions ? { package: entry.spec, options: next } : entry.spec;
    }
    const out = { ...entry.raw, package: entry.spec };
    if (hasOptions) out.options = next;
    else delete out.options;
    return out;
  }
  if (Array.isArray(entry.raw)) return [entry.spec, next];
  return hasOptions ? [entry.spec, next] : entry.spec;
}

// A file:// entry carries no package name of its own: identify it by the
// name field of the package.json in the directory it points at (leniently
// accepting a file path by falling back to its parent directory). Anything
// unreadable simply does not match.
function localPackageName(spec) {
  if (!spec.startsWith("file://")) return undefined;
  try {
    const target = spec.slice("file://".length);
    const st = fs.statSync(target);
    const dir = st.isDirectory() ? target : path.dirname(target);
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    return typeof pkg.name === "string" ? pkg.name : undefined;
  } catch {
    return undefined;
  }
}

function findEntryInConfig(parsed, key) {
  if (!isPlainObject(parsed)) return undefined;
  const list = parsed[key];
  if (!Array.isArray(list)) return undefined;
  for (let index = 0; index < list.length; index++) {
    const normalized = normalizeEntry(list[index], key);
    if (!normalized) continue;
    const stripped = stripVersionSpec(normalized.spec);
    const matched = stripped === PACKAGE_NAME || localPackageName(normalized.spec) === PACKAGE_NAME;
    if (matched) {
      const version = stripped === normalized.spec ? undefined : normalized.spec.slice(stripped.length + 1);
      return { key, index, spec: normalized.spec, version, options: normalized.options, raw: normalized.raw };
    }
  }
  return undefined;
}

// Locate the opencode.json whose plugin array holds this plugin's entry.
// Result shapes:
//   { found: true, key, file, bytes, parsed, checked, index, spec, version, options, raw }
//   { found: false, reason: "missing", checked }
//   { found: false, reason: "jsonc", file, checked }
//   { found: false, reason: "parse-error" | "unreadable", file, error, checked }
// The first existing config that fails to parse (or the first .jsonc-only
// location) stops the search: writing to a later config while an earlier one
// is broken or hand-editable would be wrong. "plugin" (V1) is checked before
// "plugins" (V2) within each file.
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
      const entry = findEntryInConfig(parsed, "plugin") ?? findEntryInConfig(parsed, "plugins");
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

// Resolve the project directory a tool call runs for (OpenCode V2).
//
// V2 tool contexts carry no working directory - only { sessionID, agent,
// signal }. Prefer an explicit directory override when one is present (unit
// tests and callers that already know the project), then the calling
// session's location directory, then the plugin instance's location, and
// finally the process working directory.
export async function resolveToolDirectory(ctx, toolCtx) {
  if (typeof toolCtx?.directory === "string" && toolCtx.directory) return toolCtx.directory;
  const sessionID = toolCtx?.sessionID;
  if (sessionID && ctx?.session?.get) {
    try {
      const res = await ctx.session.get({ sessionID });
      const dir = res?.data?.location?.directory ?? res?.location?.directory;
      if (typeof dir === "string" && dir) return dir;
    } catch {
      /* fall through to the location fallbacks */
    }
  }
  if (typeof ctx?.location?.directory === "string" && ctx.location.directory) {
    return ctx.location.directory;
  }
  return process.cwd();
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
