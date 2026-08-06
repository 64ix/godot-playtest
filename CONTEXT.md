# godot-playtest

Open-source playtest QA for Godot games. An AI agent drives the running game
through a local Bridge, verifies behavior, and freezes the verified Scenario
into a deterministic test that replays without AI.

## Language

**Addon**
The installable Godot package containing the Bridge and frozen-test runner.

**Bridge**
The in-game `TestBridge` autoload that exposes state reads, actions, waits,
assertions, screenshots, and time control to an external driver.

**MCP server**
The TypeScript MCP surface through which an agent drives one or more Bridge
connections.

**Scenario**
An exploratory, agent-driven game session that has not yet been hardened.

**Trace**
The replayable actions, synchronization steps, and successful assertions kept
by the MCP server during a Scenario. Reads and raw logs are not part of it.

**Freeze**
The act of rechecking a Scenario's selectors and generating a Frozen test from
its Trace.

**Frozen test**
A deterministic GDScript test that runs without an agent, MCP server, editor,
or Bridge, locally or in CI.
_Avoid_: frozen scenario

**Condition**
The full wait specification passed to `wait_for` / `time_step_until`: the
Selector plus the mode and comparison (`property`/`equals`, `signal`,
`method`/`args`/`equals`). Timeout messages and heartbeat lines name the
Condition, never just the Selector.

**Selector**
The node-locating part of a Condition (`test_id`, …), and the parameter the
read/action verbs address nodes by.
_Avoid_: locator, node path

**Demo game**
An open-source game used to exercise the tool end to end. The current demo is
Godot's official TPS demo (ADR-0003).

**State-first oracle**
A verdict based on game state (nodes, signals, or domain state). Screenshots
are diagnostic supplements, never pixel-diff verdicts.

## Compass

- Freeze produces reliable, state-first tests from verified live sessions.
- Frozen tests replay natively in headless Godot with no external runtime.
- The protocol is documented separately from its implementations.
- The Bridge targets the running game; editor automation is out of scope.
- Game-specific orchestration and domain semantics stay in the game repository.
- Fun, balancing, and non-Godot engines are out of scope.
