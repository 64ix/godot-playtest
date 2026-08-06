#!/usr/bin/env node
import { runStdioServer } from "./server.js";

runStdioServer().catch((err) => {
  console.error("[godot-playtest-mcp] fatal:", err);
  process.exit(1);
});
