/**
 * Golden CI test for freeze (criterion #13): a reference scenario is
 * explored PROGRAMMATICALLY against `fixtures/witness_game` (no AI —
 * a script that calls the same primitives an agent would: `act.press`,
 * `wait_for`, `assert_now_property`, `assert_eventually_property`), then
 * frozen via `freeze_scenario`. The
 * generated GDScript is then replayed by the addon's real headless runner —
 * this test is what proves that "freeze -> the generated test passes"
 * holds end to end, not just against a fake Bridge.
 *
 * Fails (never skips) if GODOT_BIN is not provided (spec #55, same
 * convention as fixture.test.ts).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Session } from "../../src/session.js";
import { requireGodotBin } from "./require-godot-bin.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..", "..");

test(
  "freeze_scenario turns a programmatically-explored scenario into a frozen test the headless runner passes",
  async () => {
    const GODOT_BIN = requireGodotBin();
    const session = new Session();
    await session.launch({
      command: GODOT_BIN,
      args: ["--path", PROJECT_ROOT, "--headless"],
      portFileTimeoutMs: 30_000,
      connectRetries: 40,
    });

    let tmpDir: string | undefined;
    try {
      // Programmatic exploration — same verbs an agent would use via the
      // MCP tools, calling directly the Session methods (`call`/
      // `assertNowProperty`/`assertEventuallyProperty`) they translate to.
      const before = await session.call("query", { test_id: "score_label" });
      assert.equal(before["ok"], true);

      // Nothing has happened yet: a `now` check, no retry needed.
      await session.assertNowProperty({ test_id: "score_label" }, "text", "0", undefined);

      const press = await session.call("act.press", { test_id: "score_button" });
      assert.equal(press["ok"], true);

      const waited = await session.call("wait_for", {
        test_id: "score_label",
        property: "text",
        equals: "1",
        timeout_ms: 3000,
      });
      assert.equal(waited["ok"], true);

      // Already at "1" (wait_for above just waited for it), demonstrated
      // here via the retrying form (ticket #35 criterion: freeze must still
      // emit the matching in-process call and replay green).
      await session.assertEventuallyProperty({ test_id: "score_label" }, "text", "1", undefined, 2000);

      assert.equal(session.getTrace().length, 4, "press + wait_for + 2 assertions");

      tmpDir = mkdtempSync(join(tmpdir(), "godot-playtest-golden-freeze-"));

      // Import module dynamically to avoid a hard dependency at file top for
      // the (frequent) case GODOT_BIN is unset, where `requireGodotBin()`
      // already threw before this point is ever reached.
      const { generateFrozenScript, verifySelectorsLive } = await import("../../src/freeze.js");
      const problems = await verifySelectorsLive(session, session.getTrace());
      assert.deepEqual(problems, [], "every selector must still resolve live at generation time");

      const generated = generateFrozenScript(session.getTrace(), {
        name: "golden score button",
        scenePath: "res://fixtures/witness_game/main.tscn",
      });
      assert.equal(generated.ciSafe, true);

      const { mkdirSync, writeFileSync } = await import("node:fs");
      const playtestsDir = join(tmpDir, "playtests");
      mkdirSync(playtestsDir, { recursive: true });
      const filePath = join(playtestsDir, generated.fileName);
      writeFileSync(filePath, generated.code, "utf8");

      // Replay the generated script with the addon's real headless runner,
      // from the repo (the runner + PlaytestCase live in addons/playtest/
      // of the current project), but targeting the freshly generated suite.
      const output = execFileSync(
        GODOT_BIN,
        ["--headless", "--path", PROJECT_ROOT, "res://addons/playtest/runner.tscn", "--", `--suite=${toResUri(playtestsDir, PROJECT_ROOT)}`],
        { encoding: "utf8" },
      );
      assert.match(output, /0 failure/);
      assert.doesNotMatch(output, /FAIL/);
    } finally {
      // Clean shutdown (ticket #20): `quit` verb then SIGKILL as a last
      // resort (quitGame internally calls stopGame then disconnect) —
      // never a direct kill on the nominal run.
      try {
        await session.quitGame();
      } catch {
        const process = session.getLaunchedProcess();
        session.disconnect();
        if (process && process.exitCode === null) process.kill("SIGKILL");
      }
      if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    }
  },
);

test(
  "freeze_scenario captures a resolving time.step_until into the trace and replays it green, headless, repeatedly (ticket #39)",
  async () => {
    const GODOT_BIN = requireGodotBin();
    const session = new Session();
    await session.launch({
      command: GODOT_BIN,
      args: ["--path", PROJECT_ROOT, "--headless"],
      portFileTimeoutMs: 30_000,
      connectRetries: 40,
    });

    let tmpDir: string | undefined;
    try {
      // `true_after_n_frames` (fixtures/witness_game/main.gd) flips purely
      // from the fixture's own per-frame state — the same deterministic
      // mechanism tests/conformance/scenario.py's
      // `check_step_until_resolves_after_n_frames` and the runner parity
      // fixture (tests/runner/fixtures/step_until_parity/) already pin — so
      // it resolves after exactly 6 engine frames, reproducibly.
      const stepped = await session.call("time.step_until", {
        test_id: "game",
        method: "true_after_n_frames",
        args: [6],
        equals: true,
        max_frames: 30,
      });
      assert.equal(stepped["ok"], true);
      assert.equal(stepped["frames"], 6);

      // Before this ticket, time.step_until was a KNOWN_UNRECORDED_ACTION_VERB
      // (session.ts): the call above would have left the trace empty and only
      // logged a stderr warning. It must now be captured like any other
      // replayable verb.
      const trace = session.getTrace();
      assert.equal(trace.length, 1, "time.step_until must be captured into the session trace");
      assert.equal(trace[0].kind, "verb");
      assert.equal((trace[0] as { cmd: string }).cmd, "time.step_until");

      tmpDir = mkdtempSync(join(tmpdir(), "godot-playtest-step-until-freeze-"));

      const { generateFrozenScript, verifySelectorsLive } = await import("../../src/freeze.js");
      const problems = await verifySelectorsLive(session, session.getTrace());
      assert.deepEqual(problems, [], "every selector must still resolve live at generation time");

      const generated = generateFrozenScript(session.getTrace(), {
        name: "step until advances deterministically",
        scenePath: "res://fixtures/witness_game/main.tscn",
      });
      assert.equal(generated.ciSafe, true);
      assert.match(
        generated.code,
        /await time_step_until\(\{"test_id": "game"\}, \{"method": "true_after_n_frames", "args": \[6\], "equals": true, "max_frames": 30\}\)/,
      );

      const { mkdirSync, writeFileSync } = await import("node:fs");
      const playtestsDir = join(tmpDir, "playtests");
      mkdirSync(playtestsDir, { recursive: true });
      const filePath = join(playtestsDir, generated.fileName);
      writeFileSync(filePath, generated.code, "utf8");

      // Replay with the addon's real headless runner, repeatedly (extra
      // guardrail #4): the golden-path-x20 CI job will replay this exact
      // frozen test 20 times once it ships under playtests/generated/ — a
      // handful of repeats here catches flakiness before CI does. A missing
      // `await` on the generated line, or a wrong opts dict causing the
      // in-process `time_step_until` to exhaust its budget, would both
      // surface as a non-zero exit / FAIL here — a fake-bridge unit test
      // cannot catch either.
      for (let i = 0; i < 5; i++) {
        const output = execFileSync(
          GODOT_BIN,
          [
            "--headless",
            "--path",
            PROJECT_ROOT,
            "res://addons/playtest/runner.tscn",
            "--",
            `--suite=${toResUri(playtestsDir, PROJECT_ROOT)}`,
          ],
          { encoding: "utf8" },
        );
        assert.match(output, /0 failure/, `run ${i}: expected 0 failure`);
        assert.doesNotMatch(output, /FAIL/, `run ${i}: unexpected FAIL`);
      }
    } finally {
      try {
        await session.quitGame();
      } catch {
        const process = session.getLaunchedProcess();
        session.disconnect();
        if (process && process.exitCode === null) process.kill("SIGKILL");
      }
      if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    }
  },
);

/** The runner expects a `res://...` path relative to the project — the
 * temp folder generated here lives outside the project, hence outside
 * `res://`. For this test, we cheat by passing an absolute path: Godot's
 * `DirAccess.open` accepts a native OS path just as well as a `res://` one
 * (see runner.gd `_discover`, which makes no assumption about the scheme). */
function toResUri(absPath: string, _projectRoot: string): string {
  return absPath;
}
