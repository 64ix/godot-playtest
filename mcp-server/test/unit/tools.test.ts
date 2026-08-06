/**
 * Translation of MCP tools ⇄ protocol verbs (ticket #12) against a fake
 * Bridge: exercises the real MCP path (Client → transport → McpServer →
 * tool handler → BridgeClient) via `InMemoryTransport`, not just direct
 * calls to internal functions.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTools } from "../../src/tools.js";
import { Session } from "../../src/session.js";
import { defaultHandler, FakeBridge } from "../helpers/fake-bridge.js";

let bridge: FakeBridge | undefined;
let session: Session | undefined;
let client: Client | undefined;

async function setup(handlerOverrides: Parameters<typeof defaultHandler>[0] = {}) {
  bridge = await FakeBridge.start(defaultHandler(handlerOverrides));
  session = new Session();
  await session.attach(bridge.port);

  const server = new McpServer({ name: "test-server", version: "0.0.0" });
  registerTools(server, session);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { server, client };
}

afterEach(async () => {
  session?.disconnect();
  await bridge?.stop();
  client = undefined;
  session = undefined;
  bridge = undefined;
});

function parseResultText(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const content = result.content as Array<{ type: string; text: string }>;
  assert.equal(content.length, 1);
  assert.equal(content[0].type, "text");
  return JSON.parse(content[0].text);
}

test("query tool forwards the selector to cmd='query' and returns the bridge payload", async () => {
  const { client } = await setup({
    query: (req, respond) => {
      assert.equal(req["test_id"], "score_label");
      respond({ id: req["id"], ok: true, nodes: [{ test_id: "score_label", text: "0" }] });
    },
  });
  const result = await client!.callTool({ name: "query", arguments: { test_id: "score_label" } });
  assert.ok(!result.isError);
  const payload = parseResultText(result);
  assert.equal(payload["ok"], true);
  assert.equal((payload["nodes"] as unknown[]).length, 1);
});

test("act_press tool maps to cmd='act.press'", async () => {
  const { client } = await setup({
    "act.press": (req, respond) => {
      assert.equal(req["test_id"], "score_button");
      respond({ id: req["id"], ok: true });
    },
  });
  const result = await client!.callTool({ name: "act_press", arguments: { test_id: "score_button" } });
  const payload = parseResultText(result);
  assert.equal(payload["ok"], true);
});

test("act_input tool forwards low-level input params to cmd='act.input'", async () => {
  const { client } = await setup({
    "act.input": (req, respond) => {
      assert.equal(req["type"], "action");
      assert.equal(req["action"], "move_right");
      assert.equal(req["pressed"], true);
      respond({ id: req["id"], ok: true });
    },
  });
  const result = await client!.callTool({
    name: "act_input",
    arguments: { type: "action", action: "move_right", pressed: true },
  });
  const payload = parseResultText(result);
  assert.equal(payload["ok"], true);
});

test("act_invoke tool maps to cmd='act.invoke' with method/args", async () => {
  const { client } = await setup({
    "act.invoke": (req, respond) => {
      assert.equal(req["method"], "echo");
      assert.deepEqual(req["args"], [42]);
      respond({ id: req["id"], ok: true, value: 42 });
    },
  });
  const result = await client!.callTool({
    name: "act_invoke",
    arguments: { test_id: "game", method: "echo", args: [42] },
  });
  const payload = parseResultText(result);
  assert.equal(payload["value"], 42);
});

test("wait_for tool maps to cmd='wait_for' and surfaces timeout errors, not swallowed", async () => {
  const { client } = await setup({
    wait_for: (req, respond) => {
      respond({
        id: req["id"],
        ok: false,
        error: "timeout",
        // Ticket #10: the detail names the full Condition and the last
        // observation, appended after the existing prefix.
        detail:
          "wait_for timed out after 300ms — condition: {\"test_id\":\"no_such_thing\"}; " +
          "last error: not_found no node with test_id 'no_such_thing'",
      });
    },
  });
  const result = await client!.callTool({
    name: "wait_for",
    arguments: { test_id: "no_such_thing", timeout_ms: 300 },
  });
  assert.equal(result.isError, true);
  const payload = parseResultText(result);
  assert.equal(payload["error"], "timeout");
  assert.equal(
    payload["detail"],
    "wait_for timed out after 300ms — condition: {\"test_id\":\"no_such_thing\"}; " +
      "last error: not_found no node with test_id 'no_such_thing'",
  );
});

test("not_found errors carry their suggestions through the tool result, not just ok=false", async () => {
  const { client } = await setup({
    query: (req, respond) => {
      respond({
        id: req["id"],
        ok: false,
        error: "not_found",
        detail: "no node with test_id 'score_buttn'",
        suggestions: ["score_button"],
      });
    },
  });
  const result = await client!.callTool({ name: "query", arguments: { test_id: "score_buttn" } });
  assert.equal(result.isError, true);
  const payload = parseResultText(result);
  assert.equal(payload["error"], "not_found");
  assert.deepEqual(payload["suggestions"], ["score_button"]);
});

test("ambiguous errors carry their candidates through the tool result", async () => {
  const { client } = await setup({
    "act.press": (req, respond) => {
      respond({
        id: req["id"],
        ok: false,
        error: "ambiguous",
        detail: "test_id 'dup_demo' matches 2 nodes",
        candidates: [{ path: "/root/Main/A" }, { path: "/root/Main/B" }],
      });
    },
  });
  const result = await client!.callTool({ name: "act_press", arguments: { test_id: "dup_demo" } });
  assert.equal(result.isError, true);
  const payload = parseResultText(result);
  assert.equal(payload["error"], "ambiguous");
  assert.equal((payload["candidates"] as unknown[]).length, 2);
});

test("time_scale and time_frames map to cmd='time.scale'/'time.frames'", async () => {
  const { client } = await setup({
    "time.scale": (req, respond) => {
      assert.equal(req["factor"], 2);
      respond({ id: req["id"], ok: true });
    },
    "time.frames": (req, respond) => {
      assert.equal(req["n"], 10);
      assert.equal(req["physics"], false);
      respond({ id: req["id"], ok: true });
    },
  });
  const scaleResult = await client!.callTool({ name: "time_scale", arguments: { factor: 2 } });
  assert.equal(parseResultText(scaleResult)["ok"], true);
  const framesResult = await client!.callTool({ name: "time_frames", arguments: { n: 10, physics: false } });
  assert.equal(parseResultText(framesResult)["ok"], true);
});

test("screenshot maps to cmd='screenshot' and surfaces no_renderer without swallowing it", async () => {
  const { client } = await setup({
    screenshot: (req, respond) => {
      respond({ id: req["id"], ok: false, error: "no_renderer", detail: "no renderer available in headless mode" });
    },
  });
  const result = await client!.callTool({ name: "screenshot", arguments: {} });
  assert.equal(result.isError, true);
  const payload = parseResultText(result);
  assert.equal(payload["error"], "no_renderer");
});

test("hello maps to cmd='hello' and returns capabilities", async () => {
  const { client } = await setup();
  const result = await client!.callTool({ name: "hello", arguments: {} });
  const payload = parseResultText(result);
  assert.equal(payload["ok"], true);
  assert.equal(payload["protocol"], 0);
});

test("hello on matching versions keeps the bridge fields unchanged and adds a compatible verdict", async () => {
  // Issue #58: the verdict is additive — everything the Bridge sent stays
  // where it was, so existing readers of protocol/state_contract don't break.
  const { client } = await setup();
  const result = await client!.callTool({ name: "hello", arguments: {} });
  assert.ok(!result.isError);
  const payload = parseResultText(result);
  assert.equal(payload["ok"], true);
  assert.equal(payload["protocol"], 0);
  assert.equal(payload["state_contract"], 0);
  assert.equal(payload["engine"], "4.6.3-fake");
  assert.deepEqual(payload["capabilities"], []);
  const compat = payload["compatibility"] as Record<string, unknown>;
  assert.equal(compat["compatible"], true);
  assert.match(compat["message"] as string, /match/);
});

test("hello against an addon with a newer protocol warns 'update the server' without blocking", async () => {
  const { client } = await setup({
    hello: (req, respond) =>
      respond({ id: req["id"], ok: true, protocol: 7, state_contract: 0, engine: "4.6.3-fake", capabilities: [] }),
  });
  const result = await client!.callTool({ name: "hello", arguments: {} });
  // Annotate, do not block (issue #58): the protocol is additive, a version
  // drift is a warning in the payload, never an MCP-level error.
  assert.ok(!result.isError);
  const payload = parseResultText(result);
  assert.equal(payload["protocol"], 7, "the Bridge's own protocol field must pass through unchanged");
  const compat = payload["compatibility"] as Record<string, unknown>;
  assert.equal(compat["compatible"], false);
  assert.match(compat["message"] as string, /addon reports protocol 7/);
  assert.match(compat["message"] as string, /update the server/);
});

test("hello against a diverging state_contract warns with distinct wording", async () => {
  const { client } = await setup({
    hello: (req, respond) =>
      respond({ id: req["id"], ok: true, protocol: 0, state_contract: 3, engine: "4.6.3-fake", capabilities: [] }),
  });
  const result = await client!.callTool({ name: "hello", arguments: {} });
  assert.ok(!result.isError);
  const payload = parseResultText(result);
  const compat = payload["compatibility"] as Record<string, unknown>;
  assert.equal(compat["compatible"], false);
  assert.match(compat["message"] as string, /state contract/);
  assert.doesNotMatch(compat["message"] as string, /addon reports protocol/);
});

test("quit_game tool sends cmd='quit' to the bridge and closes the session", async () => {
  let quitReceived: Record<string, unknown> | undefined;
  const { client } = await setup({
    quit: (req, respond) => {
      quitReceived = req;
      respond({ id: req["id"], ok: true });
    },
  });
  const result = await client!.callTool({ name: "quit_game", arguments: {} });
  assert.ok(!result.isError);
  const payload = parseResultText(result);
  assert.equal(payload["ok"], true);
  assert.ok(quitReceived, "the bridge should have received a 'quit' request");
  assert.equal(session!.isConnected(), false, "quit_game should close the session like disconnect");
});

test("wait_for tool forwards a method/args domain query to cmd='wait_for'", async () => {
  const { client } = await setup({
    wait_for: (req, respond) => {
      assert.equal(req["test_id"], "game");
      assert.equal(req["method"], "score_at_least");
      assert.deepEqual(req["args"], [2]);
      assert.equal(req["equals"], true);
      respond({ id: req["id"], ok: true, node: { test_id: "game" } });
    },
  });
  const result = await client!.callTool({
    name: "wait_for",
    arguments: { test_id: "game", method: "score_at_least", args: [2], equals: true },
  });
  const payload = parseResultText(result);
  assert.equal(payload["ok"], true);
});

test("time_step_until tool maps to cmd='time.step_until' with a plain selector, returns node + frames", async () => {
  const { client } = await setup({
    "time.step_until": (req, respond) => {
      assert.equal(req["test_id"], "player");
      assert.equal(req["max_frames"], 30);
      respond({ id: req["id"], ok: true, node: { test_id: "player" }, frames: 0 });
    },
  });
  const result = await client!.callTool({
    name: "time_step_until",
    arguments: { test_id: "player", max_frames: 30 },
  });
  assert.ok(!result.isError);
  const payload = parseResultText(result);
  assert.equal(payload["ok"], true);
  assert.equal(payload["frames"], 0);
});

test("time_step_until tool forwards a method/args domain query to cmd='time.step_until'", async () => {
  const { client } = await setup({
    "time.step_until": (req, respond) => {
      assert.equal(req["test_id"], "game");
      assert.equal(req["method"], "score_at_least");
      assert.deepEqual(req["args"], [2]);
      assert.equal(req["equals"], true);
      respond({ id: req["id"], ok: true, node: { test_id: "game" }, frames: 12 });
    },
  });
  const result = await client!.callTool({
    name: "time_step_until",
    arguments: { test_id: "game", method: "score_at_least", args: [2], equals: true },
  });
  const payload = parseResultText(result);
  assert.equal(payload["ok"], true);
  assert.equal(payload["frames"], 12);
});

test("time_step_until tool surfaces a budget-exhaustion timeout, not swallowed", async () => {
  const { client } = await setup({
    "time.step_until": (req, respond) => {
      respond({
        id: req["id"],
        ok: false,
        error: "timeout",
        detail: "time.step_until exhausted its frame budget (max_frames=5) after 5 frame(s)",
        frames: 5,
      });
    },
  });
  const result = await client!.callTool({
    name: "time_step_until",
    arguments: { test_id: "score_label", property: "text", equals: "never", max_frames: 5 },
  });
  assert.equal(result.isError, true);
  const payload = parseResultText(result);
  assert.equal(payload["error"], "timeout");
  assert.equal(payload["frames"], 5);
});

test("time_step_until's client_timeout_ms is never forwarded to the bridge, and is stripped from the recorded trace entry", async () => {
  const { client } = await setup({
    "time.step_until": (req, respond) => {
      assert.ok(!("client_timeout_ms" in req), "client_timeout_ms leaked to the Bridge");
      respond({ id: req["id"], ok: true, node: { test_id: "player" }, frames: 0 });
    },
  });
  const result = await client!.callTool({
    name: "time_step_until",
    arguments: { test_id: "player", client_timeout_ms: 60_000 },
  });
  assert.ok(!result.isError);
  // ticket #39: time.step_until now has replay value (trace.ts
  // REPLAYABLE_VERBS) — the step itself IS recorded, but the purely
  // client-side client_timeout_ms must never leak into the recorded params.
  const trace = session!.getTrace();
  assert.equal(trace.length, 1);
  assert.equal(trace[0].kind, "verb");
  const verbEntry = trace[0] as { cmd: string; params: Record<string, unknown> };
  assert.equal(verbEntry.cmd, "time.step_until");
  assert.ok(!("client_timeout_ms" in verbEntry.params), "client_timeout_ms leaked into the trace entry");
});

test("time_step_until tool forwards 'signal' to the bridge, which rejects it as bad_request", async () => {
  const { client } = await setup({
    "time.step_until": (req, respond) => {
      assert.equal(req["signal"], "scored");
      respond({
        id: req["id"],
        ok: false,
        error: "bad_request",
        detail: "time.step_until does not support 'signal' mode — use wait_for to wait on a one-shot signal",
      });
    },
  });
  const result = await client!.callTool({
    name: "time_step_until",
    arguments: { test_id: "game", signal: "scored" },
  });
  assert.equal(result.isError, true);
  const payload = parseResultText(result);
  assert.equal(payload["error"], "bad_request");
});

test("time_step_until tool accepts max_frames: 0 (check once, no stepping)", async () => {
  const { client } = await setup({
    "time.step_until": (req, respond) => {
      assert.equal(req["max_frames"], 0);
      respond({ id: req["id"], ok: true, node: { test_id: "player" }, frames: 0 });
    },
  });
  const result = await client!.callTool({
    name: "time_step_until",
    arguments: { test_id: "player", max_frames: 0 },
  });
  assert.ok(!result.isError);
  const payload = parseResultText(result);
  assert.equal(payload["ok"], true);
  assert.equal(payload["frames"], 0);
});

test("quit_game tool before attach/launch_game surfaces a clear error instead of hanging", async () => {
  const session = new Session();
  const server = new McpServer({ name: "test-server", version: "0.0.0" });
  registerTools(server, session);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const result = await client.callTool({ name: "quit_game", arguments: {} });
    assert.equal(result.isError, true);
    const content = result.content as Array<{ type: string; text: string }>;
    assert.match(content[0].text, /launch_game|attach/);
  } finally {
    server.close();
    client.close();
  }
});

test("client_timeout_ms is never forwarded to the bridge nor recorded in the trace", async () => {
  // Dogfooding friction #7 (FRICTIONS.md): the client timeout is a transport
  // setting, not a protocol parameter — the Bridge must never see it, and a
  // freeze_scenario must never freeze it into a generated test.
  const { client } = await setup({
    "act.press": (req, respond) => {
      assert.ok(!("client_timeout_ms" in req), "client_timeout_ms leaked to the Bridge");
      respond({ id: req["id"], ok: true });
    },
  });
  const result = await client!.callTool({
    name: "act_press",
    arguments: { test_id: "score_button", client_timeout_ms: 60_000 },
  });
  assert.ok(!result.isError);
  const trace = session!.getTrace();
  assert.equal(trace.length, 1);
  assert.equal(trace[0].kind, "verb");
  assert.ok(!("client_timeout_ms" in (trace[0] as { params: Record<string, unknown> }).params));
});

test("client_timeout_ms bounds the wait for a frozen bridge (shader-compile freeze)", async () => {
  const { client } = await setup({
    query: () => {
      /* never responds: simulates a frozen main thread (shader compilation) */
    },
  });
  const result = await client!.callTool({
    name: "query",
    arguments: { test_id: "anything", client_timeout_ms: 50 },
  });
  assert.equal(result.isError, true);
  const content = result.content as Array<{ type: string; text: string }>;
  assert.match(content[0].text, /timed out client-side after 50ms/);
});

