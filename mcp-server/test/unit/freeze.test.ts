/**
 * Freeze (ticket #13): session trace → frozen test, with live
 * re-verification of selectors — against a fake Bridge (same patterns as
 * tools.test.ts).
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTools } from "../../src/tools.js";
import { Session } from "../../src/session.js";
import { generateFrozenScript, FreezeRefusedError } from "../../src/freeze.js";
import { defaultHandler, FakeBridge } from "../helpers/fake-bridge.js";

let bridge: FakeBridge | undefined;
let session: Session | undefined;
let client: Client | undefined;
let tmpDir: string | undefined;

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
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  client = undefined;
  session = undefined;
  bridge = undefined;
  tmpDir = undefined;
});

function parseResultText(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const content = result.content as Array<{ type: string; text: string }>;
  assert.equal(content.length, 1);
  assert.equal(content[0].type, "text");
  return JSON.parse(content[0].text);
}

test("assert_eventually_property records a passing assertion into the session trace with mode 'eventually'", async () => {
  await setup({
    wait_for: (req, respond) => {
      assert.equal(req["test_id"], "score_label");
      assert.equal(req["property"], "text");
      assert.equal(req["equals"], "1");
      respond({ id: req["id"], ok: true, node: { test_id: "score_label", text: "1" } });
    },
  });
  const result = await client!.callTool({
    name: "assert_eventually_property",
    arguments: { test_id: "score_label", property: "text", equals: "1" },
  });
  assert.ok(!result.isError);
  const trace = session!.getTrace();
  assert.equal(trace.length, 1);
  assert.equal(trace[0].kind, "assertion");
  assert.equal((trace[0] as { mode: string }).mode, "eventually");
});

test("assert_eventually_property does not record a failing assertion", async () => {
  await setup({
    wait_for: (req, respond) => {
      respond({ id: req["id"], ok: false, error: "timeout", detail: "never became '1'" });
    },
  });
  const result = await client!.callTool({
    name: "assert_eventually_property",
    arguments: { test_id: "score_label", property: "text", equals: "1" },
  });
  assert.equal(result.isError, true);
  assert.equal(session!.getTrace().length, 0);
});

test("assert_now_property records a passing assertion into the session trace with mode 'now', sending timeout_ms: 0", async () => {
  await setup({
    wait_for: (req, respond) => {
      assert.equal(req["test_id"], "score_label");
      assert.equal(req["property"], "text");
      assert.equal(req["equals"], "0");
      assert.equal(req["timeout_ms"], 0);
      respond({ id: req["id"], ok: true, node: { test_id: "score_label", text: "0" } });
    },
  });
  const result = await client!.callTool({
    name: "assert_now_property",
    arguments: { test_id: "score_label", property: "text", equals: "0" },
  });
  assert.ok(!result.isError);
  const trace = session!.getTrace();
  assert.equal(trace.length, 1);
  assert.equal(trace[0].kind, "assertion");
  assert.equal((trace[0] as { mode: string }).mode, "now");
});

test("assert_now_property does not record a failing assertion", async () => {
  await setup({
    wait_for: (req, respond) => {
      respond({ id: req["id"], ok: false, error: "timeout", detail: "wait_for timed out after 0ms" });
    },
  });
  const result = await client!.callTool({
    name: "assert_now_property",
    arguments: { test_id: "score_label", property: "text", equals: "1" },
  });
  assert.equal(result.isError, true);
  assert.equal(session!.getTrace().length, 0);
});

test("time_step_until records a resolving call into the session trace as a replayable verb (ticket #39)", async () => {
  await setup({
    "time.step_until": (req, respond) => {
      assert.equal(req["test_id"], "game");
      assert.equal(req["method"], "true_after_n_frames");
      respond({ id: req["id"], ok: true, node: { test_id: "game" }, frames: 6 });
    },
  });
  const result = await client!.callTool({
    name: "time_step_until",
    arguments: { test_id: "game", method: "true_after_n_frames", args: [6], equals: true, max_frames: 30 },
  });
  assert.ok(!result.isError);
  const trace = session!.getTrace();
  assert.equal(trace.length, 1);
  assert.equal(trace[0].kind, "verb");
  assert.equal((trace[0] as { cmd: string }).cmd, "time.step_until");
});

test("freeze_scenario refuses when a selector no longer resolves live", async () => {
  await setup({
    "act.press": (req, respond) => respond({ id: req["id"], ok: true }),
    wait_for: (req, respond) => {
      if (req["equals"] === undefined) {
        // live re-verification (plain mode): the selector no longer resolves.
        respond({ id: req["id"], ok: false, error: "not_found", detail: "no such test_id", suggestions: [] });
        return;
      }
      respond({ id: req["id"], ok: true, node: { test_id: "score_label", text: "1" } });
    },
  });
  await client!.callTool({ name: "act_press", arguments: { test_id: "score_button" } });
  await client!.callTool({
    name: "assert_eventually_property",
    arguments: { test_id: "score_label", property: "text", equals: "1" },
  });

  tmpDir = mkdtempSync(join(tmpdir(), "godot-playtest-freeze-"));
  const result = await client!.callTool({
    name: "freeze_scenario",
    arguments: { name: "score button", scene_path: "res://fixtures/witness_game/main.tscn", project_path: tmpDir },
  });
  assert.equal(result.isError, true);
  const content = result.content as Array<{ type: string; text: string }>;
  assert.match(content[0].text, /no longer resolve/);
});

test("freeze_scenario refuses a non-CI-safe scenario unless windowed:true, and writes the file otherwise", async () => {
  await setup({
    "act.input": (req, respond) => respond({ id: req["id"], ok: true }),
    wait_for: (req, respond) => respond({ id: req["id"], ok: true, node: { test_id: "cursor" } }),
  });
  await client!.callTool({
    name: "act_input",
    arguments: { type: "click", position: [10, 20] },
  });

  tmpDir = mkdtempSync(join(tmpdir(), "godot-playtest-freeze-"));

  const refused = await client!.callTool({
    name: "freeze_scenario",
    arguments: { name: "click scenario", scene_path: "res://main.tscn", project_path: tmpDir },
  });
  assert.equal(refused.isError, true);
  const refusedContent = refused.content as Array<{ type: string; text: string }>;
  assert.match(refusedContent[0].text, /windowed/);

  const accepted = await client!.callTool({
    name: "freeze_scenario",
    arguments: { name: "click scenario", scene_path: "res://main.tscn", project_path: tmpDir, windowed: true },
  });
  assert.ok(!accepted.isError);
  const payload = parseResultText(accepted);
  assert.equal(payload["ci_safe"], false);
  const filePath = payload["file_path"] as string;
  const written = readFileSync(filePath, "utf8");
  assert.match(written, /PLAYTEST_WINDOWED := true/);
  assert.match(written, /input\(\{"type": "click"/);
});

test("freeze_scenario writes an idiomatic CI-safe script under playtests/", async () => {
  await setup({
    "act.press": (req, respond) => respond({ id: req["id"], ok: true }),
    wait_for: (req, respond) => respond({ id: req["id"], ok: true, node: { test_id: "score_label", text: "1" } }),
  });
  await client!.callTool({ name: "act_press", arguments: { test_id: "score_button" } });
  await client!.callTool({
    name: "assert_now_property",
    arguments: { test_id: "score_label", property: "text", equals: "1" },
  });
  await client!.callTool({
    name: "wait_for",
    arguments: { test_id: "score_label", property: "text", equals: "1", timeout_ms: 2000 },
  });
  await client!.callTool({
    name: "assert_eventually_property",
    arguments: { test_id: "score_label", property: "text", equals: "1" },
  });

  tmpDir = mkdtempSync(join(tmpdir(), "godot-playtest-freeze-"));
  const result = await client!.callTool({
    name: "freeze_scenario",
    arguments: {
      name: "score button increments",
      scene_path: "res://fixtures/witness_game/main.tscn",
      project_path: tmpDir,
    },
  });
  assert.ok(!result.isError);
  const payload = parseResultText(result);
  assert.equal(payload["ci_safe"], true);
  assert.equal(payload["file_name"], "score_button_increments.gd");
  const filePath = payload["file_path"] as string;
  assert.equal(filePath, join(tmpDir, "playtests", "score_button_increments.gd"));
  const written = readFileSync(filePath, "utf8");
  assert.match(written, /extends PlaytestCase/);
  assert.match(written, /func test_score_button_increments\(\) -> void:/);
  assert.match(written, /await start_game\("res:\/\/fixtures\/witness_game\/main\.tscn"\)/);
  assert.match(written, /press\(\{"test_id": "score_button"\}\)/);
  assert.match(written, /await assert_now_property\(\{"test_id": "score_label"\}, "text", "1"\)/);
  assert.match(written, /await wait_for\(\{"test_id": "score_label"\}, \{"property": "text", "equals": "1", "timeout_ms": 2000\}\)/);
  assert.match(written, /await assert_eventually_property\(\{"test_id": "score_label"\}, "text", "1"\)/);
});

test("freeze_scenario refuses an empty trace", async () => {
  await setup();
  tmpDir = mkdtempSync(join(tmpdir(), "godot-playtest-freeze-"));
  const result = await client!.callTool({
    name: "freeze_scenario",
    arguments: { name: "nothing", scene_path: "res://main.tscn", project_path: tmpDir },
  });
  assert.equal(result.isError, true);
});

test("generateFrozenScript throws FreezeRefusedError for screenshot without windowed", () => {
  assert.throws(
    () =>
      generateFrozenScript(
        [{ kind: "verb", cmd: "screenshot", params: {}, response: { ok: true }, at: 0 }],
        { name: "shot", scenePath: "res://main.tscn" },
      ),
    FreezeRefusedError,
  );
});

test("generateFrozenScript sanitizes the scenario name into snake_case", () => {
  const result = generateFrozenScript([], { name: "  Score Button!! Increments  ", scenePath: "res://main.tscn" });
  assert.equal(result.fileName, "score_button_increments.gd");
  assert.match(result.code, /func test_score_button_increments\(\) -> void:/);
});

test("generateFrozenScript renders a wait_for method/args domain query, CI-safe", () => {
  const result = generateFrozenScript(
    [
      {
        kind: "verb",
        cmd: "wait_for",
        params: { test_id: "game", method: "score_at_least", args: [1], equals: true, timeout_ms: 2000 },
        response: { ok: true },
        at: 0,
      },
    ],
    { name: "domain query", scenePath: "res://main.tscn" },
  );
  assert.equal(result.ciSafe, true);
  assert.match(
    result.code,
    /await wait_for\(\{"test_id": "game"\}, \{"method": "score_at_least", "args": \[1\], "equals": true, "timeout_ms": 2000\}\)/,
  );
});

test("generateFrozenScript renders a plain time.step_until as a bare await statement, CI-safe", () => {
  const result = generateFrozenScript(
    [
      {
        kind: "verb",
        cmd: "time.step_until",
        params: { test_id: "player" },
        response: { ok: true, node: { test_id: "player" }, frames: 0 },
        at: 0,
      },
    ],
    { name: "plain step until", scenePath: "res://main.tscn" },
  );
  assert.equal(result.ciSafe, true);
  assert.match(result.code, /await time_step_until\(\{"test_id": "player"\}\)\n/);
});

test("generateFrozenScript renders a time.step_until method/args domain query with max_frames, discarding the {node, frames} return value (ticket #39)", () => {
  const result = generateFrozenScript(
    [
      {
        kind: "verb",
        cmd: "time.step_until",
        params: { test_id: "game", method: "true_after_n_frames", args: [6], equals: true, max_frames: 30 },
        response: { ok: true, node: { test_id: "game" }, frames: 6 },
        at: 0,
      },
    ],
    { name: "step until domain query", scenePath: "res://main.tscn" },
  );
  assert.equal(result.ciSafe, true);
  assert.match(
    result.code,
    /await time_step_until\(\{"test_id": "game"\}, \{"method": "true_after_n_frames", "args": \[6\], "equals": true, "max_frames": 30\}\)/,
  );
  // The in-process mirror returns a Dictionary ({"node", "frames"}), not a
  // bare Node (#38) — the generated line must not assign it to anything.
  assert.doesNotMatch(result.code, /=\s*await time_step_until/);
});
