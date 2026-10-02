# Fusion Conductor

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub](https://img.shields.io/badge/GitHub-JoshuaKimsey/opencode--fusion--conductor-181717?logo=github)](https://github.com/JoshuaKimsey/opencode-fusion-conductor)

A minimal, working multi-model team for [opencode](https://opencode.ai): a **main agent** that plans and reviews but **cannot edit files**, delegating every change to a cheaper, faster **sidekick**. Inspired by the [Devin Fusion "sidekick" pattern](https://cognition.com/blog/devin-fusion) from Cognition.

The main agent's file editing is mechanically denied. Its only way to change a file is to hand a spec to the sidekick. That keeps frontier intelligence on the decisions that matter (the plan, the interpretation of ambiguity, the review) while a cheap model does the mechanical work. Cognition reports the pattern holds frontier-level quality at roughly **35% lower cost** on their own FrontierCode benchmark, and in a July 2026 follow-up measured a Fable 5-led setup at **54% below pure Fable 5** with near-identical quality.

This is a **rewrite of [opencode-fusion](https://github.com/mihneaptu/opencode-fusion) as a real opencode plugin**: the same mechanically enforced main/sidekick split, but distributed as a one-line npm plugin install instead of a file-based skill bundle. If you are coming from opencode-fusion, see [Migration from opencode-fusion](#migration-from-opencode-fusion).

[Quick start](#quick-start) • [How it works](#how-it-works) • [Configuration](#configuration) • [Enforced vs. advised](#enforced-vs-advised) • [Profiles](#profiles) • [Migration from opencode-fusion](#migration-from-opencode-fusion) • [OpenCode 2 status](#opencode-2-status) • [Development](#development)

> [!NOTE]
> **Fork and attribution.** This project is forked from
> [mihneaptu/opencode-fusion](https://github.com/mihneaptu/opencode-fusion)
> (archived August 24, 2026; final release v1.2.0) and rebranded to the npm
> plugin named `opencode-fusion-conductor`. The unscoped `opencode-conductor`
> name is taken by NocturnLabs's unrelated conductor plugin, so we chose the
> fuller spelling, honoring the opencode-fusion lineage. The "Devin Fusion
> pattern" framing and its permission-layer enforcement come from Cognition.
> All three are credited below.

## Quick start

Requires OpenCode V2 (`opencode --version` shows 2.x). Install with the
opencode plugin CLI (recommended):

```bash
opencode plugin add opencode-fusion-conductor
```

The CLI command installs the package and writes the plugin entry into your
global opencode config itself, failing with a real error if the install
fails. To try an unreleased revision straight from git:

```bash
opencode plugin add github:JoshuaKimsey/opencode-fusion-conductor
```

Do not pin by this repo's `v1.x` tags for V2 (use the npm version pin instead). Still on opencode 1.18.x? Install the V1 line with `opencode plugin add opencode-fusion-conductor@v1` and stay there; 2.x does not run on V1 (those `v1.x` tags are inherited from upstream
opencode-fusion and point at old releases).

Manual alternative: add one entry to the `plugins` array in your opencode
config yourself (`~/.config/opencode/opencode.json`, or a project-level
`opencode.json`):

```json
{
  "plugins": [{ "package": "opencode-fusion-conductor@2.0.0", "options": { "profile": "opencode-go" } }]
}
```

Then fully quit and restart opencode (or `opencode service restart`). The
plugin injects the agent team and the `/conductor` command on the next
launch; a bare `/conductor` on an unconfigured install runs the first-run
setup interview in chat.

That is the whole install. **Uninstall** with `opencode plugin remove
opencode-fusion-conductor`, then restart.

> [!IMPORTANT]
> **If the plugin seems to do nothing:** check `opencode plugin list` - the
> plugin id `opencode-fusion-conductor` must show up as active. If a git or
> npm install fails, opencode logs the error server-side (inspect with
> `opencode service status` and `~/.local/share/opencode/log/opencode.log`)
> and runs with the stock agents - which looks exactly like "the plugin did
> nothing". Installing via the `opencode plugin add ...` CLI command surfaces
> that error directly instead of swallowing it.

To verify it is working, open a project with some lint errors and ask:

```
fix the lint errors in this project
```

You should see the main agent delegate exploration, receive the findings, make
a plan, then delegate execution to the sidekick via the `task` tool. The
sidekick makes the edits, and the main agent verifies by running the project's
lint or test command itself before reporting back.

> [!NOTE]
> Along the way you may see the occasional command struck through with a
> permission error (for example the agent trying `git ls-files`). That is not a
> bug. The main and plan agents run bash deny-by-default, so anything outside
> their short allowlist is mechanically blocked, and the agent recovers on its
> own by reading the file or delegating the search. A denied command is the
> guardrail working, not the setup failing.

## Why it works

From [Cognition's blog post](https://cognition.com/blog/devin-fusion):

> We've found that the main agent should take minimal actions, and only read what is absolutely necessary. By default it should delegate and monitor, while making the significant decisions: the plan, the interpretation of ambiguity, the final review.

This repo turns that into a hard constraint: the main agent's edit, search, and freeform bash tools are denied at the permission layer, so delegating to the sidekick is its only way to change a file. Two payoffs fall out of the split:

**Lower cost.** Implementation mechanics are most of a session's tokens. A cheaper sidekick handles them at near-parity while the expensive main model spends its tokens only on judgment: the plan, the spec, the review. The main agent's prompt enforces this discipline: emit judgment not volume, keep context lean, reason once then hand off. Cognition's [follow-up study](https://cognition.com/blog/making-fable-cheaper-than-opus) bears this out: in 81% of Fable-led Fusion runs, the lead model never made a single code edit. That is the behavior this repo makes mechanical rather than advisory.

**Cross-vendor review, for free.** When the main agent and sidekick are different model families (for example Opus reviewing Grok), every diff gets an independent second-family read before it lands. Models from one family share blind spots; a reviewer from a different lineage catches what same-family review misses. You get this just by picking a main and sidekick from different vendors.

## How it works

![System architecture: a two-column swimlane showing the flow between the Main Agent (left) and Sidekick (right)](flow-diagram.png)

The diagram shows one delegation cycle: the main agent delegates exploration, plans from what comes back, hands the sidekick a spec, reviews the returned diff, loops until it passes, then delivers the result.

The team below is injected by the plugin at startup. Models are resolved per role from the selected profile, with per-role overrides possible (see [Configuration](#configuration)). The suggested models are the 2026 defaults from the `opencode-go` profile; they are starting points, not requirements.

| Agent | Role | Type | Suggested model (2026) |
|-------|------|------|------------------------|
| `build` | Main: plan, delegate, review | primary (restricted) | `opencode-go/kimi-k3` |
| `plan` | Plan mode: same brain as build, plans but does not execute | primary | `opencode-go/kimi-k3` |
| `sidekick` | Execute edits and commands | subagent | `opencode-go/deepseek-v4-flash` |
| `explore` | Fast read-only exploration (opencode's built-in agent; model-only) | subagent | `opencode-go/deepseek-v4-flash` |
| `research` | Read-only external research (web, docs) | subagent | `opencode-go/deepseek-v4-pro` |
| `design` | Frontend/UI implementation | subagent | `opencode-go/qwen3.8-max` |
| `reviewer` | Critique a plan before implementation; audit a diff before commit | subagent | `opencode-go/glm-5.3-flash` |
| `vision` | Transcribe images the main model cannot see | subagent (hidden) | unset by default |

`build` and `plan` are the primaries. `build` is the restricted main agent: `edit`, `grep`, `glob`, and `list` are denied, shell is deny-by-default with a verification + git allowlist, and `git commit`/`git push` require user approval. `sidekick` is the executor. `explore` is opencode's built-in read-only agent - the plugin only assigns it a model, never a full definition. `research`, `design`, `reviewer`, and `vision` are optional specialists; a profile (or a `models` override) decides which get a model.

Set `experimental.subagent_depth` to at least 2 in your own config if you want the sidekick to keep delegating read-only lookups to explore or research; the plugin no longer floors it for you (V2 exposes no such knob to plugins).

Models move fast. Treat these as 2026 starting points, not requirements. Use any provider you like; in config each model is written as `provider/model-id` (for example `opencode-go/deepseek-v4-flash`), and the sidekick should stay cheaper and faster than the main agent. The mix above spans several vendors on purpose, so the main agent's review of each sidekick diff is cross-vendor.

## Configuration

All plugin options live in the plugin entry of your `opencode.json`:

```json
{
  "plugins": [{ "package": "opencode-fusion-conductor@2.0.0", "options": { "profile": "opencode-go" } }]
}
```

| Option | Type | Default | Meaning |
|--------|------|---------|---------|
| `profile` | string | none | One of `chatgpt`, `github-copilot`, `opencode-go`, `opencode-zen`, `opencode-zen-free`. Fills in per-role models from a subscription profile. |
| `models` | object | none | Per-role model overrides as `role -> "provider/model-id"`. Roles: `build`, `plan`, `sidekick`, `explore`, `research`, `design`, `reviewer`, `vision`; the title agent follows top-level `small_model` instead (core applies it after plugin transforms, so no override can win). Overrides win per role over the profile. |
| `audit` | boolean | `false` | Enables the `conductor-audit` event hook, which logs the delegation tree and per-agent token usage. |
| `claude` | boolean | `false` | Enables the Claude Code bridge tools `conductor_claude_status` / `conductor_claude_review`. Requires Claude Pro/Max CLI installed and authenticated. |
| `depth` | integer or null | none | Sets top-level `experimental.subagent_depth` in the same file (2 or higher; the sidekick needs 2+ to delegate lookups). `null` removes it. Reported by status; does not affect setup state. |

Examples:

```jsonc
// Use a subscription profile, then override one role.
{
  "plugins": [{ "package": "opencode-fusion-conductor@2.0.0", "options": {
    "profile": "opencode-go",
    "models": { "sidekick": "opencode-go/deepseek-v4-flash" },
    "audit": true
  } }]
}
```

```jsonc
// Add the Claude Code plan-review bridge.
{
  "plugins": [{ "package": "opencode-fusion-conductor@2.0.0", "options": {
    "claude": true
  } }]
}
```

### The `/conductor` slash command

The plugin injects a `/conductor` command that reports or edits the plugin's own options atomically (a rolling backup is written to `opencode.json.conductor-backup` before any change).

- **No arguments** -> `conductor_status`, a read-only report: where the plugin entry lives, its raw options, the effective role -> model resolution, leftover fusion-install hazards, and the pinned plugin version. If the setup state is `unconfigured` (no profile and no model overrides), a bare `/conductor` instead runs a first-run setup interview - profile choice from the status report's available-profiles list, per-role model overrides, and the optional `audit`/`claude` flags - then applies your answers and tells you to restart.
- **With arguments** -> applies changes directly, skipping the interview: `conductor_configure` edits the plugin's options in `opencode.json`. Supported forms:
  - role=model pairs: `/conductor sidekick=opencode-go/deepseek-v4-flash explore=opencode-go/deepseek-v4-flash`
  - a profile: `/conductor profile chatgpt`
  - flags: `/conductor audit=true claude=true depth=2` (depth sets experimental.subagent_depth; `depth=none` removes it)

> [!IMPORTANT]
> **Model changes require a restart.** The agent registry is
> materialized at startup, so the plugin's injected agents (and their model
> assignments) only take effect on the next launch. The `/conductor` command
> edits the config and always tells you to restart. This is a platform
> limitation, not a bug in the plugin.

### Updating

Check for updates and install them with the plugin CLI, then restart
opencode (or `opencode service restart`):

```bash
opencode plugin check
opencode plugin update opencode-fusion-conductor
```

To remove the plugin: `opencode plugin remove opencode-fusion-conductor`,
then restart.

## Enforced vs. advised

The pattern's guarantees live in two different layers, and being precise about which is which answers most "what if the model just ignores the instructions?" questions.

**Enforced: the permission layer.** opencode checks these on every tool call, no matter what the model reads, remembers, or intends:

- The main agent's `edit`, `grep`, `glob`, and `list` are denied, and a session hook strips those tools from its model requests as well - there is no edit tool for it to decline to use.
- Its shell is deny-by-default with a short verification and git allowlist, so file-writing commands are blocked. `git commit` and `git push` additionally require per-command user approval; common direct force/mirror/delete/prune forms are denied by later rules.
- Direct `git commit` and `git push` invocations plus common Git wrapper forms are denied for the sidekick and design agents, making review-then-commit the normal enforced path.
- Delegation is bounded by an explicit `subagent` allowlist: the main agent reaches only its named specialists, and the sidekick can spawn only read-only searchers.
- The `conductor_configure` and `conductor_status` tools serve only the build and plan agents; the plugin grants them to those two and denies them everywhere else.

If the main agent "won't delegate," the result is visible inaction: nothing on disk changes. The failure mode is never a silent bypass.

These are the same permission rules the final opencode-fusion release injected, converted to the V2 ordered-`permissions` form (`bash` -> `shell`, `task` -> `subagent`). The guarantee is covered by unit tests over the converted rules in `test/`.

**Advised: the prompt layer.** Spec precision, diff-review rigor, cost discipline, parallelization, and skill usage are instructions in the agent prompts. opencode loads skills at the model's discretion (nothing can force an agent to read or apply one), which is exactly why no guarantee here depends on them. If the model slacks at this layer, the cost is quality or wasted tokens, never an unauthorized edit.

**Not guaranteed: the threat model.** The permission layer bounds which tools each agent can call. It is not a sandbox, and it is worth being precise about what it does not protect:

- The `.env` denies on the executors stop the common accidental read (`cat .env` landing a key in a transcript), not a determined one. An agent with broad shell has many equivalent ways to read a file or the process environment, so treat those rules as accidental-leak prevention, not secret isolation. The `{env:VAR}` config syntax keeps keys out of plaintext config and out of the chat; it does not hide them from the environment agents run in.
- Git command rules match command text and are defense-in-depth, not a shell sandbox: wrappers, alternate executables, or obfuscation can bypass a finite pattern list when an executor has broad shell. They protect against common accidental commits and destructive pushes, not a hostile process. Editing files is the sidekick's job, and catching a wrong edit is what the main agent's diff review (and the optional reviewer) are for.
- The design agent is the one role granted `skill: allow`, because its prompt cannot do its job without loading a design skill. That skips opencode's per-use approval prompt and overrides a global `skill` deny. A skill is instructions the model then follows, so treat your installed skill set as trusted input on the same footing as your prompts. The agent already holds `edit` and broad shell, so this grants no capability it lacked. Every other agent keeps opencode's default, so a global deny still applies to them.
- The design agent's path-aware opencode tools are fenced to the workspace (`external_directory: deny`), but processes launched through broad shell are not OS-sandboxed by that rule. The sidekick keeps opencode's default `ask` for paths outside the project. Note that `--auto` mode auto-approves `ask` rules, so use external sandboxing too if an executor must never leave the repo.

**Auditable: verify instead of trusting.** The optional `audit` option enables a hook that logs the delegation tree and aggregates per-agent token usage, and opencode's session DB records every agent's actual tool calls (`opencode db path` prints its location, typically `~/.local/share/opencode/opencode.db`). "Did it really delegate?" is checkable ground truth, not vibes.

## Profiles

If your models come from a subscription, set the `profile` option and the plugin fills in a ready-made role-to-model mapping. Authentication stays out-of-band: connect the provider once with `opencode auth login` (or `/connect` inside opencode). Profiles contain no keys, adapters, or endpoints (opencode knows these providers natively).

| Profile | Subscription | Main / sidekick | Beyond the core roles |
|---------|--------------|-----------------|-----------------------|
| `opencode-go` | [OpenCode Go](https://opencode.ai/go) | Kimi K3 / DeepSeek V4 Flash | research, design, reviewer |
| `opencode-zen` | [OpenCode Zen](https://opencode.ai/docs/zen/) pay-as-you-go | Claude Opus 5 / GPT-5.6 Luna | research, design, reviewer |
| `opencode-zen-free` | OpenCode Zen free-tier models | Big Pickle / MiMo V2.5 Free | vision |
| `chatgpt` | ChatGPT Plus or Pro | GPT-5.6 Sol / GPT-5.6 Luna | reviewer |
| `github-copilot` | GitHub Copilot | Claude Sonnet 5 / GPT-5.6 Luna | research, reviewer |

To adjust a pick, keep the profile and add a per-role `models` override - the override wins for that role. Subscription lineups rotate; `npm run check-profiles` verifies every shipped id against [models.dev](https://models.dev).

## Migration from opencode-fusion

If you previously installed [opencode-fusion](https://github.com/mihneaptu/opencode-fusion) (the file-based skill bundle), migrate as follows:

1. **Undo the old install.** Say `undo fusion` with the old fusion-setup skill, or run its installer's undo, to remove the file-based agents and prompts it installed under `~/.config/opencode/`. This restores `opencode.json` to its pre-fusion state and deletes the agent `.md` files that would otherwise override the plugin's injected agents.
2. **Add the plugin line** to `~/.config/opencode/opencode.json` as in [Quick start](#quick-start).
3. **Restart opencode.**

The leftover file-based agents are a hazard because they override the plugin-injected agent config field-by-field. `conductor_status` (run `/conductor` with no arguments) checks for leftover fusion files and warns you if any are detected.

The `claude` and `audit` options fold in what the old `fusion-claude` plugin and `fusion-audit` plugin provided, so there is no separate plugin to install.

## OpenCode 2 status

This plugin targets **OpenCode V2** (2.x) since the 2.0.0 port. The V1
`plugin`-function implementation does not run on V2, so 1.x releases stay on
opencode 1.18.x.

Port notes worth knowing:

- Agent injection moved from the V1 config hook to `ctx.agent.transform`
  upserts (`update` creates agents that do not exist yet), with V1 permission
  maps converted to ordered V2 `permissions` arrays (`bash` -> `shell`,
  `task` -> `subagent`). Prompts name the V2 tools.
- The mechanical no-edit guarantee is two layers: `deny` rules plus a session
  `context` hook that removes `edit`/`write`/`patch`/`grep`/`glob` from
  build/plan model requests.
- Top-level `subagent_depth` is ignored by V2; the `depth` option manages `experimental.subagent_depth` instead
  `small_model` folds into the built-in `title` agent, handled automatically.
  Status reports the depth and warns when a stale top-level value is present.
- The `/conductor` tools read and write both the V1 `plugin` tuple form and
  the native V2 `plugins` object form, preserving whichever the file uses.

## Development

From the repository root:

```bash
npm test                 # unit + consistency suites
npm run test:integration # live integration: real opencode on PATH (CONDUCTOR_INTEGRATION=1)
npm run check-profiles   # verify profile model ids against models.dev (needs network)
npm run build:changelog  # regenerate site/changelog.html from CHANGELOG.md
```

`test/integration` holds the opt-in live suite (gated behind
`CONDUCTOR_INTEGRATION=1`); it still drives the V1 `opencode` binary and the
V1 plugin shape, so it stays skipped on V2 - `npm test` never runs it. See
[docs/testing.md](docs/testing.md) for details. Live V2 verification is a
local plugin install plus the `/api/agent`, `/api/command` checks described
in [OpenCode 2 status](#opencode-2-status).

### Local development install

Config-file local path entries are not picked up by opencode 2.0.x, so
develop against the global discovery directory instead: drop a shim file
at `~/.config/opencode/plugins/conductor.js` containing one re-export line
(`export { default } from "file:///path/to/opencode-conductor/src/index.js";`)
and keep a `file://` entry with your options in the global `plugins` array
(the tools match it by the target directory's `package.json` name, and
setup reads its options when none were passed directly). Restart opencode
(`opencode service restart`) after code changes; config edits hot-reload.

## Files

- `src/` - the plugin: config hook, injected agents, tools, audit hook, Claude bridge
- `site/` - the marketing site and docs (GitHub Pages)
- `scripts/` - changelog renderer, integration runner, profile checker
- `test/` - unit and consistency suites plus the live integration harness
- `docs/` - releasing and testing guides
- `flow-diagram.png` - architecture diagram (Main Agent vs Sidekick swimlane)

## Built with Fusion Conductor

This repo was configured using the pattern itself. The main agent planned the structure, reviewed every change, and verified against real command output. The sidekick wrote the files and ran the commands. Every change went through the flow above.

## Disclaimer

This project is not affiliated with, endorsed by, or built by the opencode team. [opencode](https://opencode.ai) is a separate project by [Anomaly](https://anoma.ly). This repo provides a plugin that works with opencode but is not part of it.

## Credit

Forked from [opencode-fusion](https://github.com/mihneaptu/opencode-fusion) by [mihneaptu](https://github.com/mihneaptu) (archived August 24, 2026; final release v1.2.0). The "Devin Fusion" sidekick pattern - the framing, the principle that "the main agent should take minimal actions", and the benchmark numbers quoted in this README - is from [Cognition](https://cognition.com), via the [launch post](https://cognition.com/blog/devin-fusion) and the July 2026 follow-up, ["Making Fable Cheaper Than Opus"](https://cognition.com/blog/making-fable-cheaper-than-opus). The underlying split has older roots. [Aider's architect/editor mode](https://aider.chat/2024/09/26/architect.html) separated code reasoning from code editing back in 2024: one model describes the solution, a second turns it into clean edits. The permission-layer enforcement, the cross-vendor review setup, and the specialist team are this repo's own.

## License

[MIT](LICENSE), dual copyright: the original fork's author and Joshua Kimsey (modifications).
