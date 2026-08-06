/**
 * MCP server session state: a NAMED MAP of Bridge connections (spec #66) —
 * instance 0 is the `"default"` slot, unchanged in behavior from before this
 * spec; further named slots let an agent drive several connected clients at
 * once (the story #66 exists for: assertions *between* two connected
 * clients). `launch_game`/`attach` establish a slot (add-not-replace: only
 * their own named slot is replaced, cf. `launch`/`attach` below); every
 * other tool requires the slot it addresses (default `"default"`) already
 * open.
 */
import { BridgeClient } from "./bridge-client.js";
import { launchGame, LaunchGameOptions, LaunchedGame, StopGameOptions, stopGame } from "./launch.js";
import { assertValidNewInstanceName, DEFAULT_INSTANCE } from "./instance-name.js";
import { AssertionTraceEntry, Selector, TraceEntry, isReplayableVerb } from "./trace.js";
import { ProgressReporter } from "./progress.js";

/** Wait verbs whose Bridge-side wait can span the progress cadence (spec #9,
 * ticket #14): `time.frames` is excluded — it is a deterministic sync point
 * with no condition and no deadline (DRAFT-v0.md §4). */
const WAIT_VERBS = new Set(["wait_for", "time.step_until"]);

export class NotConnectedError extends Error {
  readonly instance: string;
  constructor(instance: string = DEFAULT_INSTANCE) {
    super(
      `not attached to a Bridge for instance '${instance}' — call 'launch_game' or 'attach' first` +
        (instance === DEFAULT_INSTANCE ? "" : ` (with instance: "${instance}")`),
    );
    this.name = "NotConnectedError";
    this.instance = instance;
  }
}

interface ConnectionSlot {
  client: BridgeClient;
  launched: LaunchedGame | null;
  launchCwd: string | undefined;
}

/** A `not_found`/`ambiguous` Bridge response, annotated with the instance it
 * was searched against (spec #66 criterion "diagnostics name the instance
 * searched") — purely a client-side (MCP layer) annotation of the response
 * object handed back to the agent; the wire itself never carries `instance`. */
function annotateInstance(response: Record<string, unknown>, instance: string): Record<string, unknown> {
  if (response["ok"] === false && (response["error"] === "not_found" || response["error"] === "ambiguous")) {
    return { ...response, instance };
  }
  return response;
}

export class Session {
  private connections = new Map<string, ConnectionSlot>();

  /** Progress reporter (spec #9, ticket #14): threaded into `BridgeClient.send`
   * for wait verbs, so a slow `wait_for`/`time.step_until` emits `$/progress`
   * notifications and server console lines naming the condition and
   * elapsed/total. Defaults to a no-op (unit tests of the session alone). */
  constructor(private readonly progress: ProgressReporter = () => {}) {}

  /** Session trace (ticket #13): replayable verbs + assertions the agent has
   * set, in order — raw material for `freeze_scenario`. One trace for the
   * whole session, spanning every instance (spec #66): resetting it on every
   * `launch`/`attach` would erase what a second/third client already
   * contributed, defeating multi-client scenarios. Reset only when the
   * connection map was empty (or held only the slot being replaced) right
   * before the call — i.e. this really is the start of a fresh scenario,
   * the exact condition under which every pre-#66 single-instance session
   * already reset it. */
  private trace: TraceEntry[] = [];

  private requireSlot(instance: string): ConnectionSlot {
    const slot = this.connections.get(instance);
    if (!slot || slot.client.isClosed) {
      throw new NotConnectedError(instance);
    }
    return slot;
  }

  requireClient(instance: string = DEFAULT_INSTANCE): BridgeClient {
    return this.requireSlot(instance).client;
  }

  isConnected(instance: string = DEFAULT_INSTANCE): boolean {
    const slot = this.connections.get(instance);
    return !!slot && !slot.client.isClosed;
  }

  /** Names of every instance currently connected, in no particular order. */
  connectedInstances(): string[] {
    return [...this.connections.keys()];
  }

  private isFreshSession(instance: string): boolean {
    return this.connections.size === 0 || (this.connections.size === 1 && this.connections.has(instance));
  }

  private closeSlot(instance: string): void {
    const slot = this.connections.get(instance);
    if (!slot) return;
    slot.client.close();
    if (slot.launched) slot.launched.cleanup();
    this.connections.delete(instance);
  }

  /** Launches a game and binds it to `instance` (default `"default"`) —
   * add-not-replace (spec #66): only `instance`'s own slot is closed and
   * replaced, every other connected instance is left untouched. */
  async launch(
    options: LaunchGameOptions,
    instance: string = DEFAULT_INSTANCE,
  ): Promise<{ port: number; pid: number | undefined; instance: string }> {
    assertValidNewInstanceName(instance);
    const fresh = this.isFreshSession(instance);
    this.closeSlot(instance);
    const result = await launchGame(options);
    this.connections.set(instance, { client: result.client, launched: result, launchCwd: options.cwd });
    if (fresh) this.trace = [];
    return { port: result.port, pid: result.process.pid, instance };
  }