test("client_timeout_ms overrides wait_for's default timeout_ms+margin client deadline", async () => {
  // Without client_timeout_ms, the client would wait timeout_ms + 2000ms (margin):
  // here it must time out well before that, at 50ms.
  const { client } = await setup({
    wait_for: () => {
      /* never responds */
    },
  });
  const started = Date.now();
  const result = await client!.callTool({
    name: "wait_for",
    arguments: { test_id: "x", timeout_ms: 5_000, client_timeout_ms: 50 },
  });
  assert.equal(result.isError, true);
  const content = result.content as Array<{ type: string; text: string }>;
  assert.match(content[0].text, /timed out client-side after 50ms/);
  assert.ok(Date.now() - started < 4_000, "the client waited the default margin instead of the custom timeout");
});

test("assert_eventually_property forwards client_timeout_ms to its underlying wait_for", async () => {
  const { client } = await setup({
    wait_for: () => {
      /* never responds */
    },
  });
  const result = await client!.callTool({
    name: "assert_eventually_property",
    arguments: { test_id: "x", property: "health", equals: 0, timeout_ms: 5_000, client_timeout_ms: 50 },
  });
  assert.equal(result.isError, true);
  const content = result.content as Array<{ type: string; text: string }>;
  assert.match(content[0].text, /timed out client-side after 50ms/);
});

