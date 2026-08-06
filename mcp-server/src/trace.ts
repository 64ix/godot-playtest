/**
 * Session trace (ticket #13): what the MCP server retains from an agent's
 * exploration, for the sole purpose of `freeze_scenario` — never sent to
 * the Bridge, never read by the "verb" tools themselves.
 *
 * Two kinds of entry, as required by criterion #13:
 * - `verb`: a protocol verb call (§4) that has replay value (acts on the
 *   game or synchronizes time) — `hello`/`query`/`launch_game`/`attach` are
 *   deliberately omitted (see `isReplayableVerb`): these are read/session
 *   verbs, not scenario steps.
 * - `assertion`: a check the agent explicitly set via the `assert_now_property`
 *   or `assert_eventually_property` tool (not a plain exploratory `query`) —
 *   `mode` records which one, so the Freeze generator emits the matching
 *   in-process call (ADR-0006: same name on both surfaces).
 *
 * Both kinds also carry `instance` (spec #66): which named connection the
 * verb/assertion addressed (default `"default"`, instance 0) — stamped at
 * the session's single choke point (`Session.call`/`assertNowProperty`/
 * `assertEventuallyProperty`), never forwarded to the Bridge as a verb
 * param (the wire protocol does not change). Freeze reconstructs the set of
 * `attach_instance` declarations to hoist from the non-default names this
 * field carries across the trace.
 */

/** Selector as defined in §3: in practice, one level at a time. */
export interface Selector {
  test_id?: string;
  group?: string;
  path?: string;
}

export interface VerbTraceEntry {
  kind: "verb";
  cmd: string;
  params: Record<string, unknown>;
  response: Record<string, unknown>;
  at: number;
  /** Named connection this verb was sent to (spec #66). Default `"default"`. */
  instance: string;
}

export interface AssertionTraceEntry {
  kind: "assertion";
  /** `"now"` (one-shot, set via `assert_now_property`) or `"eventually"`
   * (retry-until-timeout, set via `assert_eventually_property`) — which
   * in-process call the Freeze generator must emit (§ freeze.ts renderEntry). */
  mode: "now" | "eventually";
  selector: Selector;
  property: string;
  expected: unknown;
  message?: string;
  at: number;
  /** Named connection this assertion was set against (spec #66). Default `"default"`. */
  instance: string;
}

export type TraceEntry = VerbTraceEntry | AssertionTraceEntry;

/** Protocol verbs that have replay value in a frozen test.
 * `hello`/`query`/`launch_game`/`attach` are session mechanics or plain
 * exploratory reads — replaying them would produce a log dump, not a
 * readable scenario (criterion #13 "not a log dump"). */
const REPLAYABLE_VERBS = new Set([
  "act.press",
  "act.invoke",
  "act.input",
  "wait_for",
  "time.scale",
  "time.frames",
  "time.step_until",
  "screenshot",
]);

export function isReplayableVerb(cmd: string): boolean {
  return REPLAYABLE_VERBS.has(cmd);
}

/** Verbs that require the `windowed` capability (degradation matrix §6) —
 * a scenario using them isn't replayable as-is by the headless runner
 * (criterion #13). */
export function isWindowedOnlyEntry(entry: VerbTraceEntry): boolean {
  if (entry.cmd === "screenshot") return true;
  if (entry.cmd === "act.input" && entry.params["type"] === "click") return true;
  return false;
}

/** Extracts the `{test_id|group|path}` selector carried by an entry, if
 * any — used for live re-verification at generation time. */
export function selectorOf(entry: TraceEntry): Selector | null {
  if (entry.kind === "assertion") return entry.selector;
  const p = entry.params;
  if (typeof p["test_id"] === "string") return { test_id: p["test_id"] };
  if (typeof p["group"] === "string") return { group: p["group"] };
  if (typeof p["path"] === "string") return { path: p["path"] };
  return null;
}

export function selectorKey(selector: Selector): string {
  if (selector.test_id !== undefined) return `test_id:${selector.test_id}`;
  if (selector.group !== undefined) return `group:${selector.group}`;
  if (selector.path !== undefined) return `path:${selector.path}`;
  return "none";
}

/** Dedup key for live selector re-verification (spec #66 criterion "live
 * selector verification deduped per (instance, selector)"): the same
 * selector on two different instances is two distinct live checks — the
 * same test-id can legitimately exist on both clients. */
export function instanceSelectorKey(instance: string, selector: Selector): string {
  return `${instance}::${selectorKey(selector)}`;
}

/** Human-readable description of a selector, for error messages/comments. */
export function describeSelector(selector: Selector): string {
  if (selector.test_id !== undefined) return `test_id="${selector.test_id}"`;
  if (selector.group !== undefined) return `group="${selector.group}"`;
  if (selector.path !== undefined) return `path="${selector.path}"`;
  return "(empty selector)";
}
