/**
 * Freeze (ticket #13): hardens the session trace held by the MCP server into
 * a frozen `PlaytestCase` test (docs/protocol/DRAFT-v0.md §7) — the project's
 * differentiating artifact (CONTEXT.md "Freeze").
 *
 * Two separate responsibilities, in this order:
 * 1. `verifySelectorsLive`: re-resolves each selector from the trace against
 *    the live game (Playwright test-agents pattern, cf. spec #7
 *    "Implementation Decisions") — a selector that no longer resolves is a
 *    generation-time error, not a stillborn test.
 * 2. `generateFrozenScript`: projects the verified trace into an idiomatic
 *    GDScript script — selectors at the best available level (they already
 *    are, the trace only contains what the agent actually used), explicit
 *    waits (`wait_for`/`time.*`), zero sleeps, zero log dumps.
 */
import { Session } from "./session.js";
import { DEFAULT_INSTANCE } from "./instance-name.js";
import {
  Selector,
  TraceEntry,
  instanceSelectorKey,
  isWindowedOnlyEntry,
  selectorOf,
} from "./trace.js";

export class FreezeRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FreezeRefusedError";
  }
}

export interface FreezeOptions {
  /** Scenario name — becomes `test_<name>()` and the file name. */
  name: string;
  /** Scene instantiated by `start_game()` in the generated script. */
  scenePath: string;
  /** Takes responsibility for a non-CI-safe scenario (§13 "refused or
   * explicitly marked windowed") — without this flag, a scenario using
   * `screenshot` or `act.input` of type `click` is refused. */
  windowed?: boolean;
}

export interface FreezeResult {
  fileName: string;
  code: string;
  ciSafe: boolean;
}

/** Re-resolves each unique selector from the trace against the live game, in
 * "plain" `wait_for` mode (no property/signal): a simple existence/uniqueness
 * check, with no side effect, that reuses the strict-mode semantics already
 * exposed by the Bridge (`ambiguous`/`not_found`) rather than inventing a new
 * verification verb. Short `timeout_ms`: the node is expected to already
 * exist (the scenario just ran) — this isn't a wait, it's a check.
 *
 * Deduplicated per **(instance, selector)** (spec #66): the same test-id can
 * legitimately exist on two different clients, so each instance's copy is
 * its own live check, routed to that instance's own connection
 * (`session.requireClient(entry.instance)`) — never cross-checked against
 * the wrong client's tree.
 *
 * Returns the list of selectors that no longer resolve (empty = all good).
 */
export async function verifySelectorsLive(
  session: Session,
  trace: readonly TraceEntry[],
  timeoutMs = 500,
): Promise<Array<{ selector: Selector; instance: string; error: string; detail?: string }>> {
  const seen = new Set<string>();
  const problems: Array<{ selector: Selector; instance: string; error: string; detail?: string }> = [];
  for (const entry of trace) {
    const selector = selectorOf(entry);
    if (!selector) continue;
    const instance = entry.instance ?? DEFAULT_INSTANCE;
    const key = instanceSelectorKey(instance, selector);
    if (seen.has(key)) continue;
    seen.add(key);
    // `requireClient(instance).send` directly, never `session.call`: this is
    // a generation-time check, not a scenario step — it must not be added to
    // the trace (which could be frozen again later).
    const resp = await session.requireClient(instance).send("wait_for", { ...selector, timeout_ms: timeoutMs });
    if (resp["ok"] !== true) {
      problems.push({
        selector,
        instance,
        error: String(resp["error"] ?? "unknown"),
        detail: resp["detail"] as string | undefined,
      });
    }
  }
  return problems;
}

/** Generates the frozen GDScript script from a trace already verified live.
 * Throws `FreezeRefusedError` if the trace uses a non-CI-safe verb
 * (`screenshot`, `act.input` of type `click`) without `windowed: true`. */
export function generateFrozenScript(trace: readonly TraceEntry[], options: FreezeOptions): FreezeResult {
  const testName = toTestFunctionName(options.name);
  const fileName = `${toSnakeCase(options.name)}.gd`;

  const windowedEntries = trace.filter((e) => e.kind === "verb" && isWindowedOnlyEntry(e));
  const ciSafe = windowedEntries.length === 0;
  if (!ciSafe && !options.windowed) {
    const verbs = windowedEntries
      .map((e) => (e.kind === "verb" ? describeWindowedVerb(e) : ""))
      .join(", ");
    throw new FreezeRefusedError(
      `freeze refused: the scenario uses (${verbs}), not CI-safe (matrix §6 — headless column). ` +
        `Pass windowed: true to freeze a windowed-only test anyway, or remove these steps.`,
    );
  }

  // Hoisted `attach_instance` declarations (spec #66 criterion): every
  // non-default instance the trace mentions, in first-appearance order —
  // creation itself is never recorded in the trace, only which instance
  // each verb/assertion addressed, so this is a deliberate, stated
  // reconstruction, not a replay of a literal `attach_instance` call the
  // agent made. Freeze is agnostic to whether that live instance came from
  // `launch_game` or `attach` (spec #66): only the name travels.
  const declarationLines = collectHandleNames(trace).map(
    (name) => `\tvar ${name} := await attach_instance(${gdString(name)})`,
  );

  const lines: string[] = [];
  for (const entry of trace) {
    const rendered = renderEntry(entry);
    if (rendered) lines.push(rendered);
  }

  const header = buildHeader(options, ciSafe);
  const declBlock = declarationLines.length > 0 ? `${declarationLines.join("\n")}\n\n` : "";
  const body = lines.length > 0 ? lines.map((l) => `\t${l}`).join("\n") : "\tpass";

  const code =
    `${header}\n` +
    `extends PlaytestCase\n` +
    (ciSafe ? "" : "\n## Windowed-only (freeze #13): see header — the headless runner skips it.\nconst PLAYTEST_WINDOWED := true\n") +
    `\nfunc ${testName}() -> void:\n` +
    `\tawait start_game(${gdString(options.scenePath)})\n\n` +
    `${declBlock}${body}\n`;

  return { fileName, code, ciSafe };
}

