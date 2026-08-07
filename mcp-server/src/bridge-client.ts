/**
 * TCP loopback JSON-lines client for the godot-playtest protocol
 * (docs/protocol/DRAFT-v0.md §2, cf. addons/playtest/transport.gd).
 *
 * Knows nothing about verb semantics: encodes/decodes JSON lines,
 * correlates responses by `id` (§1: the Bridge can respond out of order,
 * notably `wait_for`/`time.frames` which stay queued on the Bridge side
 * until their condition is met).
 */
import { Socket } from "node:net";

export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
/** Margin added to the `timeout_ms` of a `wait_for`: the Bridge must respond
 * (even with `timeout`) before this delay expires on the client side. */
const WAIT_FOR_TIMEOUT_MARGIN_MS = 2_000;
/** Conservative floor used to derive a client-side ceiling from `max_frames`
 * alone (no wall-clock estimate is otherwise possible from a frame count). */
const ASSUMED_MIN_FPS = 10;
/** Default cadence of the per-request progress ticks (spec #9, ticket #14):
 * same 5s as the in-process frozen-test heartbeat. */
const DEFAULT_PROGRESS_INTERVAL_MS = 5_000;
/** Env override for the progress cadence: unit tests shorten it so a slow
 * fake-Bridge wait doesn't sleep 5s. */
const PROGRESS_INTERVAL_ENV = "GODOT_PLAYTEST_PROGRESS_INTERVAL_MS";

export class BridgeTimeoutError extends Error {
  constructor(cmd: string, timeoutMs: number) {
    super(`bridge request '${cmd}' timed out client-side after ${timeoutMs}ms (no response)`);
    this.name = "BridgeTimeoutError";
  }
}

export class BridgeConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BridgeConnectionError";
  }
}

interface Waiter {
  resolve: (resp: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  interval?: NodeJS.Timeout;
  cmd: string;
}

/** One tick of the per-request progress reporter (spec #9, ticket #14),
 * emitted at the heartbeat cadence while a wait verb is in flight. */
export interface WaitProgress {
  /** Wire request id this report belongs to (stable across ticks). */
  id: number;
  /** Human-readable description of the condition being waited on. */
  message: string;
  /** Milliseconds elapsed since the request was sent. */
  elapsedMs: number;
  /** Client-side deadline for the request, in ms. */
  totalMs: number;
}

export interface ConnectOptions {
  host?: string;
  /** Number of connection attempts before giving up (launch_game:
   * the game process may not be listening yet). */
  retries?: number;
  /** Delay between two attempts. */
  retryDelayMs?: number;
}

export class BridgeClient {
  private socket: Socket;
  private buffer = "";
  private nextId = 0;
  private waiters = new Map<number, Waiter>();
  private closed = false;
  readonly host: string;
  readonly port: number;

  private constructor(socket: Socket, host: string, port: number) {
    this.socket = socket;
    this.host = host;
    this.port = port;
    this.socket.setEncoding("utf8");
    this.socket.on("data", (chunk: string) => this.onData(chunk));
    this.socket.on("close", () => this.onClose());
    this.socket.on("error", () => {
      /* handled via 'close': we don't want an uncaught exception */
    });
  }

  /** Opens a connection, with retry (useful for `launch_game`: the game has
   * just started and may not be listening on the port yet). */
  static async connect(port: number, options: ConnectOptions = {}): Promise<BridgeClient> {
    const host = options.host ?? "127.0.0.1";
    const retries = options.retries ?? 1;
    const retryDelayMs = options.retryDelayMs ?? 200;
    let lastErr: Error | undefined;
    for (let attempt = 0; attempt < Math.max(1, retries); attempt++) {
      try {
        return await BridgeClient.connectOnce(host, port);
      } catch (err) {
        lastErr = err as Error;
        if (attempt < retries - 1) {
          await sleep(retryDelayMs);
        }
      }
    }
    throw new BridgeConnectionError(
      `could not connect to bridge at ${host}:${port} after ${retries} attempt(s): ${lastErr?.message}`,
    );
  }

