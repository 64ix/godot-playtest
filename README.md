# godot-playtest

`godot-playtest` lets an AI agent play a running Godot game through a local
Bridge, verify its behavior, and freeze the verified session into a
deterministic GDScript test. Frozen tests run natively in headless CI without
the agent, MCP server, editor, or Bridge.

> Status: v0. The addon, MCP server, and freeze workflow are implemented and
> tested. The first npm release and Godot Asset Library submission are still
> pending; see [the release guide](docs/RELEASE.md).

## Quickstart

### 1. Configure the MCP server

Once the npm package is published, add this to your MCP client configuration:

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

For local development and client-specific examples, see
[mcp-server/README.md](mcp-server/README.md).

### 2. Install the addon

Copy [addons/playtest/](addons/playtest/) into
`res://addons/playtest/`, then enable **Playtest** under
**Project Settings > Plugins**. The Asset Library installation path will be
available after the first addon release.

### 3. Play and verify

With the MCP server connected:

1. Call `launch_game` with the Godot binary and project path.
2. Call `hello` to verify protocol compatibility.
3. Use `query` to inspect testable nodes.
4. Drive the game with `act_press`, `act_input`, or `act_invoke`.
5. Synchronize with `wait_for` and add state assertions with
   `assert_now_property` or `assert_eventually_property`.

### 4. Freeze and replay

Call `freeze_scenario` to write a replayable test under `res://playtests/`.
Run frozen tests without AI:

```sh
godot --headless --path <project> \
  res://addons/playtest/runner.tscn -- --suite=res://playtests/
```

## How it works

- The Godot addon exposes a loopback JSON-lines Bridge for scene queries,
  actions, waits, time control, assertions, and screenshots.
- The TypeScript MCP server maps tools to that Bridge and records the verified
  scenario trace.
- `freeze_scenario` rechecks selectors against the live game and generates an
  idiomatic `PlaytestCase` script.
- The addon runner replays generated tests directly inside Godot in headless
  mode. Screenshots are diagnostic only; state assertions determine the test
  result.

The Bridge is dormant unless explicitly activated, binds to loopback, and
ships with an export guard. See [the addon documentation](addons/playtest/README.md)
for the activation and export rules.

## Documentation

- [Addon and frozen-test API](addons/playtest/README.md)
- [MCP server, tools, and local setup](mcp-server/README.md)
- [Game instrumentation guide](docs/INSTRUMENTATION.md)
- [Protocol draft](docs/protocol/DRAFT-v0.md)
- [Release process](docs/RELEASE.md)
- [TPS demo dogfooding example](dogfooding/)

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for prerequisites, test commands, and
pull-request expectations. Security reports should follow
[SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
