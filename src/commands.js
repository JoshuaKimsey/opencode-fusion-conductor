// The /conductor slash command. Ports the legacy fusion-setup and
// fusion-status commands into a single command driven by the
// conductor_configure and conductor_status tools (which later tasks
// implement). The template uses $ARGUMENTS like the source command templates.

export const COMMANDS = {
  conductor: {
    description:
      "Configure or reconfigure the opencode Conductor agent team, or health-check the current setup",
    template: `Handle the /conductor command for the opencode Conductor agent team.

STEP 1 - ALWAYS call the conductor_status tool first, before anything else, and read its "Setup state:" line. Every branch below starts from that report.

$ARGUMENTS

Then follow exactly ONE of these branches:

== BRANCH A - ARGUMENTS PRESENT ==
When $ARGUMENTS is non-empty, apply the requested changes with the conductor_configure tool and do NOT run the interview:
- "profile <name>" (for example "profile opencode-go" or "use my GitHub Copilot subscription") sets the subscription profile: pass { profile: "<name>" } to conductor_configure.
- "audit=true"/"audit=false" and "claude=true"/"claude=false" set the feature flags: pass { audit: true|false } and/or { claude: true|false } to conductor_configure.
- Any remaining tokens in role=model form (for example "sidekick=provider/model-id explore=provider/model-id") are per-role model overrides: pass { models: { role: "provider/model-id", ... } } to conductor_configure. Use exactly what the user typed - never invent or autocomplete model ids.
Combine everything requested into ONE conductor_configure call when it fits (profile, models, and flags can be passed together).
After conductor_configure returns, report its change summary to the user and remind them: "Restart opencode for changes to take effect."

== BRANCH B - NO ARGUMENTS, STATUS SAYS CONFIGURED ==
When $ARGUMENTS is empty and the conductor_status "Setup state:" line says "configured", just report: the setup state line, the effective role -> model table, and the migration hazards from the status report. Remind the user that changes can be made by passing arguments, for example "/conductor profile opencode-go" or "/conductor sidekick=provider/model-id". Do NOT run the setup interview and do NOT call conductor_configure.

== BRANCH C - NO ARGUMENTS, STATUS SAYS UNCONFIGURED (SETUP INTERVIEW) ==
When $ARGUMENTS is empty and the conductor_status "Setup state:" line says "unconfigured", run the first-run SETUP INTERVIEW instead of dumping the status. Interview discipline: keep it tight - batch sensibly (the profile question alone first, then the override questions and the audit/claude flags together), never more than three exchanges with the user, and NEVER call conductor_configure without the user's answers.

1. Tell the user: "Fusion Conductor is installed but not configured." Ask whether to set it up now. If they decline: show the two one-line ways to configure later - the arguments form ("/conductor profile <name>", or role=model pairs like "/conductor sidekick=provider/model-id") and bare "/conductor" to re-run this interview - and stop.
2. Ask which subscription/profile they use, presenting the "Available profiles:" list from the conductor_status output (one line per profile: "name: role=model, ..., small_model=..."). Do NOT hardcode profile names or models in your questions - the status report is the source. Include the option "none of these - I'll pick models per role".
3. If a profile was chosen: show its role -> model assignments from the status output and ask whether to keep those assignments or override any role. For each role the user wants overridden, ask for the model as provider/model-id. Never invent or autocomplete model ids - use exactly what the user types (conductor_configure validates the format), and if their input lacks the provider/ prefix, ask them to give it in provider/model form.
   If "none of these" was chosen: ask which models to use, at minimum for build (the main planning agent) and sidekick (the cheaper executor); the other roles (plan, explore, research, design, reviewer, vision) are optional.
4. Ask one compact optional question: enable audit logging (off by default) and/or the Claude bridge (off by default, requires the Claude Code CLI)?
5. Call conductor_configure with the collected values (the chosen profile and/or the role -> model map, plus audit/claude booleans as answered). Report exactly what changed, then remind: "Restart opencode for changes to take effect."`,
  },
};