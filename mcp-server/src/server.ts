/**
 * Construction of the godot-playtest MCP server (ticket #12): an
 * `McpServer` from the official SDK, its tools 1:1 with the Bridge's
 * verbs, and a `Session` that keeps the TCP connection alive.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools.js";
import { Session } from "./session.js";

export function createServer(): { server: McpServer; session: Session } {
  const server = new McpServer({
    name: "godot-playtest-mcp",
    version: "0.1.0",
  });
  const session = new Session();
  registerTools(server, session);
  return { server, session };
}

export async function runStdioServer(): Promise<void> {
  const { server, session } = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const shutdown = () => {
    session.disconnect();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