  /** Connects to an already-listening Bridge and binds it to `instance`
   * (default `"default"`) — add-not-replace, same contract as `launch`. */
  async attach(
    port: number,
    host?: string,
    retries?: number,
    retryDelayMs?: number,
    instance: string = DEFAULT_INSTANCE,
  ): Promise<{ port: number; instance: string }> {
    assertValidNewInstanceName(instance);
    const fresh = this.isFreshSession(instance);
    this.closeSlot(instance);
    const client = await BridgeClient.connect(port, { host, retries, retryDelayMs });
    this.connections.set(instance, { client, launched: null, launchCwd: undefined });
    if (fresh) this.trace = [];
    return { port, instance };
  }

  /** Closes every connection (used at process teardown — server.ts — and by
   * tests): unlike `quitGame`, never sends the protocol's `quit` verb, and
   * never kills a process launched by `launch_game` (the agent may want to
   * leave it running) — only the sockets are released; `cleanup()` only
   * removes each temporary port file. */
  disconnect(): void {
    for (const instance of [...this.connections.keys()]) {
      this.closeSlot(instance);
    }
    this.trace = [];
  }

  /** Clean shutdown of one driven instance (ticket #20), unlike
   * `disconnect()`: sends the `quit` verb (the Bridge responds then calls
   * `get_tree().quit()`, DRAFT-v0.md §4). A bare call (no `instance`) closes
   * only `"default"` — a quit-all is out of scope for this spec (#66):
   * closing every instance is an explicit loop by the caller, one
   * `quit_game` call per instance. If the process was launched by
   * `launch_game` (and so managed by this session), waits for its natural
   * exit with a grace period then SIGKILL as a last resort (`stopGame`,
   * src/launch.ts) — never SIGTERM, which crashes Godot mono builds into
   * the very OS crash notification this ladder exists to avoid (see
   * `stopGame`'s doc). After an `attach`, the process isn't ours (same
   * principle as `disconnect()`): we just send `quit`, and never signal a
   * process we didn't launch. Always closes that instance's slot
   * afterwards, even on failure. */
  async quitGame(instance: string = DEFAULT_INSTANCE, options?: StopGameOptions): Promise<void> {
    const slot = this.requireSlot(instance);
    try {
      if (slot.launched) {
        await stopGame(slot.launched, options);
      } else {
        try {
          await slot.client.send("quit", {});
        } catch {
          /* the game may have already closed the connection — nothing else to do here */
        }
      }
    } finally {
      this.closeSlot(instance);
    }
  }

  /** Sends a verb to the Bridge of `instance` (thin proxy, spec #7) and
   * records it in the trace, tagged with `instance` (spec #66), if it has
   * replay value (`isReplayableVerb`) — this is the single pass-through
   * point used by all "verb" tools (tools.ts), so the trace stays faithful
   * without duplicating the recording logic. A verb whose Bridge response is
   * `ok:false` is never recorded: freezing it would produce a stillborn test
   * that replays a deterministic failure (same spirit as
   * `assertNowProperty`/`assertEventuallyProperty`, which already apply this
   * rule).
   *
   * `clientTimeoutMs` overrides the default client-side timeout (dogfooding
   * friction: in windowed mode, shader compilation freezes the game's main
   * thread beyond the default 10s). Purely client-side: never sent to the
   * Bridge, never recorded in the trace. Wait verbs additionally carry the
   * session's progress reporter (ticket #14), so an in-flight wait ticks
   * `$/progress` at the heartbeat cadence. */
  async call(
    cmd: string,
    params: Record<string, unknown> = {},
    clientTimeoutMs?: number,
    instance: string = DEFAULT_INSTANCE,
  ): Promise<Record<string, unknown>> {
    const response = await this.requireClient(instance).send(
      cmd,
      params,
      clientTimeoutMs,
      WAIT_VERBS.has(cmd) ? this.progress : undefined,
    );
    if (isReplayableVerb(cmd) && response["ok"] === true) {
      this.trace.push({ kind: "verb", cmd, params, response, at: this.trace.length, instance });
    }
    return annotateInstance(response, instance);
  }

