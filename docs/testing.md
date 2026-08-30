# Testing Fusion Conductor

## Automated checks

Run these from the repository root:

```
npm test
npm run test:integration
npm run check-profiles
```

`npm test` is the main validation suite: the plugin unit suites, the changelog
and docs-consistency contracts, and the profile checks. `test:integration`
spawns a real opencode binary against a fake provider and asserts that the
schema-removal enforcement actually holds with the plugin-injected agents.
`check-profiles` verifies the model IDs in shipped profiles against
[models.dev](https://models.dev) and needs network access.

### Integration tests

The live suite needs opencode 1.18.x on `PATH` and is opt-in so the default
`npm test` run stays offline and fast:

```
CONDUCTOR_INTEGRATION=1 npm run test:integration
```

It writes to a throwaway HOME and never touches your real config. If opencode
is not on `PATH`, the runner reports that the binary is missing and exits
non-zero.

### Changelog site page

`site/changelog.html` is generated from `CHANGELOG.md` and committed, because
GitHub Pages serves `site/` verbatim and the changelog lives outside it. After
editing `CHANGELOG.md`, regenerate and commit the page:

```
npm run build:changelog
```

`npm test` fails when the committed page has drifted from the changelog, so a
forgotten rebuild is caught before release rather than shipping a stale page.
`node scripts/build-changelog.js --check` reports the same drift without
writing, which is the form to use in a pre-commit hook.

Only the markdown `CHANGELOG.md` actually uses is supported: `##`/`###`
headings, bullets with wrapped continuation lines, paragraphs, inline code,
links, and emphasis. Anything else (fenced code, tables, nested bullets) makes
the build fail with the offending line rather than rendering as literal markup.
Extend the renderer, or reword the entry. Release headings must resolve to
unique anchors - the plugin's own releases use plain versions while the
preserved `opencode-fusion` history uses `fusion-`-prefixed headings.

### Docs consistency

`test/docs-consistency.test.js` pins the marketing site and README to the
code: the exact install snippet (version derived from `package.json`), every
profile name and role in the README, the rebranded site URLs, and the absence
of `npx skills add` remnants. A prose change that silently re-breaks the
rebrand fails the suite.

## Manual verification

### Plugin install

Add the plugin line to `opencode.json`, fully restart opencode, and confirm the
agents appear (the build agent shows up as a primary and sidekick as a
subagent). Restarting is mandatory - the agent registry materializes at startup.

### Delegation flow

Seed a lint error in a scratch project, then ask the build agent to fix it.
Confirm that build delegates the edit, reviews the result, and runs the
project's lint or test command itself. The main agent must never edit a file
directly.

### Runtime audit

When surface output is not enough to establish which agent acted, inspect the
session database reported by `opencode db path` (typically
`~/.local/share/opencode/opencode.db`). Its session, message, and part records
provide the delegation tree and exact tool calls. Use this for targeted runtime
audits, not as a routine requirement for every change.