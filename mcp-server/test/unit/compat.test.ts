/**
 * Compatibility verdict on the `hello` handshake (issue #58): the server
 * declares the protocol / state-contract versions it was built against and
 * `compatibilityVerdict` compares them to what the addon reported. Pure
 * function, tested with arbitrary expected versions — both drift directions
 * are reachable even while the real constants sit at 0.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compatibilityVerdict,
  SUPPORTED_PROTOCOL_VERSION,
  SUPPORTED_STATE_CONTRACT_VERSION,
} from "../../src/protocol.js";

test("matching versions yield a compatible verdict that says so", () => {
  const verdict = compatibilityVerdict({
    protocol: SUPPORTED_PROTOCOL_VERSION,
    state_contract: SUPPORTED_STATE_CONTRACT_VERSION,
  });
  assert.equal(verdict.compatible, true);
  assert.equal(verdict.server_protocol, SUPPORTED_PROTOCOL_VERSION);
  assert.equal(verdict.server_state_contract, SUPPORTED_STATE_CONTRACT_VERSION);
  assert.match(verdict.message, /match/);
});

test("addon protocol behind the server names the direction and the remedy: update the addon", () => {
  const verdict = compatibilityVerdict(
    { protocol: 0, state_contract: 1 },
    { protocol: 1, state_contract: 1 },
  );
  assert.equal(verdict.compatible, false);
  assert.match(verdict.message, /addon reports protocol 0.*server expects 1/);
  assert.match(verdict.message, /update the addon/);
});

test("addon protocol ahead of the server names the remedy: update the server", () => {
  const verdict = compatibilityVerdict(
    { protocol: 2, state_contract: 1 },
    { protocol: 1, state_contract: 1 },
  );
  assert.equal(verdict.compatible, false);
  assert.match(verdict.message, /addon reports protocol 2.*server expects 1/);
  assert.match(verdict.message, /update the server/);
});

test("a state_contract mismatch is reported distinctly from a protocol mismatch", () => {
  const verdict = compatibilityVerdict(
    { protocol: 1, state_contract: 0 },
    { protocol: 1, state_contract: 1 },
  );
  assert.equal(verdict.compatible, false);
  assert.match(verdict.message, /state contract/);
  // Distinct wording: the state-contract warning is about how query results
  // are read, not about missing verbs — it must not reuse the protocol text.
  assert.doesNotMatch(verdict.message, /addon reports protocol/);
});

test("simultaneous protocol and state_contract drift reports both", () => {
  const verdict = compatibilityVerdict(
    { protocol: 0, state_contract: 0 },
    { protocol: 1, state_contract: 1 },
  );
  assert.equal(verdict.compatible, false);
  assert.match(verdict.message, /addon reports protocol 0/);
  assert.match(verdict.message, /state contract/);
});

test("an addon that reports no version at all is flagged, not treated as compatible", () => {
  const verdict = compatibilityVerdict({}, { protocol: 0, state_contract: 0 });
  assert.equal(verdict.compatible, false);
  assert.match(verdict.message, /update the addon/);
});
