/**
 * Freeze: multi-instance emission (spec #66) — golden generator tests
 * (prior art: test/unit/freeze.test.ts). Builds trace arrays by hand (no
 * live Bridge needed for these): hoisted `attach_instance` declarations in
 * first-appearance order, handle prefixes, no launch calls / no literal
 * ports, and the instance-qualified dedup of `verifySelectorsLive`
 * (exercised against a fake Bridge, since that one does perform a live
 * round trip).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { generateFrozenScript, verifySelectorsLive } from "../../src/freeze.js";
import { Session } from "../../src/session.js";
import { TraceEntry } from "../../src/trace.js";
import { defaultHandler, FakeBridge } from "../helpers/fake-bridge.js";

function press(instance: string, testId: string, at: number): TraceEntry {
  return { kind: "verb", cmd: "act.press", params: { test_id: testId }, response: { ok: true }, at, instance };
}

function assertion(
  instance: string,
  mode: "now" | "eventually",
  testId: string,
  property: string,
  expected: unknown,
  at: number,
): TraceEntry {
  return {
    kind: "assertion",
    mode,
    selector: { test_id: testId },
    property,
    expected,
    at,
    instance,
  };
}

test("hoists attach_instance declarations right after start_game, in first-appearance order", () => {
  const trace: TraceEntry[] = [
    press("default", "score_button", 0),
    press("b", "remote_button", 1),
    press("c", "third_button", 2),
    press("b", "remote_button", 3),
  ];
  const result = generateFrozenScript(trace, { name: "two clients", scenePath: "res://main.tscn" });

  const startIdx = result.code.indexOf('await start_game("res://main.tscn")');
  const declBIdx = result.code.indexOf('var b := await attach_instance("b")');
  const declCIdx = result.code.indexOf('var c := await attach_instance("c")');
  assert.ok(startIdx >= 0, "start_game call missing");
  assert.ok(declBIdx > startIdx, "declaration for 'b' must come after start_game");
  assert.ok(declCIdx > declBIdx, "'c' first appears after 'b': declarations must follow first-appearance order");

  // Declared exactly once each, even though 'b' is addressed twice.
  assert.equal(result.code.split('attach_instance("b")').length - 1, 1);
});

test("handle verbs are prefixed with the instance name and awaited (network round trip)", () => {
  const trace: TraceEntry[] = [press("b", "remote_button", 0)];
  const result = generateFrozenScript(trace, { name: "handle press", scenePath: "res://main.tscn" });
  assert.match(result.code, /await b\.press\(\{"test_id": "remote_button"\}\)/);
});

test("handle step_until renders as an awaited handle call, never an assignment (ticket #39 × spec #66)", () => {
  const trace: TraceEntry[] = [
    {
      kind: "verb",
      cmd: "time.step_until",
      params: { test_id: "remote_label", property: "text", equals: "1", max_frames: 30 },
      response: { ok: true },
      at: 0,
      instance: "b",
    },
  ];
  const result = generateFrozenScript(trace, { name: "handle step until", scenePath: "res://main.tscn" });
  assert.match(result.code, /var b := await attach_instance\("b"\)/);
  // The exact line PlaytestClient.time_step_until replays over the wire.
  assert.match(
    result.code,
    /await b\.time_step_until\(\{"test_id": "remote_label"\}, \{"property": "text", "equals": "1", "max_frames": 30\}\)/,
  );
  assert.doesNotMatch(result.code, /=\s*await b\.time_step_until/);
});

test("instance 0 (default) renders exactly as before this spec: no prefix, no await on press", () => {
  const trace: TraceEntry[] = [press("default", "score_button", 0)];
  const result = generateFrozenScript(trace, { name: "self press", scenePath: "res://main.tscn" });
  assert.match(result.code, /^\tpress\(\{"test_id": "score_button"\}\)$/m);
});

test("handle assertions render as await <name>.assert_now_property/assert_eventually_property", () => {
  const trace: TraceEntry[] = [
    assertion("b", "now", "remote_label", "text", "0", 0),
    assertion("b", "eventually", "remote_label", "text", "1", 1),
  ];
  const result = generateFrozenScript(trace, { name: "handle asserts", scenePath: "res://main.tscn" });
  assert.match(result.code, /await b\.assert_now_property\(\{"test_id": "remote_label"\}, "text", "0"\)/);
  assert.match(result.code, /await b\.assert_eventually_property\(\{"test_id": "remote_label"\}, "text", "1"\)/);
});

test("generated code carries no launch call and no literal port for a handle", () => {
  const trace: TraceEntry[] = [press("b", "remote_button", 0)];
  const result = generateFrozenScript(trace, { name: "no ports", scenePath: "res://main.tscn" });
  assert.doesNotMatch(result.code, /launch_game/);
  assert.doesNotMatch(result.code, /--bridge-port/);
  assert.doesNotMatch(result.code, /\bport\b/i);
});

test("a screenshot entry on a handle is still ignored at generation time, naming the instance", () => {
  const trace: TraceEntry[] = [
    { kind: "verb", cmd: "screenshot", params: {}, response: { ok: true }, at: 0, instance: "b" },
  ];
  const result = generateFrozenScript(trace, { name: "handle shot", scenePath: "res://main.tscn", windowed: true });
  assert.match(result.code, /# screenshot\(\) ignored at generation time \(instance: b\)/);
});

test("a screenshot entry on the default instance keeps its exact pre-existing comment (no instance suffix)", () => {
  const trace: TraceEntry[] = [
    { kind: "verb", cmd: "screenshot", params: {}, response: { ok: true }, at: 0, instance: "default" },
  ];
  const result = generateFrozenScript(trace, { name: "default shot", scenePath: "res://main.tscn", windowed: true });
  assert.match(result.code, /# screenshot\(\) ignored at generation time: never an oracle/);
});

test("verifySelectorsLive dedupes per (instance, selector): the same test_id on two instances is checked twice", async () => {
  let defaultCalls = 0;
  let bCalls = 0;
  const bridgeDefault = await FakeBridge.start(
    defaultHandler({
      wait_for: (req, respond) => {
        defaultCalls++;
        respond({ id: req["id"], ok: true, node: { test_id: req["test_id"] } });
      },
    }),
  );
  const bridgeB = await FakeBridge.start(
    defaultHandler({
      wait_for: (req, respond) => {
        bCalls++;
        respond({ id: req["id"], ok: true, node: { test_id: req["test_id"] } });
      },
    }),
  );
  const session = new Session();
  try {
    await session.attach(bridgeDefault.port);
    await session.attach(bridgeB.port, undefined, undefined, undefined, "b");

    const trace: TraceEntry[] = [
      press("default", "shared_id", 0),
      press("default", "shared_id", 1), // same instance+selector: deduped, only 1 live check
      press("b", "shared_id", 2), // same selector, different instance: its OWN live check
    ];
    const problems = await verifySelectorsLive(session, trace);
    assert.deepEqual(problems, []);
    assert.equal(defaultCalls, 1, "the repeated (default, shared_id) pair must be checked once");
    assert.equal(bCalls, 1, "the (b, shared_id) pair is a distinct check from (default, shared_id)");
  } finally {
    session.disconnect();
    await bridgeDefault.stop();
    await bridgeB.stop();
  }
});

test("verifySelectorsLive routes a problem to the instance it failed on", async () => {
  const bridgeDefault = await FakeBridge.start(defaultHandler());
  const bridgeB = await FakeBridge.start(
    defaultHandler({
      wait_for: (req, respond) =>
        respond({ id: req["id"], ok: false, error: "not_found", detail: "no such node", suggestions: [] }),
    }),
  );
  const session = new Session();
  try {
    await session.attach(bridgeDefault.port);
    await session.attach(bridgeB.port, undefined, undefined, undefined, "b");
    const trace: TraceEntry[] = [press("b", "ghost", 0)];
    const problems = await verifySelectorsLive(session, trace);
    assert.equal(problems.length, 1);
    assert.equal(problems[0].instance, "b");
  } finally {
    session.disconnect();
    await bridgeDefault.stop();
    await bridgeB.stop();
  }
});
