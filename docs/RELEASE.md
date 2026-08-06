# Release process (spec #32)

Two artifacts ship out of this repo, versioned independently:

- **`mcp-server`** — the npm package `godot-playtest-mcp`
  (`mcp-server/package.json` `version`).
- **`addons/playtest`** — the Godot Bridge addon
  (`addons/playtest/plugin.cfg` `version`).

## Compatibility: the protocol version is the anchor

The npm package and the addon do **not** need to move in lockstep. What they
must agree on is the **protocol version** (`protocol: 0`, `PROTOCOL_VERSION`
in `addons/playtest/dispatch.gd`, surfaced by the `hello` handshake —
[docs/protocol/DRAFT-v0.md](protocol/DRAFT-v0.md) §2). As long as an
`mcp-server` release and an addon release advertise/expect the same protocol
version, they interoperate regardless of their own package/plugin version
numbers. A protocol bump (still `0` at the time of writing) is the actual
compatibility signal to watch — not the npm version or the plugin version.

## npm package (`godot-playtest-mcp`)

Automated by [`.github/workflows/release-mcp-server.yml`](../.github/workflows/release-mcp-server.yml),
gated on a maintainer-provided secret:

1. Maintainer tags a commit `vX.Y.Z` and pushes the tag.
2. The workflow runs on that tag: checks that the `NPM_TOKEN` repository
   secret is set (see below), checks that the tag matches
   `mcp-server/package.json`'s `version`, installs, builds, runs the unit
   tests, runs the integration tests (real Godot binary, includes the
   packaged-binary smoke test that packs and installs the tarball like a
   user's `npx` would), then `npm publish`.
3. **Human, one-time setup** — the workflow is inert without it: create/use
   an npm account, generate an automation token
   (npmjs.com → Access Tokens), add it as the `NPM_TOKEN` repository secret
   (GitHub repo → Settings → Secrets and variables → Actions). If the
   secret is absent, the workflow's first step fails loudly
   (`::error::...`) instead of attempting an unauthenticated `npm publish`.
4. **Human trigger** — `npm publish` only ever runs because a human pushed a
   `v*` tag. Nothing in this repo tags or publishes on its own.

Once published, `npx godot-playtest-mcp` (or `npx -y godot-playtest-mcp` in
an MCP client config) always resolves the latest published version — no
local clone/build needed by the end user (criteria #1/#11 of spec #32).

### Pushing is not publishing

Ordinary work never publishes anything. The release workflow's only trigger
is `on: push: tags: ["v*"]` — not `on: push`, and not a branch filter.
Commits and merges to any branch, however frequent or rough, cannot reach
npm. A release happens only because a human deliberately pushed a `v*` tag.

To keep that push deliberate — including when an agent is driving —
[`.githooks/pre-push`](../.githooks/pre-push) refuses to push a `v*` tag
unless `ALLOW_RELEASE_TAG=1` is set. It inspects the refs being pushed, so
`--tags`, `--follow-tags` and a bare `git push origin v0.2.0` are all covered.
Enable it once per clone (it is not distributed by `git clone`):

```bash
git config core.hooksPath .githooks
```

The hook is a local safety net, not a boundary: it can be bypassed by
anything that does not run it. The server-side equivalent is a GitHub tag
protection ruleset (Settings → Rules → Rulesets) restricting who may create
`v*` tags — worth adding before the `NPM_TOKEN` secret exists, since that is
the point at which a tag becomes able to publish.

### Cutting a release: one command

The git tag and `mcp-server/package.json`'s `version` are separate things
and do not synchronise themselves: `npm publish` ships whatever
`package.json` says, whatever the tag is named. The workflow refuses the
release when the two disagree (`::error::` on its version-guard step, before
anything is built), so a mismatched tag fails loudly instead of publishing
`0.2.0` under a `v0.3.0` tag. `npm version` moves both at once, so prefer it
to a hand-written tag — and note the `ALLOW_RELEASE_TAG=1` the pre-push hook
above requires:

```bash
cd mcp-server && npm version minor && ALLOW_RELEASE_TAG=1 git push --follow-tags
```

While the package is pre-1.0, semver's `0.y.z` clause applies: breaking
changes are allowed in any release, so pick `patch`/`minor` freely.

### A published version is permanent

npm refuses to overwrite an existing version — a bad `0.2.0` is fixed by
publishing `0.2.1`, never by re-publishing `0.2.0`. `npm unpublish` is
allowed only within 72 hours and only while nothing depends on the package;
after that the sole remedy is `npm deprecate`, which warns on install but
leaves the code downloadable. Treat every publish as irreversible — that is
what makes `npm publish --dry-run` worth running first.

### Before the first publish (one-time, human)

- **Claim the name.** `godot-playtest-mcp` is unregistered on npm, and names
  are first-come, first-served. A scoped name
  (`@<account>/godot-playtest-mcp`) cannot be taken by anyone else, but
  needs `--access public` to stay free.
- **Make the repository public.** Required for the Asset Library submission
  below, and for npm provenance attestation. The `repository`, `homepage`
  and `bugs` URLs in `mcp-server/package.json` — and the documentation URL
  in `addons/playtest/plugin.cfg` — resolve only once it is.
- **Enable 2FA on the npm account.** It protects the account itself, and so
  the ability to revoke everything else.
- **Publish the first version by hand** (`npm login && npm publish`), then
  prefer **Trusted Publishing** to the `NPM_TOKEN` secret for later
  releases: npm exchanges a short-lived OIDC token with GitHub Actions
  instead of storing a long-lived credential, and attaches a public
  provenance attestation. It can only be configured on a package that
  already exists, which is why the first publish is manual. Migrating means
  granting the workflow `id-token: write` and dropping `NODE_AUTH_TOKEN`.
  If you keep a token instead, scope a granular token to this one package
  with an expiry rather than using a classic automation token.

## Godot Asset Library (Bridge addon)

Entirely a **human, external action** — there is no repo automation for
this, and none is planned:

1. Maintainer creates/uses a Godot Asset Library account.
2. Maintainer fills in the submission form on the Asset Library website,
   pointing it at a tagged commit (or release) of this repository and the
   `addons/playtest/` path.
3. **Asset Library review is external and asynchronous.** This repo's
   responsibility ends at submission readiness — the checklist below — not
   at approval timing.

Submission readiness, already satisfied in this repo:

- `addons/playtest/plugin.cfg`: `name`, `description`, `author`, `version`,
  `script` are all set. Godot's plugin.cfg format has no `license` key —
  the license is conveyed by the repo's [`LICENSE`](../LICENSE) file and
  this document, not by inventing a non-standard plugin.cfg key.
- License: MIT ([`LICENSE`](../LICENSE) at the repo root).
- The export guard ships as an ordinary part of the addon folder
  (`export_guard_check.gd`, `activation_policy.gd`) — nothing is stripped
  for packaging, so an addon installed from the Asset Library refuses an
  instrumented release build exactly like a manually-copied one. Verified
  by [`tests/export_guard/`](../tests/export_guard) and
  [`tests/export_guard/activation_policy_test.gd`](../tests/export_guard/activation_policy_test.gd),
  unchanged by this spec.

### When to resubmit

An Asset Library entry points at a specific commit, so installed copies stay
frozen until a new submission clears review. Meanwhile `npx
godot-playtest-mcp` is unpinned and updates itself on every launch — so the
server can drift ahead of an addon that cannot follow. Resubmit when
`PROTOCOL_VERSION` in `addons/playtest/dispatch.gd` changes, since that is
the only version the two sides must agree on (see the anchor section above).
Addon changes that leave the protocol alone can wait for whenever is
convenient; there is no need to resubmit per release.

Since issue #58 this rule no longer rests on process discipline alone: drift
is detected at runtime. The server declares the versions it was built against
(`SUPPORTED_PROTOCOL_VERSION` / `SUPPORTED_STATE_CONTRACT_VERSION` in
`mcp-server/src/protocol.ts` — bump them in lockstep with `dispatch.gd`), and
the `hello` tool attaches a compatibility verdict naming which side to update.
A missed resubmission surfaces as an explicit "update the addon" warning
instead of a bare `unknown_cmd` later.

## What this spec did NOT do

- No git tag was created.
- No real `npm publish` ran (only `npm pack` / `npm publish --dry-run`, for
  verification).
- No Asset Library submission was filed.
- No `NPM_TOKEN` repository secret was added.
- The repository was not made public.

Each of these is a deliberate, one-time action left to the maintainer.
