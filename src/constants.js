// Shared constants for the Conductor plugin. The published npm package name is
// "opencode-fusion-conductor": the unscoped "opencode-conductor" name is taken
// by NocturnLabs's unrelated conductor plugin, so we chose the fuller spelling,
// honoring the opencode-fusion lineage. The name is unscoped, so a version
// pin reads NAME@version and version stripping only ever cuts a trailing
// "@version".
// KNOWN_ROLES is the full role surface the plugin manages, including explore
// (built-in agent, model-only injection).

export const PACKAGE_NAME = "opencode-fusion-conductor";

export const KNOWN_ROLES = [
  "build",
  "plan",
  "sidekick",
  "explore",
  "research",
  "design",
  "reviewer",
  "vision",
];