# godot-playtest-mcp

MCP server (TypeScript, official MCP SDK `@modelcontextprotocol/sdk`): a thin
proxy to the godot-playtest addon's Bridge (spec #7). All protocol semantics
live in the Bridge — this server translates MCP tools into JSON-lines verbs
(docs/protocol/DRAFT-v0.md) and returns the responses as-is, error diagnostics
included.

Packaged for npm as `godot-playtest-mcp` (spec #32) — see
[docs/RELEASE.md](../docs/RELEASE.md) for the release process (a tag-triggered
CI job publishes it; the first actual publish is a maintainer action) and the
version relationship between this package and the `addons/playtest` addon
(the `hello` protocol version is the compatibility anchor, not either
package's own version number).

## MCP config — Claude Code (ready to paste)

No clone, no build — `npx` always resolves the latest published version:

```json
{
  "mcpServers": {
    "godot-playtest": {
      "command": "npx",
      "args": ["-y", "godot-playtest-mcp"]
    }
  }
}
```

## MCP config — other clients

Same command, different config file/location.

**Cursor** (`.cursor/mcp.json` or global `~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "godot-playtest": {
      "command": "npx",
      "args": ["-y", "godot-playtest-mcp"]
    }
  }
}
```

**Windsurf** (`~/.codeium/windsurf/mcp_config.json`):

```json
{
  "mcpServers": {
    "godot-playtest": {
      "command": "npx",
      "args": ["-y", "godot-playtest-mcp"]
    }
  }
}
```

## Contributor note: running from a local clone

Working on the server itself (this repo, not the published package)? Build
and point at `dist/index.js` directly instead of `npx`:

```sh
cd mcp-server
npm install
npm run build
```

```json
{
  "mcpServers": {
    "godot-playtest": {
      "command": "node",
      "args": ["/absolute/path/to/godot-playtest/mcp-server/dist/index.js"]
    }
  }
}
```

## Typical manual session (once connected)

1. `launch_game` — launches the Godot binary with the target project:
   ```json
   {"command": "/path/to/godot", "args": ["--path", "/path/to/project", "--headless"]}
   ```
   (omit `--headless` for a local windowed session). The tool automatically
   appends `--playtest --bridge-port=0 --bridge-port-file=<tmp>`, waits for
   the port-file, then connects (retry). `env` option: additional
   environment variables for the game process, merged on top of the
   server's own — the standard channel to point the game at an ephemeral
   test backend (see docs/INSTRUMENTATION.md "Domain time and test
   backends").
2. `hello` — checks `protocol`/`capabilities` before any command (§2).
3. `query` — explores the scene tree (no selector = all test-ids).
4. `act_press` / `act_input` / `act_invoke` — acts.
5. `wait_for` — waits for a condition without ever sleeping on the agent
   side: node appearance, `property`+`equals`, `signal`, or `method`+`args`+
   `equals` (a parameterized domain query — a pure read re-invoked every
   frame, for computed state that isn't any node's property).
6. `assert_now_property` / `assert_eventually_property` — asserts on game
   state, right now (one-shot) or retry-until-timeout like `wait_for`; if it
   holds, it joins the session trace.
7. `freeze_scenario` — freezes the trace (verbs + assertions) into a frozen
   `PlaytestCase` test, written to `res://playtests/` of the target project
   (ticket #13).
8. `quit_game` — clean shutdown at the end of a session (ticket #20): sends
   the `quit` verb (the game closes itself), then SIGKILL as a last resort
   if the process doesn't exit within the grace period — never SIGTERM,
   which crashes Godot .NET builds into an OS crash popup (see `stopGame`,
   `src/launch.ts`). Preferred over an external process kill (a direct
   `kill` dirties the tail of the logs).

Or, to attach to an already-running game (known port): `attach` with `{"port": N}`.

## Tools (1:1 with the protocol verbs, docs/protocol/DRAFT-v0.md §4)

| MCP tool | Bridge verb | Notes |
|---|---|---|
| `hello` | `hello` | handshake, call first |
| `query` | `query` | optional selector |
| `act_press` | `act.press` | semantic activation (headless-safe) |
| `act_input` | `act.input` | `type`: `action`\|`key`\|`click` (`click` = capability `windowed`) |
| `act_invoke` | `act.invoke` | reflection, the accepted escape hatch |
| `wait_for` | `wait_for` | asynchronous on the Bridge side, never an agent-side sleep; modes `property`/`signal`/`method` (parameterized domain query) |
| `time_scale` | `time.scale` | fast-forward |
| `time_frames` | `time.frames` | fine-grained synchronization |
| `time_step_until` | `time.step_until` | deterministic advance-until-condition, frame-budgeted (ticket #37, ADR-0007); same condition vocabulary as `wait_for` minus `signal`; on a named instance, frozen as `await <handle>.time_step_until(...)` (`PlaytestClient`, spec #66) |
| `screenshot` | `screenshot` | best effort, never an oracle; `no_renderer` in headless |
| `launch_game` | — | spawn (`env` option merged on top of the environment) + port-file + connection retry |
| `attach` | — | connect to an already-listening Bridge |
| `assert_eventually_property` | `wait_for` (under the hood) | asserts a condition, retry-until-timeout; if it holds, recorded in the session trace (ticket #13) |
| `assert_now_property` | `wait_for` with `timeout_ms: 0` (under the hood) | asserts a condition right now, no retry; if it holds, recorded in the session trace (ticket #35) |
| `freeze_scenario` | — | freezes the trace into a frozen `PlaytestCase` test in `res://playtests/` (ticket #13) |
| `quit_game` | `quit` | clean game shutdown; SIGKILL as a last resort (ticket #20), closes the session |

Bridge errors (`not_found`, `ambiguous`, `timeout`, `no_renderer`,
`no_display`, ...) are returned as-is in the tool content (with
`isError: true`), diagnostics (`suggestions`, `candidates`) included — never
swallowed.

All "verb" tools accept an optional `client_timeout_ms` parameter: the
client-side timeout for waiting on the Bridge's response (default 10000ms,
`wait_for`/`assert_eventually_property`: `timeout_ms` + 2000ms margin).
Increase it in a
**windowed** session, where shader compilation on first render can freeze the
game's main thread beyond the default (`dogfooding/FRICTIONS.md` #7). Purely
client-side: never forwarded to the Bridge, never recorded in the session
trace (so never frozen by `freeze_scenario`).

### Multiple connected clients (spec #66)

Every tool in the table above also accepts an optional `instance` field
(default `"default"`, instance 0) — the session holds a **named map** of
Bridge connections, not just one. `launch_game`/`attach` mint or replace a
connection named by their own `instance` field: **add-not-replace**, only
that instance's own slot is closed and reopened, every other connected
instance is left untouched (the one deliberate contract change from before
this spec — every call that omits `instance` keeps today's exact behavior
end to end). A bare `quit_game` (no `instance`) closes only `"default"`;
there is no quit-all. Calling a tool with an instance that isn't connected
returns a `NotConnectedError` naming it. `freeze_scenario` freezes every
instance the trace mentions: the generated test hoists one
`attach_instance("name")` declaration per non-default instance (first
appearance order) right after `start_game()`, then a handle call per
addressed verb (`b.press(...)`) — see docs/adr/0008 for the topology
rationale and [addons/playtest/README.md § Multi-client frozen
tests](../addons/playtest/README.md#multi-client-frozen-tests-spec-66) for
the GDScript surface this replays against.

## Freeze (ticket #13)

The MCP server keeps a **session trace** (`src/trace.ts`): every verb that
acts or synchronizes time (`act.press`, `act.input`, `act.invoke`,
`wait_for`, `time.scale`, `time.frames`, `time.step_until`) is automatically
recorded there (`Session.call`); `query`/`hello`/`launch_game`/`attach` are
deliberately excluded (reads or session mechanics, not scenario steps —
freezing a `query` dump wouldn't be idiomatic). `assert_now_property`/
`assert_eventually_property` adds an assertion, tagged with the mode it was
set under (`now`/`eventually`), but only if it holds — freezing a failure
would produce a stillborn test.

`freeze_scenario`:
1. **Re-checks every unique selector in the trace against the live game**
   (`wait_for` "plain" mode, no side effect) — a selector that no longer
   resolves refuses the freeze with the Bridge's rich diagnostic, never a
   silently broken generated test (the Playwright test-agents pattern).
2. **Generates an idiomatic GDScript script** (`src/freeze.ts`
   `generateFrozenScript`): an `extends PlaytestCase` with
   `start_game(scene_path)` then one line per trace step (`press`, `invoke`,
   `wait_for`, `time_scale`/`time_frames`, `time_step_until` (ticket #39,
   emitted as a bare `await` statement — its `{"node", "frames"}` return
   value, ticket #38, has no use in a frozen test any more than `wait_for`'s
   resolved node does), `assert_now_property`/`assert_eventually_property`
   depending on the entry's mode) — never a log dump.
3. **Refuses a non-CI-safe scenario** (`screenshot`, `act.input` type
   `click` — matrix §6) unless `windowed: true` is passed explicitly: the
   generated script then carries `const PLAYTEST_WINDOWED := true`, which the
   addon's runner (`runner.gd`) detects to skip the test in `--headless`
   rather than letting it fail on `no_display`.

`npm run generate:golden-freeze` (requires `GODOT_BIN`) regenerates the
golden path frozen tests under `playtests/generated/`
(`generated_score_button_increments.gd`, plus
`generated_step_until_advances_deterministically.gd` for ticket #39's
`time.step_until` round-trip) by exploring `fixtures/witness_game`
programmatically — the golden path proof for criterion #13, replayed by the
headless runner like any other file under `res://playtests/` (thus included
in the existing `golden-path-x20` job with no extra CI needed).

## Clean game shutdown (ticket #20)

`disconnect()` (internal to `Session`, used by `attach`/`launch_game` before
replacing the current connection) **never** kills the process — the agent
may want to leave it running. To explicitly end a session, use the
`quit_game` tool: it sends the protocol's `quit` verb (the Bridge responds
then calls `get_tree().quit()`, DRAFT-v0.md §4), waits for the process to
exit naturally if it was launched by `launch_game`, then SIGKILL as a last
resort if the grace period expires (`stopGame`, `src/launch.ts`). The
escalation deliberately skips SIGTERM: the .NET runtime of Godot mono
builds intercepts it and aborts (SIGABRT), i.e. a "quit unexpectedly"
OS-side notification (macOS) plus engine error lines at the end of the
log — the very noise signal documented in `dogfooding/FRICTIONS.md` #4
that this clean shutdown path eliminates on the nominal run. SIGKILL
bypasses signal handlers and leaves no crash report.

## Code layout

| File | Role |
|---|---|
| `src/bridge-client.ts` | Loopback TCP JSON-lines client: correlation by `id`, handles out-of-order responses (`wait_for`), client-side timeout. |
| `src/launch.ts` | `launch_game`: spawn, port-file, connection retry; `stopGame`: clean shutdown of the launched process (ticket #20). |
| `src/session.ts` | Session state — a named map of Bridge connections (spec #66), `launch`/`attach`/`disconnect`/`quitGame` (add-not-replace per named slot), session trace (ticket #13/#20). |
| `src/instance-name.ts` | Instance-name validation for `launch_game`/`attach`'s `instance` field (spec #66) — mirrors `addons/playtest/instance_name.gd`. |
| `src/trace.ts` | Session trace types (replayable verbs + assertions), each tagged with the instance it addressed (spec #66), and their helpers (ticket #13). |
| `src/freeze.ts` | `freeze_scenario`: live selector re-verification + frozen GDScript script generation (ticket #13). |
| `src/tools.ts` | MCP tool declarations, 1:1 with the verbs — thin proxy, zero game semantics; plus `assert_now_property`/`assert_eventually_property`/`freeze_scenario`/`quit_game`. |
| `src/server.ts` | Builds the `McpServer`, wires up stdio. |
| `src/index.ts` | Executable entry point (`bin`). |

## Tests

- `npm test` — unit tests against a fake Bridge (`test/helpers/fake-bridge.ts`,
  a minimal JSON-lines TCP server): tools ⇄ verbs translation (via the real
  MCP path `Client` → `InMemoryTransport` → `McpServer`), correlation by id
  and out-of-order cases, timeout, port-file/retry (`test/helpers/fake-game.mjs`
  simulates a game booting).
- `npm run test:integration` — actually launches `fixtures/witness_game` in
  `--headless` via `launch_game` and exercises `query`/`act.press`/`wait_for` +
  errors (`not_found`, `no_renderer`) against the real Bridge. Requires
  `GODOT_BIN` (path to the Godot binary): a missing `GODOT_BIN` fails the
  suite rather than skipping it (each integration test calls the shared
  `test/integration/require-godot-bin.ts` first thing, naming the missing
  variable) — no-Godot path is `npm test` (unit tests against the fake
  Bridge), not a silent skip. Wired in CI:
  [`.github/workflows/mcp-server.yml`](../.github/workflows/mcp-server.yml).
