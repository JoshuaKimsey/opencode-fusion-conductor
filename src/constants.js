// Shared constants for the Conductor plugin. The published npm package name is
// scoped (@joshuakimsey/opencode-conductor - the unscoped name is taken), which
// matters for matching the plugin entry in opencode.json: scoped specs start
// with "@", so version stripping must only ever cut a trailing "@version".
// KNOWN_ROLES is the full role surface the plugin manages, including explore
// (built-in agent, model-only injection).

export const PACKAGE_NAME = "@joshuakimsey/opencode-conductor";

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