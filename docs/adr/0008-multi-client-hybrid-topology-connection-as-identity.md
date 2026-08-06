# Multi-client frozen tests: connection as identity

Networked games need assertions between independently connected clients. A
single process cannot represent those clients because Godot autoloads are
process singletons.

The chosen topology is hybrid:

- instance 0 remains the in-process game mounted by `start_game()` and driven
  through `self`;
- each additional instance is a named `PlaytestClient` handle attached to a
  process launched by the game's own harness.

The addon attaches to additional processes but never launches or relaunches
them. Process supervision, backend provisioning, and wall-clock policy remain
the game harness's responsibility under ADR-0005.

## Why not a uniform network topology?

Driving instance 0 over a socket whenever a second client is added would
silently change the meaning of every existing `self.press`, `query_one`, and
assertion call in that file. The hybrid topology keeps locality explicit:
`self` is in-process, while `b.press(...)` visibly addresses a named remote
connection.

Freeze records the connection name, not a process handle or launch method.
Matching live-session and replay names is therefore an out-of-band contract
with the game harness.

The Bridge wire protocol remains single-connection and unchanged. The instance
dimension exists only in the MCP server's connection map and the GDScript
driver handles.

## Considered options

- **Uniform network topology** — viable, but rejected because it changes the
  meaning of existing `self` calls based on unrelated file contents.
- **Shared in-process arena** — rejected because autoload singletons cannot
  represent independently connected clients.
- **Addon-managed process launch** — rejected because it crosses the tool/game
  boundary and duplicates the MCP server's launch supervision.