  /** Sets an assertion (ticket #13, split into `now`/`eventually` by ticket
   * #35, ADR-0006): unlike `query`, a read-only exploration,
   * `assert_eventually_property` checks (retry-until-timeout, same
   * semantics as `wait_for`/§7) that a selector resolves to a given
   * property — then, only if it holds, records it in the trace (`mode:
   * "eventually"`, tagged with `instance`, spec #66) as a step to freeze. An
   * assertion that doesn't hold is never added: freezing a failure would
   * produce a stillborn test (same spirit as the live re-verification
   * criterion). */
  async assertEventuallyProperty(
    selector: Selector,
    property: string,
    expected: unknown,
    message: string | undefined,
    timeoutMs: number,
    clientTimeoutMs?: number,
    instance: string = DEFAULT_INSTANCE,
  ): Promise<Record<string, unknown>> {
    const resp = await this.requireClient(instance).send(
      "wait_for",
      {
        ...selector,
        property,
        equals: expected,
        timeout_ms: timeoutMs,
      },
      clientTimeoutMs,
      this.progress,
    );
    if (resp["ok"] === true) {
      const entry: AssertionTraceEntry = {
        kind: "assertion",
        mode: "eventually",
        selector,
        property,
        expected,
        message,
        at: this.trace.length,
        instance,
      };
      this.trace.push(entry);
    }
    return annotateInstance(resp, instance);
  }

  /** `assert_now_property` (ticket #35, ADR-0006 — "the in-process
   * projection presents no mode the network projection lacks... when a
   * semantic is missing on both sides but justified, it is added to both
   * surfaces under the same name"): checks *right now*, once, that a
   * selector resolves to a given property — the guarantee
   * `assertEventuallyProperty` cannot provide (a value wrong now but correct
   * a few frames later must fail here).
   *
   * The wire has no dedicated one-shot read with `resolve_strict`'s strict
   * selector semantics (ambiguous/not_found/bad_request) and arbitrary
   * `node.get(property)` access — only `wait_for` offers both, and adding a
   * new protocol verb for this alone would be the "verb explosion" §4
   * explicitly rejects (`wait_for`'s own `method` mode is documented as "the
   * composition of act.invoke and wait_for, with no new verb" — same
   * philosophy applies here). So this sends `wait_for` with `timeout_ms: 0`:
   * `bridge.gd _process` calls `Dispatch.handle` (which queues the request)
   * immediately followed by `Dispatch.poll()` in the very same frame, so a
   * zero-timeout request is evaluated exactly once, synchronously from the
   * caller's point of view — never a retry loop, i.e. genuinely "a
   * non-polling read". `ambiguous`/`bad_request` are still returned
   * verbatim (fast-fail branch in `_poll_wait_for`, untouched by this
   * ticket); a property mismatch or a selector that never resolved both
   * surface as the Bridge's generic `timeout` error — the same label
   * `wait_for` already uses for those two cases today, not a new
   * degradation introduced here. */
  async assertNowProperty(
    selector: Selector,
    property: string,
    expected: unknown,
    message: string | undefined,
    clientTimeoutMs?: number,
    instance: string = DEFAULT_INSTANCE,
  ): Promise<Record<string, unknown>> {
    const resp = await this.requireClient(instance).send(
      "wait_for",
      {
        ...selector,
        property,
        equals: expected,
        timeout_ms: 0,
      },
      clientTimeoutMs,
    );
    if (resp["ok"] === true) {
      const entry: AssertionTraceEntry = {
        kind: "assertion",
        mode: "now",
        selector,
        property,
        expected,
        message,
        at: this.trace.length,
        instance,
      };
      this.trace.push(entry);
      return annotateInstance(resp, instance);
    }
    // `timeout_ms: 0` makes the Bridge label both "the property didn't match"
    // and "the selector never resolved" as a `timeout` whose detail reads
    // "wait_for timed out after 0ms". On a verb that by definition never
    // waits, that is actively misleading to the agent reading it — there is no
    // timeout to raise. Lead with what actually happened, keeping the Bridge's
    // own wording after it so the response never contradicts the Bridge.
    if (resp["error"] === "timeout") {
      return {
        ...resp,
        detail:
          "assert_now_property: the property did not match at call time, " +
          `or the selector did not resolve (bridge: ${String(resp["detail"])})`,
      };
    }
    return annotateInstance(resp, instance);
  }

  getTrace(): readonly TraceEntry[] {
    return this.trace;
  }

  /** Filesystem root of the targeted Godot project, if known (the `cwd`
   * passed to `launch_game` for `instance`) — used as a default for
   * `freeze_scenario` when the agent doesn't specify `project_path`
   * explicitly (mostly useful after `attach`, where this directory is never
   * known to the MCP server). Defaults to instance 0 (`"default"`): the
   * generated test's `start_game()` always mounts that instance's scene. */
  getLaunchedProjectPath(instance: string = DEFAULT_INSTANCE): string | undefined {
    return this.connections.get(instance)?.launchCwd;
  }

  /** The game process launched by `launch_game` for `instance`, if any —
   * exposed so that integration tests can explicitly kill it at the end of
   * a scenario (`disconnect()` never kills the process, cf. its doc). */
  getLaunchedProcess(instance: string = DEFAULT_INSTANCE): LaunchedGame["process"] | undefined {
    return this.connections.get(instance)?.launched?.process;
  }
}
