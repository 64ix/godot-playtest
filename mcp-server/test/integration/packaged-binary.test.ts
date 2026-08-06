/**
 * Smoke test for the *packaged* binary entrypoint (spec #32, criterion #4):
 * proves that what a user gets from `npx godot-playtest-mcp` — the packed
 * tarball's `bin`, not the TypeScript source tree — actually launches a real
 * game and completes a `hello` handshake plus one `query`.
 *
 * `npm pack` builds the tarball exactly as `npm publish` would (respects
 * `files`, runs the `prepack` lifecycle script). Installing that tarball
 * into a scratch directory with `npm install` reproduces what a user's
 * `npx`/`npm install` does, including npm's executable-bit fixup on the
 * `bin` symlink target — this is exactly the gap flagged by the spec
 * (tsc does not preserve the execute bit, only the shebang line). The test
 * then spawns the *resolved* bin directly (relying on its shebang and mode
 * bits), never `node dist/index.js` from the source tree — a test that fell
 * back to the source tree would defeat this criterion.
 *
 * Fails (never skips) if GODOT_BIN is not set (spec #55, same convention as
 * fixture.test.ts).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { requireGodotBin } from "./require-godot-bin.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MCP_SERVER_DIR = join(__dirname, "..", "..");
const PROJECT_ROOT = join(MCP_SERVER_DIR, "..");

/** Packs the mcp-server package (as `npm publish` would) and installs the
 * resulting tarball into a fresh scratch directory (as a user's `npm
 * install`/`npx` would) — no shortcut through the source tree. */
function packAndInstall(): { binPath: string; workDir: string } {
  const workDir = mkdtempSync(join(tmpdir(), "godot-playtest-mcp-pack-"));
  const packDestination = join(workDir, "tarball");
  mkdirSync(packDestination);

  const packOutput = execFileSync("npm", ["pack", "--json", "--pack-destination", packDestination], {
    cwd: MCP_SERVER_DIR,
    encoding: "utf-8",
  });
  const [{ filename }] = JSON.parse(packOutput) as Array<{ filename: string }>;
  const tarballPath = join(packDestination, filename);
  assert.ok(existsSync(tarballPath), `npm pack did not produce ${tarballPath}`);

  const installDir = join(workDir, "install");
  mkdirSync(installDir);
  execFileSync("npm", ["install", "--no-audit", "--no-fund", tarballPath], {
    cwd: installDir,
    encoding: "utf-8",
  });

  const binPath = join(installDir, "node_modules", ".bin", "godot-playtest-mcp");
  assert.ok(existsSync(binPath), "npm install did not link the godot-playtest-mcp bin");

  // Criterion #4 / maintainer note: verify the emitted dist/index.js is
  // actually executable as a bin once installed — shebang preserved, mode
  // bits set — not merely importable as TS/JS source.
  const resolvedBin = realpathSync(binPath);
  const firstLine = readFileSync(resolvedBin, "utf-8").split("\n")[0];
  assert.equal(firstLine, "#!/usr/bin/env node", "packaged dist/index.js lost its shebang");
  const mode = statSync(resolvedBin).mode;
  assert.ok(mode & 0o111, "packaged dist/index.js is not executable (mode bits lost in the tarball/install)");

  // Maintainer decision (spec #32): MIT license must actually be present in
  // the published tarball, not merely at the repo root — the "prepack"
  // script (scripts/copy-license.mjs) copies it in before packing.
  const installedLicense = join(installDir, "node_modules", "godot-playtest-mcp", "LICENSE");
  assert.ok(existsSync(installedLicense), "installed package is missing LICENSE — prepack did not copy it into the tarball");
  const licenseText = readFileSync(installedLicense, "utf-8");
  assert.match(licenseText, /^MIT License/, "installed LICENSE is not the expected MIT license text");

  return { binPath, workDir };
}

function parseResultText(result: { content?: unknown }): Record<string, unknown> {
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0].text);
}

test(
  "the packaged bin (npm pack + install, as npx would fetch it) launches the witness_game fixture and completes hello/query",
  async () => {
    const GODOT_BIN = requireGodotBin();
    const { binPath, workDir } = packAndInstall();
    const transport = new StdioClientTransport({ command: binPath, args: [] });
    const client = new Client({ name: "packaged-binary-smoke-test", version: "0.0.0" });
    let quitDone = false;

    try {
      await client.connect(transport);

      const launch = await client.callTool({
        name: "launch_game",
        arguments: { command: GODOT_BIN, args: ["--path", PROJECT_ROOT, "--headless"] },
      });
      assert.ok(!launch.isError, `launch_game failed: ${JSON.stringify(launch.content)}`);

      const helloResult = await client.callTool({ name: "hello", arguments: {} });
      assert.ok(!helloResult.isError, `hello failed: ${JSON.stringify(helloResult.content)}`);
      const hello = parseResultText(helloResult);
      assert.equal(hello["ok"], true);
      assert.equal(hello["protocol"], 0);

      const queryResult = await client.callTool({
        name: "query",
        arguments: { test_id: "score_label" },
      });
      assert.ok(!queryResult.isError, `query failed: ${JSON.stringify(queryResult.content)}`);
      const query = parseResultText(queryResult);
      assert.equal(query["ok"], true);
      const nodes = query["nodes"] as Array<Record<string, unknown>>;
      assert.equal(nodes[0]["text"], "0");

      const quit = await client.callTool({ name: "quit_game", arguments: {} });
      assert.ok(!quit.isError, `quit_game failed: ${JSON.stringify(quit.content)}`);
      quitDone = true;
    } finally {
      // On a failing run the game is still up, and closing the client is not
      // enough to stop it: the server's SIGTERM handler only calls
      // `session.disconnect()`, which deliberately leaves a process launched
      // by `launch_game` alive (src/session.ts). Without this the headless
      // Godot would be orphaned and keep running the witness game forever.
      if (!quitDone) {
        try {
          await client.callTool({ name: "quit_game", arguments: {} }, undefined, { timeout: 10_000 });
        } catch {
          /* never launched, already gone, or unresponsive — nothing left to stop */
        }
      }
      await client.close();
      rmSync(workDir, { recursive: true, force: true });
    }
  },
);
