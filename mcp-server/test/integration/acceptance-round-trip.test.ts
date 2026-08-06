/**
 * Acceptance round trip (spec #66): "a scenario driven live over MCP
 * against two launched clients, frozen, then replayed green through the
 * runner with the harness convention" — the full round trip the map's
 * destination names, proving exactly two clients end to end while the API
 * stays arity-free.
 *
 * Three phases, each exercising a different half of the system:
 * 1. Live: two real `fixtures/witness_game` processes driven over the
 *    actual `Session` API (instance "default" and instance "b"), then torn
 *    down — Freeze captures instance NAMES, never instance configuration
 *    (spec #66), so the live processes need not survive into replay.
 * 2. Freeze: the two-instance trace becomes a frozen GDScript file on disk.
 * 3. Replay: a FRESH process stands in for "the game's own harness" having
 *    launched instance "b" (ADR-0005/ADR-0008 — the addon only attaches);
 *    its port is written under a `PLAYTEST_ATTACH_PORTS` directory as `b`
 *    (the attach contract), and the addon's real headless runner replays
 *    the generated file against it — green, no AI, no fake bridge anywhere
 *    in this phase.
 *
 * Skips cleanly if GODOT_BIN is not provided, same convention as the rest
 * of this directory.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Session } from "../../src/session.js";
import { launchGame, LaunchedGame, stopGame } from "../../src/launch.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..", "..");
const GODOT_BIN = process.env.GODOT_BIN;

test(
  "two clients driven live over MCP, frozen, replayed green through the runner with the harness convention",
  { skip: !GODOT_BIN && "GODOT_BIN not set — export it to run the real-fixture integration test" },
  async () => {
    const session = new Session();
    const launchArgs = { command: GODOT_BIN!, args: ["--path", PROJECT_ROOT, "--headless"] };

    let tmpDir: string | undefined;
    let attachDir: string | undefined;
    let harnessGame: LaunchedGame | undefined;
    let liveInstancesOpen = false;

    try {
      // --- 1. live: two real clients over the Session API ------------------
      await session.launch(launchArgs, "default");
      await session.launch(launchArgs, "b");
      liveInstancesOpen = true;

      await session.assertNowProperty({ test_id: "score_label" }, "text", "0", undefined, undefined, "default");
      await session.call("act.press", { test_id: "score_button" }, undefined, "default");
      await session.call(
        "wait_for",
        { test_id: "score_label", property: "text", equals: "1", timeout_ms: 3000 },
        undefined,
        "default",
      );
      await session.assertEventuallyProperty({ test_id: "score_label" }, "text", "1", undefined, 2000, undefined, "default");

      await session.call("act.press", { test_id: "score_button" }, undefined, "b");
      await session.call(
        "wait_for",
        { test_id: "score_label", property: "text", equals: "1", timeout_ms: 3000 },
        undefined,
        "b",
      );
      await session.assertEventuallyProperty({ test_id: "score_label" }, "text", "1", undefined, 2000, undefined, "b");

      // --- 2. freeze ---------------------------------------------------------
      const { generateFrozenScript, verifySelectorsLive } = await import("../../src/freeze.js");
      const problems = await verifySelectorsLive(session, session.getTrace());
      assert.deepEqual(problems, [], "every selector, on both instances, must still resolve live");

      const generated = generateFrozenScript(session.getTrace(), {
        name: "acceptance round trip",
        scenePath: "res://fixtures/witness_game/main.tscn",
      });
      assert.equal(generated.ciSafe, true);
      assert.match(generated.code, /var b := await attach_instance\("b"\)/);
      assert.doesNotMatch(generated.code, /launch_game/);
      assert.doesNotMatch(generated.code, /bridge-port/);

      tmpDir = mkdtempSync(join(tmpdir(), "godot-playtest-acceptance-"));
      const playtestsDir = join(tmpDir, "playtests");
      mkdirSync(playtestsDir, { recursive: true });
      const filePath = join(playtestsDir, generated.fileName);
      writeFileSync(filePath, generated.code, "utf8");

      // The live phase is done with — replay stands up its own instance "b"
      // (the harness convention below), matching names being the only thing
      // that travels from live to replay (spec #66).
      await session.quitGame("default");
      await session.quitGame("b");
      liveInstancesOpen = false;

      // --- 3. replay: the harness convention ----------------------------------
      attachDir = mkdtempSync(join(tmpdir(), "godot-playtest-attach-ports-"));
      harnessGame = await launchGame(launchArgs);
      // The attach contract (spec #66 §53): filename = instance name,
      // content = the same port-file format --bridge-port-file writes.
      writeFileSync(join(attachDir, "b"), String(harnessGame.port), "utf8");

      const output = execFileSync(
        GODOT_BIN!,
        ["--headless", "--path", PROJECT_ROOT, "res://addons/playtest/runner.tscn", "--", `--suite=${filePath}`],
        { encoding: "utf8", env: { ...process.env, PLAYTEST_ATTACH_PORTS: attachDir } },
      );
      assert.match(output, /1 test\(s\), 0 failure\(s\)/);
      assert.doesNotMatch(output, /FAIL/);
    } finally {
      if (liveInstancesOpen) session.disconnect();
      if (harnessGame) {
        try {
          await stopGame(harnessGame);
        } catch {
          if (harnessGame.process.exitCode === null) harnessGame.process.kill("SIGKILL");
        }
        harnessGame.cleanup();
      }
      if (attachDir) rmSync(attachDir, { recursive: true, force: true });
      if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    }
  },
);