test("assert_now_property forwards client_timeout_ms to its underlying wait_for", async () => {
  const { client } = await setup({
    wait_for: () => {
      /* never responds */
    },
  });
  const result = await client!.callTool({
    name: "assert_now_property",
    arguments: { test_id: "x", property: "health", equals: 0, client_timeout_ms: 50 },
  });
  assert.equal(result.isError, true);
  const content = result.content as Array<{ type: string; text: string }>;
  assert.match(content[0].text, /timed out client-side after 50ms/);
});

test("assert_now_property explains a mismatch instead of reporting a 0ms timeout", async () => {
  // The wire has no one-shot read, so this verb sends `wait_for` with
  // `timeout_ms: 0` — which makes the Bridge label a plain mismatch as a
  // `timeout`. On a verb that never waits, "timed out after 0ms" would send
  // the agent hunting for a timeout that does not exist.
  const { client } = await setup({
    wait_for: (req, respond) =>
      respond({
        id: req["id"],
        ok: false,
        error: "timeout",
        detail: "wait_for timed out after 0ms",
      }),
  });
  const result = await client!.callTool({
    name: "assert_now_property",
    arguments: { test_id: "x", property: "health", equals: 0 },
  });
  assert.equal(result.isError, true);
  const content = result.content as Array<{ type: string; text: string }>;
  assert.match(content[0].text, /did not match at call time/);
  // The Bridge's own wording is preserved rather than overwritten.
  assert.match(content[0].text, /bridge: wait_for timed out after 0ms/);
});

test("calling a tool before attach/launch_game surfaces a clear error instead of hanging", async () => {
  // Session without a connection: the tool must respond cleanly, not crash
  // the process nor hang indefinitely.
  const session = new Session();
  const server = new McpServer({ name: "test-server", version: "0.0.0" });
  registerTools(server, session);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const result = await client.callTool({ name: "query", arguments: {} });
    assert.equal(result.isError, true);
    const content = result.content as Array<{ type: string; text: string }>;
    assert.match(content[0].text, /launch_game|attach/);
  } finally {
    server.close();
    client.close();
  }
});
