/**
 * godot-playtest protocol types (docs/protocol/DRAFT-v0.md).
 *
 * The MCP server is a thin proxy (spec #7): it doesn't reimplement any
 * semantics — it translates MCP tools into JSON-lines requests and passes
 * the Bridge's responses through as-is. This file just types the wire.
 */

/** Request sent to the Bridge: `{"id": <int>, "cmd": "<verb>", ...params}`. */
export interface BridgeRequest {
  id: number;
  cmd: string;
  [key: string]: unknown;
}

/** Success response: `{"id": <int>, "ok": true, ...}`. */
export interface BridgeSuccess {
  id: number;
  ok: true;
  [key: string]: unknown;
}

/** Typed error response (docs/protocol/DRAFT-v0.md §3, addons/playtest/errors.gd). */
export interface BridgeError {
  id: number;
  ok: false;
  error: string;
  detail?: string;
  suggestions?: string[];
  candidates?: unknown[];
  [key: string]: unknown;
}

export type BridgeResponse = BridgeSuccess | BridgeError;

/** Protocol error codes (addons/playtest/errors.gd) — for reference, never
 * used for filtering: every Bridge error is surfaced to the agent as-is
 * (criterion #12: "never swallowed"). */
export const BRIDGE_ERROR_CODES = [
  "not_found",
  "ambiguous",
  "bad_json",
  "bad_request",
  "unknown_cmd",
  "timeout",
  "no_display",
  "no_renderer",
] as const;

export function isBridgeError(resp: BridgeResponse): resp is BridgeError {
  return resp.ok === false;
}

/** The protocol and state-contract versions this server was built against —
 * the single server-side declaration (issue #58), mirroring
 * `PROTOCOL_VERSION` / `STATE_CONTRACT_VERSION` in
 * `addons/playtest/dispatch.gd`. Bump in lockstep with the addon. */
export const SUPPORTED_PROTOCOL_VERSION = 0;
export const SUPPORTED_STATE_CONTRACT_VERSION = 0;

/** Verdict attached to the `hello` tool result (issue #58). Annotates, never
 * blocks: the protocol is additive (docs/protocol/DRAFT-v0.md), so a drift is
 * a warning naming which side to update, not an error. */
export interface CompatibilityVerdict {
  compatible: boolean;
  server_protocol: number;
  server_state_contract: number;
  message: string;
}

/** Compares the versions the addon reported in its `hello` response against
 * what this server expects. `expected` is injectable so both drift directions
 * stay testable while the shipped constants sit at 0. */
export function compatibilityVerdict(
  reported: { protocol?: unknown; state_contract?: unknown },
  expected = { protocol: SUPPORTED_PROTOCOL_VERSION, state_contract: SUPPORTED_STATE_CONTRACT_VERSION },
): CompatibilityVerdict {
  const problems: string[] = [];

  if (typeof reported.protocol !== "number") {
    problems.push(`addon did not report a protocol version (server expects ${expected.protocol}) — update the addon`);
  } else if (reported.protocol !== expected.protocol) {
    // Direction decides the remedy: the npx-distributed server updates itself
    // on every launch, while an Asset Library addon stays frozen until a new
    // submission clears review (docs/RELEASE.md "When to resubmit").
    const remedy = reported.protocol < expected.protocol ? "update the addon" : "update the server";
    problems.push(`addon reports protocol ${reported.protocol}, server expects ${expected.protocol} — ${remedy}`);
  }

  if (reported.state_contract !== expected.state_contract) {
    // Distinct from a protocol drift: this one threatens how query /
    // _test_state() results are read, not which verbs exist.
    const remedy =
      typeof reported.state_contract === "number" && reported.state_contract > expected.state_contract
        ? "update the server"
        : "update the addon";
    problems.push(
      `state contract mismatch: addon reports ${reported.state_contract}, server expects ` +
        `${expected.state_contract} — query results may be read under the wrong shape; ${remedy}`,
    );
  }

  return {
    compatible: problems.length === 0,
    server_protocol: expected.protocol,
    server_state_contract: expected.state_contract,
    message:
      problems.length === 0
        ? `protocol ${expected.protocol} and state contract ${expected.state_contract} match — compatible`
        : problems.join("; "),
  };
}
