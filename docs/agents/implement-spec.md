# Implement-spec conventions

This repo uses the `implement-spec` runner. The runner keeps **no config file**:
on every run it derives the base branch and the commands that validate a change
from this project's own docs (the `## Agent skills` block in `CLAUDE.md`, the
coding-standards doc, CI workflows, build manifests) and from git, and echoes
what it resolved before it changes anything.

This file records the **spec conventions** — the glue between the `to-spec` /
`to-tickets` skills and the runner — plus the validation facts the runner can't
reliably infer on its own.

## How this project is validated

This repo declares **no root-level test or build script**. The gate below is not
discoverable from a manifest: it is spread across the five
`.github/workflows/*.yml` files. Read it from here rather than recomposing it
from CI.

### Prerequisite: `GODOT_BIN`

Every Godot step needs a **Godot 4.6.3** binary. CI provisions its own
(`4.6.3-stable`, standard Linux build); locally, export the path first:

```bash
export GODOT_BIN=/Applications/Godot_mono.app/Contents/MacOS/Godot
```

The local binary is a Mono build (`4.6.3.stable.mono`); the addon is GDScript
(ADR-0002), so Mono vs standard makes no difference to the gate.

### Test command (the gate)

Run from the worktree root. Step 0 is a once-per-worktree prerequisite whose
exit code is ignored; **steps 1–7 must all pass** — that is what validates a
change.

```bash
# 0. Once per fresh worktree: first open of the project. Every Godot step
#    below fails without it. `|| true` is intentional — the import pass
#    reports a nonzero exit on its first run.
"$GODOT_BIN" --headless --path . --import || true

# 1. MCP server: unit tests (fake Bridge) + integration (real fixture).
#    test:integration reads GODOT_BIN from the environment.
cd mcp-server && npm ci && npm run build && npm test && npm run test:integration
cd ..

# 2. Bridge conformance: hello, query, selectors, errors. CI runs this ×20 to
#    catch flakes; one pass is the local gate.
python3 tests/conformance/scenario.py "$GODOT_BIN" . 4242

# 3. Transport liveness guard: _pending purged, Transport.send no-op.
"$GODOT_BIN" --headless --path . --script res://tests/conformance/transport_liveness_test.gd

# 4. Headless runner: golden path + broken selector diagnostics, then the
#    two-process multi-client driver (per-instance addressing).
python3 tests/runner/test_runner.py "$GODOT_BIN" .
python3 tests/runner/test_multi_client.py "$GODOT_BIN" .

# 5. Reference frozen test. CI runs this ×20; one pass is the local gate.
"$GODOT_BIN" --headless --path . res://addons/playtest/runner.tscn -- --suite=res://playtests/

# 6. Export guard fixtures: instrumented prod build fails, legitimate passes.
python3 tests/export_guard/test_export_guard.py "$GODOT_BIN" .

# 7. Activation policy: release without the feature refused, otherwise starts.
"$GODOT_BIN" --headless --path . --script res://tests/export_guard/activation_policy_test.gd
```

Last verified green end-to-end at `e2fc6dc` (2026-07-28); gate-covered files
(`playtestcase.gd`, `test_runner.py`, `mcp-server/src`) have changed on `main`
since — re-run the gate rather than relying on this claim.

### Build / format

- **Build:** `cd mcp-server && npm run build` (`tsc`). Already covered by gate
  step 1 — run it alone only for a fast TypeScript check. `mcp-server/` uses
  **npm** (`package-lock.json`); there is no root-level package manifest.
- **Format:** none. The repo has no formatter config — no Prettier, ESLint, or
  gdformat anywhere. Do not introduce one as a side effect of a spec: match the
  surrounding style instead.

### E2E gate (infra-dependent)

The dogfooding golden path from `.github/workflows/dogfooding-tps-demo.yml`:

```bash
dogfooding/setup-tps-demo.sh
"$GODOT_BIN" --headless --path .dogfood/tps-demo --import || true
mkdir -p .dogfood/tps-demo/playtests && cp dogfooding/playtests/*.gd .dogfood/tps-demo/playtests/
"$GODOT_BIN" --headless --path .dogfood/tps-demo res://addons/playtest/runner.tscn -- --suite=res://playtests/
```

**Infrastructure it needs:** an instrumented clone of `godotengine/tps-demo` at
`.dogfood/tps-demo` (gitignored, ~800 MB of assets), plus its imported cache.
A cold clone + first import takes several minutes; `setup-tps-demo.sh` is a
near-no-op once the clone exists. Because the bench lives outside the worktree,
this gate is **not** reachable from a fresh `implement-spec` worktree by default.

Agents try to run it live and report status **`not-run`** when the bench is
absent — never a pass, never a failure. The final integration review is the last
gate expected to run it live.

## Spec conventions

These conventions connect the `to-spec` / `to-tickets` skills to the runner.
Skills that publish or consume specs in this repo follow them:

- A spec issue is titled `[Spec] <feature name>` and carries a
  `## Success Criteria` checklist alongside the usual spec sections.
- A spec is either **autosufficient** (small enough to implement directly) or
  **split** into child tickets. Decide when publishing: apply the
  `ready-for-agent` label to an autosufficient spec; when the spec is split,
  leave the spec unlabelled (it is a container, carrying only `spec`) and apply
  `ready-for-agent` to the child tickets instead.
- Child tickets are linked to their spec as native GitHub **sub-issues**; where
  sub-issues aren't available, a `## Parent` section naming the spec is the
  fallback. Dependencies between tickets use native **blocked-by**
  relationships, with a `## Blocked by` section as the fallback.
- `/implement-spec` implements exactly one spec: directly when autosufficient,
  through its child tickets otherwise. It never merges the PR it opens.
