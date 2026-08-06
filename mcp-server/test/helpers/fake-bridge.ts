/**
 * Fake bridge for unit tests: a loopback TCP JSON-lines server that
 * responds to requests according to a configurable handler, without
 * depending on Godot. Lets us test the MCP tools <-> verbs translation and
 * `BridgeClient`'s behavior (id correlation, out-of-order, timeout) in
 * isolation (docs/protocol/DRAFT-v0.md §2).
 */
import { AddressInfo, createServer, Server, Socket } from "node:net";

export type FakeBridgeHandler = (
  req: Record<string, unknown>,
  respond: (resp: Record<string, unknown>) => void,
) => void;

export class FakeBridge {
  private server: Server;
  private sockets = new Set<Socket>();
  port = 0;

  constructor(private handler: FakeBridgeHandler) {
    this.server = createServer((socket) => this.onConnection(socket));
  }

  static async start(handler: FakeBridgeHandler): Promise<FakeBridge> {
    const bridge = new FakeBridge(handler);
    await bridge.listen();
    return bridge;
  }

  private listen(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(0, "127.0.0.1", () => {
        this.port = (this.server.address() as AddressInfo).port;
        resolve();
      });
    });
  }

  private onConnection(socket: Socket): void {
    this.sockets.add(socket);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        const req = JSON.parse(line);
        this.handler(req, (resp) => {
          if (!socket.destroyed) {
            socket.write(JSON.stringify(resp) + "\n");
          }
        });
      }
    });
    socket.on("close", () => this.sockets.delete(socket));
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

/** Default handler: mimics the base verbs (hello/query) and returns
 * `unknown_cmd` for the rest — enough for translation tests. */
export function defaultHandler(overrides: Partial<Record<string, FakeBridgeHandler>> = {}): FakeBridgeHandler {
  return (req, respond) => {
    const cmd = req["cmd"] as string;
    if (overrides[cmd]) {
      overrides[cmd]!(req, respond);
      return;
    }
    switch (cmd) {
      case "hello":
        respond({ id: req["id"], ok: true, protocol: 0, state_contract: 0, engine: "4.6.3-fake", capabilities: [] });
        return;
      default:
        respond({ id: req["id"], ok: false, error: "unknown_cmd", detail: `unknown cmd '${cmd}'` });
    }
  };
}
