#!/usr/bin/env node
/**
 * Generates the golden path frozen tests for freeze (ticket #13, "CI golden
 * test" criterion; ticket #39 adds the second scenario below): explores
 * `fixtures/witness_game` PROGRAMMATICALLY (no AI — the same primitives an
 * agent would use via the MCP tools), asserts, then freezes via
 * `freeze_scenario`.
 *
 * The generated files are committed to `res://playtests/generated/`: the
 * runner's discovery (`runner.gd _discover`) is recursive, so this script
 * automatically joins the golden path already replayed x20 by
 * `.github/workflows/playtestcase-runner.yml` — no extra CI to write for
 * either scenario.
 *
 * Usage: GODOT_BIN=<binary> node mcp-server/scripts/generate-golden-freeze.mjs
 * Re-running this script regenerates the files identically (deterministic) —
 * rerun it if a reference scenario changes.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Session } from "../dist/session.js";
import { generateFrozenScript, verifySelectorsLive } from "../dist/freeze.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..");
const GODOT_BIN = process.env.GODOT_BIN;

if (!GODOT_BIN) {
  console.error("GODOT_BIN must be set (Godot 4.6.3 binary).");
  process.exit(1);
}

const outDir = join(PROJECT_ROOT, "playtests", "generated");
mkdirSync(outDir, { recursive: true });

/** Runs `body(session)` against a freshly launched fixture, always cleaning
 * up the game process afterwards (ticket #20) — shared by both scenarios
 * below so each gets a clean fixture (fresh `score` counter, fresh
 * `step_until_probe_target_frame`), never carrying over state from the
 * other. */
async function withSession(body) {
  const session = new Session();
  await session.launch({
    command: GODOT_BIN,
    args: ["--path", PROJECT_ROOT, "--headless"],
    portFileTimeoutMs: 30_000,
    connectRetries: 40,
  });
  try {
    await body(session);
  } finally {
    try {
      await session.quitGame();
    } catch {
      const process_ = session.getLaunchedProcess();
      session.disconnect();
      if (process_ && process_.exitCode === null) process_.kill("SIGKILL");
    }
  }
}

function writeGenerated(generated) {
  const outPath = join(outDir, generated.fileName);
  writeFileSync(outPath, generated.code, "utf8");
  console.log(`wrote ${outPath} (ci_safe=${generated.ciSafe})`);
}

// Scenario 1 (ticket #13): press -> wait_for -> assert_now/eventually_property.
await withSession(async (session) => {
  // Nothing has happened yet: a `now` check, no retry needed.
  await session.assertNowProperty({ test_id: "score_label" }, "text", "0", undefined);

  const press = await session.call("act.press", { test_id: "score_button" });
  if (press["ok"] !== true) throw new Error(`act.press failed: ${JSON.stringify(press)}`);

  const waited = await session.call("wait_for", {
    test_id: "score_label",
    property: "text",
    equals: "1",
    timeout_ms: 3000,
  });
  if (waited["ok"] !== true) throw new Error(`wait_for failed: ${JSON.stringify(waited)}`);

  // Already at "1" (wait_for above just waited for it), demonstrated here
  // via the retrying form.
  await session.assertEventuallyProperty({ test_id: "score_label" }, "text", "1", undefined, 2000);

  const problems = await verifySelectorsLive(session, session.getTrace());
  if (problems.length > 0) {
    throw new Error(`selectors no longer resolve live: ${JSON.stringify(problems)}`);
  }

  writeGenerated(
    generateFrozenScript(session.getTrace(), {
      name: "generated score button increments",
      scenePath: "res://fixtures/witness_game/main.tscn",
    }),
  );
});

// Scenario 2 (ticket #39): time.step_until, frame-budgeted and deterministic
// — a separate scenario rather than folding this into scenario 1 above, so
// neither story is distorted by the other's concerns (extra guardrail #3).
// `true_after_n_frames` (fixtures/witness_game/main.gd) flips purely from
// the fixture's own per-frame state, so the advance resolves after exactly
// `n` engine frames every run — the same mechanism
// `check_step_until_resolves_after_n_frames` (tests/conformance/scenario.py)
// and the runner parity fixture (tests/runner/fixtures/step_until_parity/)
// already pin.
await withSession(async (session) => {
  const stepped = await session.call("time.step_until", {
    test_id: "game",
    method: "true_after_n_frames",
    args: [6],
    equals: true,
    max_frames: 30,
  });
  if (stepped["ok"] !== true) throw new Error(`time.step_until failed: ${JSON.stringify(stepped)}`);
  if (stepped["frames"] !== 6) {
    throw new Error(`time.step_until resolved after ${stepped["frames"]} frame(s), expected exactly 6`);
  }

  const problems = await verifySelectorsLive(session, session.getTrace());
  if (problems.length > 0) {
    throw new Error(`selectors no longer resolve live: ${JSON.stringify(problems)}`);
  }

  writeGenerated(
    generateFrozenScript(session.getTrace(), {
      name: "generated step until advances deterministically",
      scenePath: "res://fixtures/witness_game/main.tscn",
    }),
  );
});
