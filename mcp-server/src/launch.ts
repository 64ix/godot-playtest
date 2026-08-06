/**
 * `launch_game`: spawns the game process with `--playtest --bridge-port=0`
 * + port-file (docs/protocol/DRAFT-v0.md §2, addons/playtest/transport.gd),
 * then connects with retry — the process has just started and may take a
 * few dozen ms to open its socket (spike #4/#5: median RTT ~8ms once the
 * Bridge is active, but engine boot takes longer).
 *
 * `stopGame` (ticket #20): the symmetric counterpart, clean shutdown of the
 * launched process — `quit` verb then SIGKILL as a last resort (never
 * SIGTERM, see `stopGame`'s doc).
 */
import { ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeClient, BridgeConnectionError } from "./bridge-client.js";

export interface LaunchGameOptions {
  /** Binary/executable to launch (Godot editor binary or a game export). */
  command: string;
  /** Arguments *before* the `--` separator (e.g. `--path`, `.`, `--headless`). */
  args?: string[];
  /** Additional user arguments *after* `--playtest` (e.g. custom seeds). */
  extraGameArgs?: string[];
  cwd?: string;
  /** Additional environment variables for the game process, merged on top of
   * `process.env` (never a replacement: the game keeps PATH, HOME, etc.). The
   * standard channel for pointing a game at an ephemeral test backend
   * (host/database/feature flags) without touching its arguments — cf.
   * docs/INSTRUMENTATION.md. */
  env?: Record<string, string>;
  /** Max wait for the port-file (the engine must finish booting). */
  portFileTimeoutMs?: number;
  /** TCP connection attempts once the port is known. */
  connectRetries?: number;
  connectRetryDelayMs?: number;
}

export interface LaunchedGame {
  client: BridgeClient;
  process: ChildProcess;
  port: number;
  /** Cleans up the temporary port-file (the process itself stays managed by
   * the caller: `close()` on the client does not kill the game). */
  cleanup: () => void;
}

const DEFAULT_PORT_FILE_TIMEOUT_MS = 30_000;
const PORT_FILE_POLL_INTERVAL_MS = 100;

/** Launches the game with `--playtest --bridge-port=0 --bridge-port-file=<tmp>`,
 * waits for the port file to appear (the Bridge writes it as soon as it has
 * bound its port, cf. transport.gd `listen()`), then connects. */
export async function launchGame(options: LaunchGameOptions): Promise<LaunchedGame> {
  const tmpDir = mkdtempSync(join(tmpdir(), "godot-playtest-"));
  const portFile = join(tmpDir, "bridge-port");
  const cleanup = () => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  };

  const fullArgs = [
    ...(options.args ?? []),
    "--",
    "--playtest",
    "--bridge-port=0",
    `--bridge-port-file=${portFile}`,
    ...(options.extraGameArgs ?? []),
  ];

  const child = spawn(options.command, fullArgs, {
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : undefined,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let spawnError: Error | undefined;
  child.once("error", (err) => {
    spawnError = err;
  });

  try {
    const port = await waitForPortFile(portFile, options.portFileTimeoutMs ?? DEFAULT_PORT_FILE_TIMEOUT_MS, () => {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) {
        throw new BridgeConnectionError(
          `game process exited (code=${child.exitCode}) before writing the bridge port file`,
        );
      }
    });
    const client = await BridgeClient.connect(port, {
      retries: options.connectRetries ?? 20,
      retryDelayMs: options.connectRetryDelayMs ?? 150,
    });
    return { client, process: child, port, cleanup };
  } catch (err) {
    cleanup();
    // SIGKILL, not the default SIGTERM: same rationale as `stopGame` — the
    // .NET runtime of a Godot mono build turns SIGTERM into a SIGABRT crash
    // (OS crash popup + report), while SIGKILL leaves no trace.
    if (child.exitCode === null) child.kill("SIGKILL");
    throw err;
  }
}

export interface StopGameOptions {
  /** Grace period after the `quit` verb before escalating to SIGKILL (§ticket #20). Default 5000ms. */
  quitGraceMs?: number;
  /** Max wait for the process to disappear after the last-resort SIGKILL. Default 3000ms. */
  killGraceMs?: number;
}

const DEFAULT_QUIT_GRACE_MS = 5_000;
const DEFAULT_KILL_GRACE_MS = 3_000;

/**
 * Clean shutdown of the game process launched by `launchGame` (ticket #20):
 * sends the protocol's `quit` verb (the Bridge responds then calls
 * `get_tree().quit()`, DRAFT-v0.md §4) and waits for the process to exit
 * naturally. If the socket is already closed, or the process doesn't exit
 * within the grace period, escalates straight to SIGKILL — never SIGTERM:
 * the .NET runtime embedded in Godot mono builds intercepts SIGTERM and
 * calls `exit()` from a secondary thread, which runs Godot's C++ static
 * destructors while other threads are still alive (`StringName::unref()`
 * locks an already-destroyed mutex) → SIGABRT, i.e. the very OS crash
 * popup + report this escalation ladder exists to avoid
 * (dogfooding/FRICTIONS.md #4). SIGKILL bypasses signal handlers entirely
 * and leaves no crash report; the graceful path is the `quit` verb, which
 * this function has already exhausted by the time it signals anything.
 */
export async function stopGame(game: LaunchedGame, options: StopGameOptions = {}): Promise<void> {
  const { process: child, client } = game;
  const quitGraceMs = options.quitGraceMs ?? DEFAULT_QUIT_GRACE_MS;
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

  if (hasExited(child)) {
    client.close();
    return;
  }

  if (!client.isClosed) {
    try {
      await client.send("quit", {}, quitGraceMs);
    } catch {
      /* process already dead, or no response within the delay — falls back to SIGKILL below */
    }
  }
  client.close();
  if (await waitForExit(child, quitGraceMs)) return;

  child.kill("SIGKILL");
  await waitForExit(child, killGraceMs);
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (hasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    function onExit(): void {
      clearTimeout(timer);
      resolve(true);
    }
    child.once("exit", onExit);
  });
}

async function waitForPortFile(path: string, timeoutMs: number, checkAlive: () => void): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    checkAlive();
    if (existsSync(path)) {
      const content = readFileSync(path, "utf8").trim();
      const port = parseInt(content, 10);
      if (!Number.isNaN(port) && port > 0) {
        return port;
      }
    }
    await sleep(PORT_FILE_POLL_INTERVAL_MS);
  }
  throw new BridgeConnectionError(`timed out after ${timeoutMs}ms waiting for bridge port file '${path}'`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
