/**
 * Named-instance dimension on the MCP surface (spec #66): every per-instance
 * tool accepts an optional `instance` (default "default"), `launch_game`/
 * `attach` add-not-replace (replacing only their own named slot),
 * `NotConnectedError` names the missing instance, and a bare `quit_game`
 * closes only "default". Exercised against two `FakeBridge`s (same pattern
 * as tools.test.ts), so no real Godot binary is required here — the
 * two-real-processes version of these same contracts lives in
 * test/integration/multi-client.test.ts.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTools } from "../../src/tools.js";
import { NotConnectedError, Session } from "../../src/session.js";
import { InvalidInstanceNameError } from "../../src/instance-name.js";
import { defaultHandler, FakeBridge } from "../helpers/fake-bridge.js";

let bridgeDefault: FakeBridge | undefined;
let bridgeB: FakeBridge | undefined;
let session: Session | undefined;
let client: Client | undefined;

async function setupTwoInstances(
  defaultOverrides: Parameters<typeof defaultHandler>[0] = {},
  bOverrides: Parameters<typeof defaultHandler>[0] = {},
) {
  bridgeDefault = await FakeBridge.start(defaultHandler(defaultOverrides));
  bridgeB = await FakeBridge.start(defaultHandler(bOverrides));
  session = new Session();
  await session.attach(bridgeDefault.port);
  await session.attach(bridgeB.port, undefined, undefined, undefined, "b");

  const server = new McpServer({ name: "test-server", version: "0.0.0" });
  registerTools(server, session);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { server, client, session };
}

afterEach(async () => {
  session?.disconnect();
  await bridgeDefault?.stop();
  await bridgeB?.stop();
  client = undefined;
  session = undefined;
  bridgeDefault = undefined;
  bridgeB = undefined;
});

function parseResultText(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0].text);
}

test("query addresses the named instance: 'default' and 'b' see different bridges", async () => {
  const { client: c } = await setupTwoInstances(
    { query: (req, respond) => respond({ id: req["id"], ok: true, nodes: [{ test_id: "who", from: "default" }] }) },
    { query: (req, respond) => respond({ id: req["id"], ok: true, nodes: [{ test_id: "who", from: "b" }] }) },
  );

  const defaultResult = await c!.callTool({ name: "query", arguments: {} });
  const defaultNodes = parseResultText(defaultResult)["nodes"] as Array<Record<string, unknown>>;
  assert.equal(defaultNodes[0]["from"], "default");

  const bResult = await c!.callTool({ name: "query", arguments: { instance: "b" } });
  const bNodes = parseResultText(bResult)["nodes"] as Array<Record<string, unknown>>;
  assert.equal(bNodes[0]["from"], "b");
});

test("instance is never forwarded to the Bridge as a verb param", async () => {
  const { client: c } = await setupTwoInstances(
    {
      "act.press": (req, respond) => {
        assert.ok(!("instance" in req), "instance leaked to the Bridge");
        respond({ id: req["id"], ok: true });
      },
    },
    {
      "act.press": (req, respond) => {
        assert.ok(!("instance" in req), "instance leaked to the Bridge");
        respond({ id: req["id"], ok: true });
      },
    },
  );
  const result = await c!.callTool({ name: "act_press", arguments: { test_id: "score_button", instance: "b" } });
  assert.ok(!result.isError);
});

test("attach add-not-replace: attaching 'b' leaves 'default' connected", async () => {
  const { session: s } = await setupTwoInstances();
  assert.equal(s.isConnected(), true);
  assert.equal(s.isConnected("b"), true);
});

test("re-attaching a named slot replaces only that slot (launch-twice-to-restart, per instance)", async () => {
  const { session: s } = await setupTwoInstances();
  const replacementBridge = await FakeBridge.start(defaultHandler());
  try {
    await s.attach(replacementBridge.port, undefined, undefined, undefined, "b");
    assert.equal(s.isConnected("default"), true, "'default' must survive replacing only 'b'");
    assert.equal(s.isConnected("b"), true);
  } finally {
    await replacementBridge.stop();
  }
});

test("NotConnectedError names the missing instance", async () => {
  const s = new Session();
  assert.throws(
    () => s.requireClient("b"),
    (err: unknown) => err instanceof NotConnectedError && err.instance === "b" && /'b'/.test(err.message),
  );
});

test("calling a tool with an unaddressed instance surfaces a clear, instance-naming error", async () => {
  const { client: c } = await setupTwoInstances();
  const result = await c!.callTool({ name: "query", arguments: { instance: "ghost" } });
  assert.equal(result.isError, true);
  const content = result.content as Array<{ type: string; text: string }>;
  assert.match(content[0].text, /ghost/);
  assert.match(content[0].text, /launch_game|attach/);
});

test("bare quit_game closes only 'default', 'b' stays connected", async () => {
  const { client: c, session: s } = await setupTwoInstances({
    quit: (req, respond) => respond({ id: req["id"], ok: true }),
  });
  const result = await c!.callTool({ name: "quit_game", arguments: {} });
  assert.ok(!result.isError);
  assert.equal(s.isConnected("default"), false);
  assert.equal(s.isConnected("b"), true, "quit_game with no instance must not touch other instances (no quit-all)");
});

test("quit_game with instance='b' closes only 'b'", async () => {
  const { client: c, session: s } = await setupTwoInstances(
    {},
    { quit: (req, respond) => respond({ id: req["id"], ok: true }) },
  );
  const result = await c!.callTool({ name: "quit_game", arguments: { instance: "b" } });
  assert.ok(!result.isError);
  assert.equal(s.isConnected("b"), false);
  assert.equal(s.isConnected("default"), true);
});

test("screenshot is addressable per instance", async () => {
  const { client: c } = await setupTwoInstances(
    { screenshot: (req, respond) => respond({ id: req["id"], ok: false, error: "no_renderer", detail: "default" }) },
    { screenshot: (req, respond) => respond({ id: req["id"], ok: false, error: "no_renderer", detail: "b" }) },
  );
  const result = await c!.callTool({ name: "screenshot", arguments: { instance: "b" } });
  const payload = parseResultText(result);
  assert.equal(payload["detail"], "b");
});

test("time_step_until addresses the named instance, and its trace entry carries it (the #48/#67 merge-order gap)", async () => {
  let defaultCalls = 0;
  const { client: c, session: s } = await setupTwoInstances(
    {
      "time.step_until": (req, respond) => {
        defaultCalls++;
        respond({ id: req["id"], ok: true, node: { test_id: req["test_id"] }, frames: 0 });
      },
    },
    {
      "time.step_until": (req, respond) => {
        assert.ok(!("instance" in req), "instance leaked to the Bridge");
        respond({ id: req["id"], ok: true, node: { test_id: req["test_id"] }, frames: 3 });
      },
    },
  );
  const result = await c!.callTool({
    name: "time_step_until",
    arguments: { test_id: "remote_label", property: "text", equals: "1", instance: "b" },
  });
  assert.ok(!result.isError);
  assert.equal(parseResultText(result)["frames"], 3);
  assert.equal(defaultCalls, 0, "a step_until addressed to 'b' must never reach 'default'");
  const trace = s.getTrace();
  assert.equal(trace.length, 1);
  assert.equal((trace[0] as { instance: string }).instance, "b");
});

test("session.attach rejects an invalid new instance name", async () => {
  const s = new Session();
  await assert.rejects(() => s.attach(1, undefined, undefined, undefined, "Not Valid"), InvalidInstanceNameError);
});

test("attach tool surfaces an invalid instance name as a clean tool error, not a crash", async () => {
  const { client: c } = await setupTwoInstances();
  const result = await c!.callTool({ name: "attach", arguments: { port: bridgeB!.port, instance: "2bad" } });
  assert.equal(result.isError, true);
  const content = result.content as Array<{ type: string; text: string }>;
  assert.match(content[0].text, /invalid instance name/);
});

test("the trace tags each entry with the instance it addressed", async () => {
  const { client: c, session: s } = await setupTwoInstances(
    { "act.press": (req, respond) => respond({ id: req["id"], ok: true }) },
    { "act.press": (req, respond) => respond({ id: req["id"], ok: true }) },
  );
  await c!.callTool({ name: "act_press", arguments: { test_id: "score_button" } });
  await c!.callTool({ name: "act_press", arguments: { test_id: "remote_button", instance: "b" } });
  const trace = s.getTrace();
  assert.equal(trace.length, 2);
  assert.equal((trace[0] as { instance: string }).instance, "default");
  assert.equal((trace[1] as { instance: string }).instance, "b");
});

test("not_found is annotated with the instance searched", async () => {
  const { client: c } = await setupTwoInstances(
    {},
    {
      query: (req, respond) =>
        respond({ id: req["id"], ok: false, error: "not_found", detail: "no such test_id", suggestions: [] }),
    },
  );
  const result = await c!.callTool({ name: "query", arguments: { test_id: "ghost", instance: "b" } });
  assert.equal(result.isError, true);
  const payload = parseResultText(result);
  assert.equal(payload["error"], "not_found");
  assert.equal(payload["instance"], "b");
});
