// The /conductor slash command. Ports the legacy fusion-setup and
// fusion-status commands into a single command driven by the
// conductor_configure and conductor_status tools (which later tasks
// implement). The template uses $ARGUMENTS like the source command templates.

export const COMMANDS = {
  conductor: {
    description:
      "Configure or reconfigure the opencode Conductor agent team, or health-check the current setup",
    template: `Handle the Conductor command. Load and follow the Conductor configuration flow for the Conductor agent team.

$ARGUMENTS

If arguments are empty, call the conductor_status tool and report its result to the user. Do not fix anything - this command only reports.

If arguments name a profile (for example "profile opencode-go" or "use my GitHub Copilot subscription"), pass the profile name to the conductor_configure tool.

Otherwise parse the arguments as role=model pairs (for example "sidekick=provider/model-id explore=provider/model-id" or "reconfigure sidekick") and call the conductor_configure tool with the requested changes.

After calling conductor_configure, always tell the user that a restart of opencode is required for model changes to take effect.`,
  },
};