  private static connectOnce(host: string, port: number): Promise<BridgeClient> {
    return new Promise((resolve, reject) => {
      const socket = new Socket();
      const onError = (err: Error) => {
        socket.destroy();
        reject(err);
      };
      socket.once("error", onError);
      socket.connect(port, host, () => {
        socket.removeListener("error", onError);
        socket.setNoDelay(true);
        resolve(new BridgeClient(socket, host, port));
      });
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (line.length === 0) continue;
      this.dispatchLine(line);
    }
  }

  private dispatchLine(line: string): void {
    let resp: Record<string, unknown>;
    try {
      resp = JSON.parse(line);
    } catch {
      return; // non-JSON line: should not happen on the Bridge side, ignored
    }
    const id = resp["id"];
    if (typeof id !== "number") return;
    const waiter = this.waiters.get(id);
    if (!waiter) return; // response to a request already abandoned (client-side timeout)
    this.waiters.delete(id);
    clearTimeout(waiter.timer);
    if (waiter.interval) clearInterval(waiter.interval);
    waiter.resolve(resp);
  }

  private onClose(): void {
    this.closed = true;
    for (const [id, waiter] of this.waiters) {
      clearTimeout(waiter.timer);
      if (waiter.interval) clearInterval(waiter.interval);
      waiter.reject(new BridgeConnectionError(`bridge connection closed before '${waiter.cmd}' (id=${id}) responded`));
    }
    this.waiters.clear();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Sends a verb and waits for its response, correlated by `id`. The id
   * counter is monotonic for the whole lifetime of the connection (§1:
   * correlation is mandatory, including for out-of-order responses).
   *
   * `progress` (spec #9, ticket #14): while the request is in flight, a
   * reporter is ticked at the heartbeat cadence (5s default,
   * `GODOT_PLAYTEST_PROGRESS_INTERVAL_MS` to override) with the condition
   * being waited on and elapsed/total — so a slow wait is distinguishable
   * from a dead one. Only wait verbs pass a reporter (see session.ts);
   * normal-speed waits resolve before the first tick and stay silent. The
   * interval is cleared on every exit path (response, timeout, close). */
  async send(
    cmd: string,
    params: Record<string, unknown> = {},
    timeoutMs?: number,
    progress?: (report: WaitProgress) => void,
  ): Promise<Record<string, unknown>> {
    if (this.closed) {
      throw new BridgeConnectionError("bridge connection is closed");
    }
    const id = ++this.nextId;
    const effectiveTimeout = timeoutMs ?? BridgeClient.timeoutFor(cmd, params);
    const req = { id, cmd, ...params };
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      let interval: NodeJS.Timeout | undefined;
      if (progress !== undefined) {
        interval = setInterval(() => {
          progress({
            id,
            message: describeWaitCondition(cmd, params),
            elapsedMs: Date.now() - startedAt,
            totalMs: effectiveTimeout,
          });
        }, progressIntervalMs());
      }
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        if (interval) clearInterval(interval);
        reject(new BridgeTimeoutError(cmd, effectiveTimeout));
      }, effectiveTimeout);
      this.waiters.set(id, { resolve, reject, timer, interval, cmd });
      this.socket.write(JSON.stringify(req) + "\n", (err) => {
        if (err) {
          this.waiters.delete(id);
          clearTimeout(timer);
          if (interval) clearInterval(interval);
          reject(new BridgeConnectionError(`write failed: ${err.message}`));
        }
      });
    });
  }

  /** `wait_for` and `time.step_until` (ticket #37) carry their own optional
   * `timeout_ms` deadline handled by the Bridge (§4): the client-side timeout
   * must leave it room, and never cut it off earlier. `time.step_until`'s
   * primary budget is `max_frames` (deterministic, no wall-clock estimate
   * possible from it): when `timeout_ms` is unset, a large `max_frames`
   * budget instead extends the client-side wait to a conservative ceiling
   * derived from `ASSUMED_MIN_FPS`, so a big budget resolves with the
   * Bridge's own `{ok:false,error:'timeout'}` instead of throwing
   * `BridgeTimeoutError` client-side first. */
  private static timeoutFor(cmd: string, params: Record<string, unknown>): number {
    if ((cmd === "wait_for" || cmd === "time.step_until") && typeof params["timeout_ms"] === "number") {
      return (params["timeout_ms"] as number) + WAIT_FOR_TIMEOUT_MARGIN_MS;
    }
    if (cmd === "time.step_until" && typeof params["max_frames"] === "number") {
      const maxFrames = params["max_frames"] as number;
      return Math.max(DEFAULT_REQUEST_TIMEOUT_MS, Math.ceil((maxFrames / ASSUMED_MIN_FPS) * 1000) + WAIT_FOR_TIMEOUT_MARGIN_MS);
    }
    return DEFAULT_REQUEST_TIMEOUT_MS;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
  }
}

/** Progress cadence in ms: `GODOT_PLAYTEST_PROGRESS_INTERVAL_MS` overrides
 * the 5s default (tests shorten it; the in-process frozen-test heartbeat
 * runs at the same default cadence, spec #9). Read per request, so a test
 * can set it right before the call it wants to shorten. */
function progressIntervalMs(): number {
  const env = process.env[PROGRESS_INTERVAL_ENV];
  if (env === undefined) return DEFAULT_PROGRESS_INTERVAL_MS;
  const parsed = Number(env);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PROGRESS_INTERVAL_MS;
}

/** Human-readable description of the condition a wait verb is waiting on
 * (spec #9: progress lines must "name the condition", not just the verb):
 * the resolved selector plus the mode fields the Bridge evaluates
 * (`property`/`equals`, `signal`, or the `method`/`args`/`equals` domain
 * query). Values are JSON-serialized so the line is unambiguous. */
function describeWaitCondition(cmd: string, params: Record<string, unknown>): string {
  const parts: string[] = [];
  const selector = ["test_id", "group", "path"].find((key) => params[key] !== undefined);
  if (selector !== undefined) parts.push(`${selector}=${JSON.stringify(params[selector])}`);
  for (const key of ["property", "signal", "method"]) {
    if (params[key] !== undefined) parts.push(`${key}=${JSON.stringify(params[key])}`);
  }
  if (params["args"] !== undefined) parts.push(`args=${JSON.stringify(params["args"])}`);
  if (params["equals"] !== undefined) parts.push(`== ${JSON.stringify(params["equals"])}`);
  return `${cmd} ${parts.join(" ")}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
