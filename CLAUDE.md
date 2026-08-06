# CLAUDE.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

Write any code, comment, documentation **and file or directory name** in English language.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

## 5. Release Actions Are Human-Only

**Never publish, tag, or change the distribution surface. Propose it instead.**

Pushing a `v*` tag is the sole trigger of
`.github/workflows/release-mcp-server.yml`, which runs `npm publish`. npm never
lets a published version be overwritten, and refuses to unpublish after 72
hours — so a mistaken release is permanent. Do not run:

- `git tag v*`, `git push --tags`, `git push --follow-tags`
- `npm publish`, `npm version`, `npm unpublish`, `npm deprecate`, `npm dist-tag`
- `gh release create`
- anything that changes repository visibility

Bumping `version` in `mcp-server/package.json` or `addons/playtest/plugin.cfg`
is a maintainer decision too — propose it, do not do it.

A `pre-push` hook in [`.githooks/`](.githooks/pre-push) enforces the tag rule
(enable per clone: `git config core.hooksPath .githooks`). See
[docs/RELEASE.md](docs/RELEASE.md) for the process and for which steps only a
human can perform.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

## Agent skills

### Spec implementation runner

Base branch `main`. Coding standards are the guidelines above, in this file —
there is no separate standards doc. Specs follow the conventions in
`docs/agents/implement-spec.md`.

Every gate command needs a Godot 4.6.3 binary in `GODOT_BIN`; CI downloads its
own, so locally export it first:

```bash
export GODOT_BIN=/Applications/Godot_mono.app/Contents/MacOS/Godot
```

**The gate** is the seven-step sequence in
[docs/agents/implement-spec.md](docs/agents/implement-spec.md) — run from the
worktree root, all seven passing. It is not a single command: this repo has no
`test` script at the root, and the gate spans four `.github/workflows/*.yml`
files (Godot conformance, MCP server, runner, export guard); a fifth,
`dogfooding-tps-demo.yml`, backs the separate infra-dependent E2E gate carved
out in that file, not the mandatory seven steps. Do not try to recompose it
from CI — read it from that file.

Before the first of those steps, a **fresh worktree needs one import pass**
(`"$GODOT_BIN" --headless --path . --import || true`, step 0 in that file — its
exit code is deliberately ignored); every Godot step fails without it.

**Build:** `cd mcp-server && npm run build` (already covered by gate step 1 —
run it alone only for a quick TypeScript check). **Format:** none — the repo has
no formatter config (no Prettier, ESLint, or gdformat), so leave formatting
alone and match surrounding style.