/** The set of non-default instance names the trace mentions, in
 * first-appearance order (spec #66 criterion "hoisted ... in
 * first-appearance order") — the declarations `generateFrozenScript` hoists
 * right after `start_game()`. */
function collectHandleNames(trace: readonly TraceEntry[]): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const entry of trace) {
    const instance = entry.instance ?? DEFAULT_INSTANCE;
    if (instance === DEFAULT_INSTANCE || seen.has(instance)) continue;
    seen.add(instance);
    names.push(instance);
  }
  return names;
}

function buildHeader(options: FreezeOptions, ciSafe: boolean): string {
  const lines = [
    `## Frozen test generated by \`freeze_scenario\` (ticket #13) from the`,
    `## session trace held by the MCP server — each selector was re-verified`,
    `## against the live game at generation time (see freeze.ts`,
    `## verifySelectorsLive). Replayed without AI by the addon's runner:`,
    `##`,
    `##     godot --headless --path . res://addons/playtest/runner.tscn -- --suite=res://playtests/`,
  ];
  if (!ciSafe) {
    lines.push(
      `##`,
      `## WARNING — windowed-only: this scenario uses a non-CI-safe verb`,
      `## (act.input type=click, or screenshot) reserved for windowed execution`,
      `## (matrix §6). The runner automatically skips it in --headless.`,
    );
  }
  return lines.join("\n");
}

function describeWindowedVerb(entry: TraceEntry & { kind: "verb" }): string {
  if (entry.cmd === "screenshot") return "screenshot";
  return `act.input(type=click)`;
}

/** Translates a trace entry into one (or several) line(s) of idiomatic
 * GDScript. Returns `null` for entries deliberately omitted (see
 * `isReplayableVerb` — shouldn't happen here since the trace already only
 * contains replayable entries, but stays defensive).
 *
 * Instance 0 (`"default"`) renders exactly as before this spec (byte-for-byte
 * — backward compatibility criterion). Any other instance renders as a call
 * on its handle (`<name>.<verb>(...)`, spec #66 "call-site naming"): every
 * `PlaytestClient` verb is a network round trip and therefore a GDScript
 * coroutine (`addons/playtest/playtest_client.gd`), so — unlike `self`,
 * where only `wait_for`/`time_frames`/the asserts need it — a handle call
 * ALWAYS carries `await`, `press`/`input`/`invoke` included. This is the
 * naming corollary at work (ADR-0008): the same verb name, `press`, means
 * "emit the signal in-process, synchronously" on `self` and "ask the remote
 * Bridge over the wire and wait for its answer" on a handle — two
 * legitimately different strengths of guarantee behind one shared name. */
