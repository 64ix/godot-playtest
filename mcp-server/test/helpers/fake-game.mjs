// Simulates a Godot game launched with `--playtest --bridge-port=0
// --bridge-port-file=<path>` (docs/protocol/DRAFT-v0.md §2): opens a
// loopback TCPServer, writes the OS-chosen port to the port-file after a
// configurable delay (env var FAKE_GAME_DELAY_MS), then responds to
// `hello` like the real Bridge. Used by test/unit/launch.test.ts to
// exercise `launchGame` without depending on Godot.
//
// Ticket #20 (stopGame): also simulates the response to the `quit` verb —
// by default responds then quits (real get_tree().quit()), like the real
// Bridge. FAKE_GAME_QUIT_MODE=ignore responds ok but never quits (exercises
// `stopGame`'s SIGKILL escalation). A SIGTERM handler that exits 0 acts as
// a tripwire: stopGame must never send SIGTERM (it crashes Godot .NET
// builds into an OS crash popup), so an escalation must end in SIGKILL,
// never in a clean exit via this handler.
import { createServer } from "node:net";
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const dashIdx = args.indexOf("--");
const userArgs = dashIdx === -1 ? [] : args.slice(dashIdx + 1);

function userArg(prefix) {
  const found = userArgs.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

const portFile = userArg("--bridge-port-file=");
const delayMs = Number(process.env.FAKE_GAME_DELAY_MS ?? "0");
const shouldExitEarly = process.env.FAKE_GAME_EXIT_EARLY === "1";
const quitMode = process.env.FAKE_GAME_QUIT_MODE ?? "clean"; // "clean" | "ignore"

if (shouldExitEarly) {
  process.exit(1);
}

const server = createServer((socket) => {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      const req = JSON.parse(line);
      if (req.cmd === "quit" && quitMode === "clean") {
        // Mimics bridge.gd: the response is written before the process
        // exits (real get_tree().quit()), never the other way around.
        socket.write(JSON.stringify({ id: req.id, ok: true }) + "\n", () => process.exit(0));
        continue;
      }
      const resp = { id: req.id, ok: true, protocol: 0, state_contract: 0, engine: "fake", capabilities: [] };
      // Environment probes (launchGame's `env` option): returned in the
      // response only if present, so launch.test.ts can verify the
      // `{...process.env, ...options.env}` merge without changing the shape
      // of the `hello` response seen by the other tests.
      if (process.env.FAKE_GAME_ENV_PROBE !== undefined) resp.env_probe = process.env.FAKE_GAME_ENV_PROBE;
      if (process.env.FAKE_GAME_ENV_PARENT !== undefined) resp.env_parent = process.env.FAKE_GAME_ENV_PARENT;
      socket.write(JSON.stringify(resp) + "\n");
    }
  });
});

server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  setTimeout(() => {
    if (portFile) writeFileSync(portFile, String(port));
  }, delayMs);
});

// Tripwire (see header): a stray SIGTERM from stopGame would surface as a
// clean exit(0) instead of the SIGKILL the escalation test asserts.
process.on("SIGTERM", () => process.exit(0));
