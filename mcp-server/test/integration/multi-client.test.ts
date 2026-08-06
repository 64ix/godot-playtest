/**
 * MCP integration suite for the named-instance dimension (spec #66,
 * criterion "two real game processes launched under distinct instance
 * names"): two real `fixtures/witness_game` processes, driven through the
 * actual MCP tool surface (`McpServer`/`Client`, same harness as
 * test/unit/tools.test.ts, but against real Bridges instead of a fake one —
 * prior art: fixture.test.ts/freeze.test.ts (integration)).
 *
 * Proves, end to end:
 * - per-instance verbs route to the right process;
 * - `launch_game`/`attach` add-not-replace (a third instance, and
 *   re-launching an existing slot, both leave the others untouched);
 * - `NotConnectedError` names the instance a tool call couldn't find;
 * - freezing a two-client trace produces a file whose text matches the
 *   emission decisions (hoisted declaration, handle prefix, no launch call,
 *   no literal port).
 *
 * Skips cleanly (no failure) if GODOT_BIN is not provided, same convention
 * as the rest of this directory.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTools } from "../../src/tools.js";
import { Session } from "../../src/session.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..", "..");
const GODOT_BIN = process.env.GODOT_BIN;

function parseResultText(result: { content?: unknown }): Record<string, unknown> {
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0].text);
}

test(
  "two real game processes under distinct instance names: per-instance routing, add-not-replace, NotConnectedError naming, two-client freeze",
  { skip: !GODOT_BIN && "GODOT_BIN not set — export it to run the real-fixture integration test" },
  async () => {
    const session = new Session();
    const server = new McpServer({ name: "test-server", version: "0.0.0" });
    registerTools(server, session);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    const launchArgs = { command: GODOT_BIN!, args: ["--path", PROJECT_ROOT, "--headless"] };
    let tmpDir: string | undefined;
    let orphanedProcess: ReturnType<Session["getLaunchedProcess"]> | undefined;

    try {
      // --- launch two real, independent processes -----------------------
      const launchDefault = await client.callTool({ name: "launch_game", arguments: launchArgs });
      assert.ok(!launchDefault.isError, JSON.stringify(launchDefault.content));

      const launchB = await client.callTool({ name: "launch_game", arguments: { ...launchArgs, instance: "b" } });
      assert.ok(!launchB.isError, JSON.stringify(launchB.content));

      // add-not-replace: both must be independently connected.
      assert.equal(session.isConnected("default"), true);
      assert.equal(session.isConnected("b"), true);

      // --- per-instance routing: two truly separate processes ------------
      const defaultBefore = await client.callTool({ name: "query", arguments: { test_id: "score_label" } });
      assert.equal((parseResultText(defaultBefore)["nodes"] as Array<Record<string, unknown>>)[0]["text"], "0");
      const bBefore = await client.callTool({
        name: "query",
        arguments: { test_id: "score_label", instance: "b" },
      });
      assert.equal((parseResultText(bBefore)["nodes"] as Array<Record<string, unknown>>)[0]["text"], "0");

      const pressDefault = await client.callTool({ name: "act_press", arguments: { test_id: "score_button" } });
      assert.ok(!pressDefault.isError);
      await client.callTool({
        name: "wait_for",
        arguments: { test_id: "score_label", property: "text", equals: "1", timeout_ms: 3000 },
      });

      // 'b' must be unaffected by the press sent to 'default'.
      const bAfterDefaultPress = await client.callTool({
        name: "query",
        arguments: { test_id: "score_label", instance: "b" },
      });
      assert.equal(
        (parseResultText(bAfterDefaultPress)["nodes"] as Array<Record<string, unknown>>)[0]["text"],
        "0",
        "instance 'b' must stay at its own state — two separate processes, not one process driven twice",
      );

      const pressB = await client.callTool({
        name: "act_press",
        arguments: { test_id: "score_button", instance: "b" },
      });
      assert.ok(!pressB.isError);
      const waitB = await client.callTool({
        name: "wait_for",
        arguments: { test_id: "score_label", property: "text", equals: "1", timeout_ms: 3000, instance: "b" },
      });
      assert.ok(!waitB.isError);

      // --- add-not-replace: a third instance leaves the first two alone --
      const launchC = await client.callTool({ name: "launch_game", arguments: { ...launchArgs, instance: "c" } });
      assert.ok(!launchC.isError, JSON.stringify(launchC.content));
      assert.equal(session.isConnected("default"), true);
      assert.equal(session.isConnected("b"), true);
      assert.equal(session.isConnected("c"), true);
      await client.callTool({ name: "quit_game", arguments: { instance: "c" } });
      assert.equal(session.isConnected("c"), false);

      // --- slot-replacement: relaunching 'b' only touches 'b' -------------
      // The pre-replacement process is deliberately never killed by
      // `launch_game` itself (same "leave it running, the agent may want to
      // inspect it" contract `disconnect()` already carried pre-#66) — this
      // test kills it explicitly afterwards so it doesn't leak past this run.
      orphanedProcess = session.getLaunchedProcess("b");
      const relaunchB = await client.callTool({ name: "launch_game", arguments: { ...launchArgs, instance: "b" } });
      assert.ok(!relaunchB.isError, JSON.stringify(relaunchB.content));
      assert.equal(session.isConnected("default"), true, "relaunching 'b' must not disturb 'default'");
      const bAfterRelaunch = await client.callTool({
        name: "query",
        arguments: { test_id: "score_label", instance: "b" },
      });
      assert.equal(
        (parseResultText(bAfterRelaunch)["nodes"] as Array<Record<string, unknown>>)[0]["text"],
        "0",
        "the relaunched 'b' is a fresh process",
      );
      // Bring the relaunched 'b' back to "1" (it forgot the earlier press —
      // a fresh process) before it takes part in the freeze section below.
      const rePressB = await client.callTool({
        name: "act_press",
        arguments: { test_id: "score_button", instance: "b" },
      });
      assert.ok(!rePressB.isError);
      const reWaitB = await client.callTool({
        name: "wait_for",
        arguments: { test_id: "score_label", property: "text", equals: "1", timeout_ms: 3000, instance: "b" },
      });
      assert.ok(!reWaitB.isError);

      // --- NotConnectedError names the instance ---------------------------
      const ghostResult = await client.callTool({ name: "query", arguments: { instance: "ghost" } });
      assert.equal(ghostResult.isError, true);
      const ghostContent = ghostResult.content as Array<{ type: string; text: string }>;
      assert.match(ghostContent[0].text, /'ghost'/);

      // --- freeze a two-client trace ---------------------------------------
      // step_until on the named instance (the #48/#67 merge-order gap): must
      // route to 'b' and land in the trace as a handle-addressed entry.
      const stepB = await client.callTool({
        name: "time_step_until",
        arguments: { test_id: "score_label", property: "text", equals: "1", max_frames: 300, instance: "b" },
      });
      assert.ok(!stepB.isError, JSON.stringify(stepB.content));

      const assertB = await client.callTool({
        name: "assert_eventually_property",
        arguments: { test_id: "score_label", property: "text", equals: "1", instance: "b" },
      });
      assert.ok(!assertB.isError, JSON.stringify(assertB.content));
      const assertDefault = await client.callTool({
        name: "assert_eventually_property",
        arguments: { test_id: "score_label", property: "text", equals: "1" },
      });
      assert.ok(!assertDefault.isError, JSON.stringify(assertDefault.content));

      tmpDir = mkdtempSync(join(tmpdir(), "godot-playtest-multi-client-freeze-"));
      const freezeResult = await client.callTool({
        name: "freeze_scenario",
        arguments: {
          name: "two clients",
          scene_path: "res://fixtures/witness_game/main.tscn",
          project_path: tmpDir,
        },
      });
      assert.ok(!freezeResult.isError, JSON.stringify(freezeResult.content));
      const freezePayload = parseResultText(freezeResult);
      const code = freezePayload["code"] as string;

      assert.match(code, /var b := await attach_instance\("b"\)/);
      assert.match(code, /await b\.press\(\{"test_id": "score_button"\}\)/);
      assert.match(
        code,
        /await b\.time_step_until\(\{"test_id": "score_label"\}, \{"property": "text", "equals": "1", "max_frames": 300\}\)/,
      );
      assert.match(code, /await b\.assert_eventually_property\(\{"test_id": "score_label"\}, "text", "1"\)/);
      assert.match(code, /await assert_eventually_property\(\{"test_id": "score_label"\}, "text", "1"\)/);
      assert.doesNotMatch(code, /launch_game/);
      assert.doesNotMatch(code, /bridge-port/);

      const written = readFileSync(join(tmpDir, "playtests", freezePayload["file_name"] as string), "utf8");
      assert.equal(written, code);
    } finally {
      for (const instance of session.connectedInstances()) {
        try {
          await client.callTool({ name: "quit_game", arguments: { instance } }, undefined, { timeout: 10_000 });
        } catch {
          /* best effort — a leftover process is still cleaned up by the OS at worst */
        }
      }
      // The process the 'b' slot-replacement orphaned (never killed by
      // `launch_game` itself, cf. the comment above) — a leftover live
      // process with a piped stdout/stderr would otherwise keep this test
      // file's event loop from ever going idle.
      if (orphanedProcess && orphanedProcess.exitCode === null) orphanedProcess.kill("SIGKILL");
      server.close();
      client.close();
      if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    }
  },
);
