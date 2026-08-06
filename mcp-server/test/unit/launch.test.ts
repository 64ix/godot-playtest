import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { launchGame, stopGame } from "../../src/launch.js";
import { BridgeConnectionError } from "../../src/bridge-client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_GAME = join(__dirname, "..", "helpers", "fake-game.mjs");

test("launchGame passes --playtest, --bridge-port=0 and --bridge-port-file after '--'", async () => {
  const game = await launchGame({
    command: process.execPath,
    args: [FAKE_GAME, "--path", "."],
  });
  try {
    const resp = await game.client.send("hello", {});
    assert.equal(resp["ok"], true);
    assert.ok(game.port > 0);
  } finally {
    game.client.close();
    game.process.kill();
    game.cleanup();
  }
});

test("launchGame retries the port-file wait until the bridge has bound its port", async () => {
  const prevDelay = process.env.FAKE_GAME_DELAY_MS;
  // The port-file only appears after several poll cycles
  // (PORT_FILE_POLL_INTERVAL_MS=100ms in launch.ts): this test actually
  // exercises the wait/retry, not just the immediate case.
  process.env.FAKE_GAME_DELAY_MS = "350";
  try {
    const game = await launchGame({
      command: process.execPath,
      args: [FAKE_GAME],
      portFileTimeoutMs: 5_000,
    });
    try {
      assert.ok(game.port > 0);
      const resp = await game.client.send("hello", {});
      assert.equal(resp["ok"], true);
    } finally {
      game.client.close();
      game.process.kill();
      game.cleanup();
    }
  } finally {
    if (prevDelay === undefined) delete process.env.FAKE_GAME_DELAY_MS;
    else process.env.FAKE_GAME_DELAY_MS = prevDelay;
  }
});

test("launchGame merges custom env vars over the inherited environment", async () => {
  const prevParent = process.env.FAKE_GAME_ENV_PARENT;
  process.env.FAKE_GAME_ENV_PARENT = "inherited";
  try {
    const game = await launchGame({
      command: process.execPath,
      args: [FAKE_GAME],
      env: { FAKE_GAME_ENV_PROBE: "from-launch-env" },
    });
    try {
      const resp = await game.client.send("hello", {});
      assert.equal(resp["ok"], true);
      // The variable passed via `env` reaches the game process...
      assert.equal(resp["env_probe"], "from-launch-env");
      // ...without replacing the inherited environment (merge, never a reset).
      assert.equal(resp["env_parent"], "inherited");
    } finally {
      game.client.close();
      game.process.kill();
      game.cleanup();
    }
  } finally {
    if (prevParent === undefined) delete process.env.FAKE_GAME_ENV_PARENT;
    else process.env.FAKE_GAME_ENV_PARENT = prevParent;
  }
});

test("launchGame surfaces a clear error if the port-file never appears in time", async () => {
  const prevDelay = process.env.FAKE_GAME_DELAY_MS;
  process.env.FAKE_GAME_DELAY_MS = "2000"; // > portFileTimeoutMs below
  try {
    await assert.rejects(
      () =>
        launchGame({
          command: process.execPath,
          args: [FAKE_GAME],
          portFileTimeoutMs: 300,
        }),
      BridgeConnectionError,
    );
  } finally {
    if (prevDelay === undefined) delete process.env.FAKE_GAME_DELAY_MS;
    else process.env.FAKE_GAME_DELAY_MS = prevDelay;
  }
});

test("stopGame lets the process exit on its own via the 'quit' verb (no kill needed)", async () => {
  const game = await launchGame({ command: process.execPath, args: [FAKE_GAME] });
  await stopGame(game, { quitGraceMs: 2_000, killGraceMs: 2_000 });
  // exitCode 0 without a signal: the process left via get_tree().quit(),
  // stopGame never had to escalate (an escalation would end in SIGKILL).
  assert.equal(game.process.exitCode, 0);
  assert.equal(game.process.signalCode, null);
  game.cleanup();
});

test("stopGame escalates directly to SIGKILL when the process ignores 'quit' — never SIGTERM", async () => {
  const prevQuitMode = process.env.FAKE_GAME_QUIT_MODE;
  process.env.FAKE_GAME_QUIT_MODE = "ignore";
  try {
    const game = await launchGame({ command: process.execPath, args: [FAKE_GAME] });
    await stopGame(game, { quitGraceMs: 300, killGraceMs: 2_000 });
    // The fake game exits 0 on SIGTERM (tripwire): ending on SIGKILL proves
    // stopGame never sent SIGTERM — which crashes Godot .NET builds into an
    // OS crash popup (see stopGame's doc).
    assert.equal(game.process.signalCode, "SIGKILL");
    game.cleanup();
  } finally {
    if (prevQuitMode === undefined) delete process.env.FAKE_GAME_QUIT_MODE;
    else process.env.FAKE_GAME_QUIT_MODE = prevQuitMode;
  }
});

test("launchGame fails fast if the game process exits before writing the port file", async () => {
  const prevEnv = process.env.FAKE_GAME_EXIT_EARLY;
  process.env.FAKE_GAME_EXIT_EARLY = "1";
  try {
    await assert.rejects(
      () =>
        launchGame({
          command: process.execPath,
          args: [FAKE_GAME],
          portFileTimeoutMs: 5_000,
        }),
      BridgeConnectionError,
    );
  } finally {
    if (prevEnv === undefined) delete process.env.FAKE_GAME_EXIT_EARLY;
    else process.env.FAKE_GAME_EXIT_EARLY = prevEnv;
  }
});
