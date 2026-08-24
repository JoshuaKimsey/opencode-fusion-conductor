# Testing opencode-fusion

## Automated checks

Run these from the repository root:

```powershell
npm test
npm run check-install
npm run check-profiles
```

`npm test` is the main validation suite. `check-install` compares the skill
bundle's prompts with installed copies under `~/.config/opencode/agent/`.
`check-profiles` verifies the model IDs in shipped profiles.

### Changelog site page

`site/changelog.html` is generated from `CHANGELOG.md` and committed, because
GitHub Pages serves `site/` verbatim and the changelog lives outside it. After
editing `CHANGELOG.md`, regenerate and commit the page:

```powershell
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
Extend the renderer, or reword the entry.

To validate the lint fixture, run `npm run lint` with `test-playground/` as the
working directory. Build and plan agents should use the tool's working-directory
parameter because `npm --prefix test-playground run lint` may not match their
command allowlist.

## Manual verification

### Skill installation

Install the published skill:

```powershell
npx skills add mihneaptu/opencode-fusion --skill fusion-setup -g -a opencode -y
```

Fully restart opencode and confirm that `fusion-setup` appears in the skill
list.

### Configuration flow

In a fresh session, ask opencode to `set up fusion`. Confirm that it asks for
the per-role models, updates `~/.config/opencode/opencode.json`, installs the
selected prompts, and shows the selected Build model after a full restart.

### Delegation flow

Seed a lint error in `test-playground/src/index.js`, then ask the Build agent to
fix it. Confirm that Build delegates the edit, reviews the result, and runs the
fixture lint itself. The fixture is gitignored, so review its changed files
directly rather than relying on `git diff`.

### Runtime audit

When surface output is not enough to establish which agent acted, inspect the
session database reported by `opencode db path` (typically
`~/.local/share/opencode/opencode.db`). Its session, message, and part records
provide the delegation tree and exact tool calls. Use this for targeted runtime
audits, not as a routine requirement for every change.
