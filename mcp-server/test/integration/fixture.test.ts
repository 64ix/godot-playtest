/**
 * Integration test against the real headless fixture (criterion #12).
 *
 * Does not use a fake bridge: actually launches `fixtures/witness_game` in
 * `--headless` via `launch_game`, then drives `query`/`act.press`/`wait_for`
 * — exercises launch (port-file + connection retry) and the thin proxy
 * end to end against the real Bridge. Shutdown at the end of the test goes
 * through `stopGame` (ticket #20, protocol verb `quit`), never a direct
 * `kill`.
 *
 * Fails (never skips) if the Godot binary is not provided (spec #55): CI
 * must export GODOT_BIN (see .github/workflows/bridge-conformance.yml for
 * the binary provisioning pattern); locally, `require-godot-bin.js` names
 * the missing variable.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { launchGame, stopGame } from "../../src/launch.js";
import { requireGodotBin } from "./require-godot-bin.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..", "..");

test(
  "launch_game boots the witness_game fixture headless and drives query/act.press/wait_for",
  async () => {
    const GODOT_BIN = requireGodotBin();
    const game = await launchGame({
      command: GODOT_BIN,
      args: ["--path", PROJECT_ROOT, "--headless"],
      portFileTimeoutMs: 30_000,
      connectRetries: 40,
    });

    try {
      const hello = await game.client.send("hello", {});
      assert.equal(hello["ok"], true);
      assert.equal(hello["protocol"], 0);
      // headless: the 'windowed' capability is never advertised (§6).
      assert.deepEqual(hello["capabilities"], []);

      const before = await game.client.send("query", { test_id: "score_label" });
      assert.equal(before["ok"], true);
      const nodesBefore = before["nodes"] as Array<Record<string, unknown>>;
      assert.equal(nodesBefore[0]["text"], "0");

      const press = await game.client.send("act.press", { test_id: "score_button" });
      assert.equal(press["ok"], true);

      const waited = await game.client.send("wait_for", {
        test_id: "score_label",
        property: "text",
        equals: "1",
        timeout_ms: 3_000,
      });
      assert.equal(waited["ok"], true);
      assert.equal((waited["node"] as Record<string, unknown>)["text"], "1");

      // time.step_until (ticket #37): deterministic advance-until-condition,
      // frame-budgeted sibling of wait_for, driven end to end against the
      // real Bridge — "resolves after K steps" (criterion), out-of-order
      // correlation just like wait_for's.
      const stepId = game.client.send("time.step_until", {
        test_id: "score_label",
        property: "text",
        equals: "2",
        max_frames: 180,
      });
      const press2 = await game.client.send("act.press", { test_id: "score_button" });
      assert.equal(press2["ok"], true);
      const stepped = await stepId;
      assert.equal(stepped["ok"], true);
      assert.equal((stepped["node"] as Record<string, unknown>)["text"], "2");
      assert.equal(typeof stepped["frames"], "number");

      // Budget exhaustion resolves as error='timeout' (same code as
      // wait_for), never hanging — and the frame budget is exhausted after
      // *exactly* max_frames engine frames, deterministically, not after a
      // wall-clock-variable duration (extra guardrail #5: proven here by
      // repeating the same never-true scenario and asserting an identical
      // resolution frame count across runs, not merely "eventually times out").
      const budgets: number[] = [];
      for (let i = 0; i < 3; i++) {
        const timedOut = await game.client.send("time.step_until", {
          test_id: "score_label",
          property: "text",
          equals: "__never__",
          max_frames: 7,
        });
        assert.equal(timedOut["ok"], false);
        assert.equal(timedOut["error"], "timeout");
        budgets.push(timedOut["frames"] as number);
      }
      assert.deepEqual(budgets, [7, 7, 7], "the frame budget must exhaust after the same frame count every run");

      // Extra guardrail #5 for the *resolving* path too, not just the
      // timeout path above: the `score_label` resolution earlier depends on
      // when `act.press`'s response arrives, so it only asserts
      // `typeof frames === "number"`, never a pinned value. `true_after_n_frames`
      // flips purely from the fixture's own per-frame state, no second
      // network message involved, so the resolving path itself must also
      // resolve after the same frame count every run.
      const resolvedFrames: number[] = [];
      for (let i = 0; i < 3; i++) {
        const resolved = await game.client.send("time.step_until", {
          test_id: "game",
          method: "true_after_n_frames",
          args: [6],
          equals: true,
          max_frames: 30,
        });
        assert.equal(resolved["ok"], true);
        resolvedFrames.push(resolved["frames"] as number);
      }
      assert.deepEqual(resolvedFrames, [6, 6, 6], "the resolving path must resolve after the same frame count every run");

      // signal mode is deliberately out of scope for time.step_until (a
      // one-shot event doesn't fit a frame budget) — bad_request, never a
      // silent timeout (docs/adr/0007-time-step-until-as-a-new-verb.md).
      const signalRejected = await game.client.send("time.step_until", {
        test_id: "score_button",
        signal: "pressed",
        max_frames: 30,
      });
      assert.equal(signalRejected["ok"], false);
      assert.equal(signalRejected["error"], "bad_request");

      // An unknown selector must surface the Bridge's rich diagnostic as-is
      // (criterion #12: errors are never swallowed).
      const notFound = await game.client.send("query", { test_id: "score_buttn" });
      assert.equal(notFound["ok"], false);
      assert.equal(notFound["error"], "not_found");
      assert.ok((notFound["suggestions"] as string[]).includes("score_button"));

      // headless: screenshot must fail cleanly (§6), never an engine ERROR.
      const screenshot = await game.client.send("screenshot", {});
      assert.equal(screenshot["ok"], false);
      assert.equal(screenshot["error"], "no_renderer");
    } finally {
      // Clean shutdown (ticket #20): `quit` verb then SIGKILL as a last
      // resort — never a direct kill on the nominal run (macOS crash
      // notification + messy exit logs, cf. dogfooding/FRICTIONS.md #4).
      await stopGame(game);
      game.cleanup();
    }
  },
);
