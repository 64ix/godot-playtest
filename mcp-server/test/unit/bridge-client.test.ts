import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { BridgeClient, BridgeConnectionError, BridgeTimeoutError } from "../../src/bridge-client.js";
import { defaultHandler, FakeBridge } from "../helpers/fake-bridge.js";

let bridge: FakeBridge;
let clients: BridgeClient[] = [];

async function connect(handler = defaultHandler()): Promise<BridgeClient> {
  bridge = await FakeBridge.start(handler);
  const client = await BridgeClient.connect(bridge.port);
  clients.push(client);
  return client;
}

afterEach(async () => {
  for (const c of clients) c.close();
  clients = [];
  if (bridge) await bridge.stop();
});

test("send/recv round-trip carries the same correlation id", async () => {
  const client = await connect();
  const resp = await client.send("hello", {});
  assert.equal(resp["ok"], true);
  assert.equal(resp["protocol"], 0);
});

test("out-of-order responses are correlated by id, not arrival order", async () => {
  // The second cmd responds first (setImmediate), the first responds after:
  // BridgeClient must resolve each promise with the right response despite
  // the reordering (docs/protocol/DRAFT-v0.md §1).
  const client = await connect((req, respond) => {
    const cmd = req["cmd"];
    if (cmd === "slow") {
      setTimeout(() => respond({ id: req["id"], ok: true, marker: "slow" }), 30);
    } else {
      setImmediate(() => respond({ id: req["id"], ok: true, marker: "fast" }));
    }
  });

  const slow = client.send("slow", {});
  const fast = client.send("fast", {});
  const [slowResp, fastResp] = await Promise.all([slow, fast]);
  assert.equal(slowResp["marker"], "slow");
  assert.equal(fastResp["marker"], "fast");
});

test("id counter is monotonic across the connection", async () => {
  const seen: number[] = [];
  const client = await connect((req, respond) => {
    seen.push(req["id"] as number);
    respond({ id: req["id"], ok: true });
  });
  await client.send("a", {});
  await client.send("b", {});
  await client.send("c", {});
  assert.deepEqual(seen, [1, 2, 3]);
});

test("client-side timeout rejects when the bridge never responds", async () => {
  const client = await connect((_req, _respond) => {
    /* never responds */
  });
  await assert.rejects(() => client.send("hello", {}, 50), BridgeTimeoutError);
});

test("connection closing rejects in-flight requests", async () => {
  bridge = await FakeBridge.start(() => {
    /* never responds, we're about to cut the connection */
  });
  const client = await BridgeClient.connect(bridge.port);
  clients.push(client);
  const pending = client.send("hello", {}, 5_000);
  await bridge.stop();
  await assert.rejects(pending, BridgeConnectionError);
});

test("connect rejects with BridgeConnectionError when nothing listens", async () => {
  await assert.rejects(
    () => BridgeClient.connect(1, { retries: 1, retryDelayMs: 1 }),
    BridgeConnectionError,
  );
});

test("wait_for timeout_ms grants a client-side margin instead of racing the bridge", async () => {
  const client = await connect((req, respond) => {
    // The Bridge responds just before its own deadline (timeout_ms=50): the
    // client must not time out before it does.
    setTimeout(() => respond({ id: req["id"], ok: false, error: "timeout", detail: "..." }), 45);
  });
  const resp = await client.send("wait_for", { test_id: "x", timeout_ms: 50 });
  assert.equal(resp["ok"], false);
  assert.equal(resp["error"], "timeout");
});

test("time.step_until's optional timeout_ms grants the same client-side margin as wait_for", async () => {
  const client = await connect((req, respond) => {
    setTimeout(() => respond({ id: req["id"], ok: false, error: "timeout", detail: "...", frames: 3 }), 45);
  });
  const resp = await client.send("time.step_until", { test_id: "x", timeout_ms: 50 });
  assert.equal(resp["ok"], false);
  assert.equal(resp["error"], "timeout");
});

test("time.step_until without timeout_ms falls back to the default client-side timeout (no ms ceiling to extend)", async () => {
  const client = await connect((_req, _respond) => {
    /* never responds: no timeout_ms was given, so the default 10s window applies */
  });
  await assert.rejects(() => client.send("time.step_until", { test_id: "x", max_frames: 30 }, 50), BridgeTimeoutError);
});
