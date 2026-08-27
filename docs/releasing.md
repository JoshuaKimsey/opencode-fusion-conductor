# Releasing

How a change gets from a pull request to a published release of
`@joshuakimsey/opencode-conductor`.

## What users actually install

Users install the published npm package:

```
{ "plugin": [["@joshuakimsey/opencode-conductor@1.0.0", { "profile": "opencode-go" }]] }
```

opencode auto-installs npm plugins via Bun at startup, so the package on the
npm registry **is** the release channel. A git tag records what shipped; it
does not gate distribution.

The package is scoped and currently unpublished, so the first release publishes
it. Scoped packages publish to the public registry only with an explicit access
flag (see below).

## Per-pull-request duty

A change a user can notice gets a bullet under `## Unreleased` in the same pull
request that makes it, then:

```
npm run build:changelog
npm test
```

Commit the regenerated `site/changelog.html` alongside `CHANGELOG.md`. GitHub
Pages serves `site/` verbatim with no build step, so the page cannot render the
changelog at runtime; `npm test` fails when the committed page has drifted.

Skip the changelog for internal refactors, test-only changes, and cosmetic CSS.

## Choosing the number

The version describes the plugin, so judge it by what happens to an installed
copy.

| Bump | When |
| --- | --- |
| Major | The plugin's injected agents or permission maps change in a way an existing install depends on, or the config shape breaks |
| Minor | New capability (a new option, tool, or agent) an existing install keeps working through |
| Patch | Fixes that change nothing a user can do |

## Cutting the release

1. Bump `version` in `package.json`.
2. Add the matching `## X.Y.Z - YYYY-MM-DD` entry to `CHANGELOG.md`, using the
   date you expect to publish rather than when the first entry landed.
3. Regenerate and verify:

   ```
   npm run build:changelog
   npm test
   npm run check-profiles
   ```

4. Publish to npm. `package.json` currently carries `"private": true`, which
   blocks `npm publish`; flip it to `false` (or override with
   `npm publish --access public`, which publishes scoped packages to the public
   registry regardless). One of the two is required - a scoped package is
   private by default and npm refuses to publish it publicly otherwise.

   ```
   npm publish --access public
   ```

   The `files` array ships `src/` only; the site, tests, and scripts are not
   part of the published package.

5. Tag the merge commit and create the GitHub release:

   ```
   git switch main && git pull --ff-only
   git tag -a vX.Y.Z -m "opencode-conductor X.Y.Z"
   git push origin vX.Y.Z
   gh release create vX.Y.Z --title "vX.Y.Z" --latest --notes-file <file>
   ```

   Tag the merge commit, not an earlier one, so the tag contains the changelog
   entry that describes it.

Because the release also touches `site/`, merging triggers a Pages deploy at
https://joshuakimsey.github.io/opencode-conductor/. Check the published
changelog page afterwards.

## Known rough edge

The published version is a literal in `package.json`, so a check out of `main`
between releases runs the previous version's code while `CHANGELOG.md` may
already describe the next one. Traceability is approximate mid-cycle; the
changelog stays the single source of truth for what shipped.