function renderEntry(entry: TraceEntry): string | null {
  const instance = entry.instance ?? DEFAULT_INSTANCE;
  const isHandle = instance !== DEFAULT_INSTANCE;
  const prefix = isHandle ? `${instance}.` : "";

  if (entry.kind === "assertion") {
    const sel = gdSelector(entry.selector);
    const prop = gdString(entry.property);
    const expected = gdValue(entry.expected);
    const msg = entry.message ? `, ${gdString(entry.message)}` : "";
    // ADR-0006: the trace entry's `mode` selects which in-process call to
    // emit — `assert_now_property` (one-shot, set via the assert_now_property
    // tool) or `assert_eventually_property` (retry-until-timeout, set via
    // assert_eventually_property) — never a single hard-coded form.
    const callee = entry.mode === "now" ? "assert_now_property" : "assert_eventually_property";
    return `await ${prefix}${callee}(${sel}, ${prop}, ${expected}${msg})`;
  }

  switch (entry.cmd) {
    case "act.press":
      return isHandle ? `await ${prefix}press(${gdSelector(entry.params)})` : `press(${gdSelector(entry.params)})`;
    case "act.invoke": {
      const method = gdString(String(entry.params["method"] ?? ""));
      const args = gdArray((entry.params["args"] as unknown[]) ?? []);
      const call = `invoke(${gdSelector(entry.params)}, ${method}, ${args})`;
      return isHandle ? `await ${prefix}${call}` : call;
    }
    case "act.input": {
      const call = renderInput(entry.params);
      return isHandle ? `await ${prefix}${call}` : call;
    }
    case "wait_for":
      return `await ${prefix}${renderWaitFor(entry.params)}`;
    case "time.step_until":
      return `await ${prefix}${renderStepUntil(entry.params)}`;
    case "time.scale":
      return `${isHandle ? "await " : ""}${prefix}time_scale(${gdValue(entry.params["factor"])})`;
    case "time.frames": {
      const n = gdValue(entry.params["n"]);
      const physics = entry.params["physics"] === true;
      return physics ? `await ${prefix}time_frames(${n}, true)` : `await ${prefix}time_frames(${n})`;
    }
    case "screenshot": {
      // Never an oracle (docs/protocol/DRAFT-v0.md §1): nothing to replay
      // in-process on either surface (no PlaytestClient.screenshot() either
      // — see the network-verb ⇄ in-process-method mapping table), we leave
      // only a readable trace of the intent.
      const suffix = isHandle ? ` (instance: ${instance})` : "";
      return `# screenshot() ignored at generation time${suffix}: never an oracle (state-first), not reproducible in-process.`;
    }
    default:
      return null;
  }
}

function renderInput(params: Record<string, unknown>): string {
  const dict: Record<string, unknown> = { type: params["type"] };
  for (const k of ["action", "keycode", "position", "button", "pressed", "strength"]) {
    if (params[k] !== undefined) dict[k] = params[k];
  }
  return `input(${gdDict(dict)})`;
}

/** Shared by `renderWaitFor`/`renderStepUntil`: builds `sel` from the
 * selector keys plus an options dict from whichever of `fields` are present
 * in `params`, in `fields`' order, then renders the bare `fn(...)` call —
 * `fn(sel)` when no option key is present, `fn(sel, opts)` otherwise. The
 * caller (`renderEntry`) prepends `await` and the instance-handle prefix. */
function renderVerbCall(fn: string, params: Record<string, unknown>, fields: string[]): string {
  const sel = gdSelector(params);
  const opts: Record<string, unknown> = {};
  for (const field of fields) {
    if (params[field] !== undefined) opts[field] = params[field];
  }
  if (Object.keys(opts).length === 0) {
    return `${fn}(${sel})`;
  }
  return `${fn}(${sel}, ${gdDict(opts)})`;
}

function renderWaitFor(params: Record<string, unknown>): string {
  return renderVerbCall("wait_for", params, ["property", "signal", "method", "args", "equals", "timeout_ms"]);
}

/** `time.step_until` (ticket #39): same rendering shape as `wait_for` — a
 * selector plus an options dict built from whichever condition/budget keys
 * are present (`property`+`equals`, `method`+`args`+`equals`, `max_frames`,
 * `timeout_ms`; never `signal`, out of scope for this verb, ADR-0007). The
 * in-process mirror `time_step_until` (ticket #38, `playtestcase.gd`)
 * returns `{"node": Node, "frames": int}` rather than a bare `Node` (unlike
 * `wait_for`/`query_one`) — but a frozen test has no use for that value any
 * more than it has for `wait_for`'s resolved node, so the generated line
 * discards it the same way: a bare `await time_step_until(...)` statement,
 * never an assignment. It is a coroutine (`playtestcase.gd`'s doc comment),
 * so, like `wait_for`, every emitted line is `await`-ed. */
function renderStepUntil(params: Record<string, unknown>): string {
  return renderVerbCall("time_step_until", params, ["property", "method", "args", "equals", "max_frames", "timeout_ms"]);
}

function gdSelector(params: { test_id?: unknown; group?: unknown; path?: unknown }): string {
  const dict: Record<string, unknown> = {};
  if (typeof params["test_id"] === "string") dict["test_id"] = params["test_id"];
  else if (typeof params["group"] === "string") dict["group"] = params["group"];
  else if (typeof params["path"] === "string") dict["path"] = params["path"];
  return gdDict(dict);
}

function gdDict(obj: Record<string, unknown>): string {
  const entries = Object.entries(obj).map(([k, v]) => `${gdString(k)}: ${gdValue(v)}`);
  return `{${entries.join(", ")}}`;
}

function gdArray(arr: unknown[]): string {
  return `[${arr.map(gdValue).join(", ")}]`;
}

function gdValue(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "string") return gdString(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return gdArray(v);
  if (typeof v === "object") return gdDict(v as Record<string, unknown>);
  return gdString(String(v));
}

function gdString(s: string): string {
  return JSON.stringify(s);
}

function toSnakeCase(name: string): string {
  return name
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/^_+|_+$/g, "") || "frozen_scenario";
}

function toTestFunctionName(name: string): string {
  const snake = toSnakeCase(name);
  return snake.startsWith("test_") ? snake : `test_${snake}`;
}
