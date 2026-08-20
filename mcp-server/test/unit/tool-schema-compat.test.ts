/**
 * Broad-compatibility guard on the published tool schemas (issue #23).
 *
 * OpenAI-compatible gateways backed by vLLM/xgrammar validate the whole
 * `tools` array before anything else and reject the request with a bare 400
 * when one schema uses a construct they don't support — taking every other
 * tool down with it. The constructs known to break them:
 *
 *   - JSON-Schema draft-07 *tuple validation* (`items` as an array of
 *     schemas, what `z.tuple()` serialises to), and its 2020-12 spelling
 *     `prefixItems`;
 *   - `$ref` (no schema store on the gateway side);
 *   - `oneOf`/`anyOf` at the root of a tool's parameters.
 *
 * This test walks every registered tool's `inputSchema` as the client sees it
 * and fails on any of them, so the class of regression can't come back.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTools } from "../../src/tools.js";
import { Session } from "../../src/session.js";

/** Every tool's `inputSchema`, as advertised over the wire. */
async function listToolSchemas(): Promise<Array<{ name: string; inputSchema: unknown }>> {
  const server = new McpServer({ name: "test-server", version: "0.0.0" });
  // No Bridge needed: no tool is called, only the schemas are read.
  registerTools(server, new Session());

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const { tools } = await client.listTools();
  return tools.map((t) => ({ name: t.name, inputSchema: t.inputSchema }));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every place inside `schema` that uses a rejected construct, as a path. */
function unsupportedConstructs(schema: unknown, path: string): string[] {
  if (Array.isArray(schema)) {
    return schema.flatMap((item, i) => unsupportedConstructs(item, `${path}/${i}`));
  }
  if (!isObject(schema)) return [];

  const found: string[] = [];
  if (Array.isArray(schema["items"])) found.push(`${path}/items is an array (tuple validation)`);
  if ("prefixItems" in schema) found.push(`${path}/prefixItems (tuple validation)`);
  if ("$ref" in schema) found.push(`${path}/$ref`);

  for (const [key, value] of Object.entries(schema)) {
    found.push(...unsupportedConstructs(value, `${path}/${key}`));
  }
  return found;
}

test("no tool schema uses a construct vLLM-backed gateways reject (issue #23)", async () => {
  const tools = await listToolSchemas();
  assert.ok(tools.length > 0, "no tool registered");

  const offenders = tools.flatMap(({ name, inputSchema }) => unsupportedConstructs(inputSchema, name));
  assert.deepEqual(offenders, [], `unsupported JSON-Schema constructs:\n${offenders.join("\n")}`);
});

test("no tool schema has oneOf/anyOf at the root (issue #23)", async () => {
  const tools = await listToolSchemas();
  for (const { name, inputSchema } of tools) {
    assert.ok(isObject(inputSchema), `${name}: inputSchema is not an object`);
    assert.ok(!("oneOf" in inputSchema), `${name}: root oneOf`);
    assert.ok(!("anyOf" in inputSchema), `${name}: root anyOf`);
  }
});

test("act_input.position still constrains an [x, y] pair of numbers", async () => {
  const tools = await listToolSchemas();
  const actInput = tools.find((t) => t.name === "act_input");
  assert.ok(actInput, "act_input tool not registered");
  const position = (actInput.inputSchema as { properties: Record<string, Record<string, unknown>> })
    .properties["position"];
  assert.equal(position["type"], "array");
  assert.deepEqual(position["items"], { type: "number" });
  assert.equal(position["minItems"], 2);
  assert.equal(position["maxItems"], 2);
});
