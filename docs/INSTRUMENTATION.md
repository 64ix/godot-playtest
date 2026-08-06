# Instrumentation guide

> How to prepare **any** Godot game to be driven by
> godot-playtest — and to produce frozen tests that don't flake. Every
> pattern here is universal: it can be stated without naming a specific game or genre
> (that's the criterion of [ADR-0005](adr/0005-tool-test-bench-boundary.md)).
> The end-to-end worked example on a real third-party game lives in
> [`dogfooding/`](../dogfooding/INSTRUMENTATION.md).

## 1. Test-ids: what to tag (and what not to tag)

A `test_id` (meta `set_meta("test_id", "...")`) is the level-1 selector
(protocol §3): it survives scene refactors. Tag:

- Controls the player interacts with (buttons, fields, tabs);
- nodes whose state is authoritative for a test (the player, a resource
  display, a screen);
- *manager* nodes that can answer on behalf of an entire collection
  (see §3).

Do NOT tag elements of a generated collection (the 10,000 cells of a
grid, every projectile of a bullet-hell, every chunk of a procedural
world): a `query` snapshot without a selector would return all of them, and the
test-id adds nothing that a domain query (§3) wouldn't do better.

## 2. The state contract: `_test_state()` / `_TestState()` (C#)

The channel through which a game exposes its **domain** (HP, inventory,
game phase) without the tool guessing (protocol §5):

```gdscript
func _test_state() -> Dictionary:
    return {"health": health, "phase": phase_name}
```

```csharp
// Godot exposes C# methods under their PascalCase name: the Bridge tries
// both names (_test_state then _TestState) — same contract, same shape.
public Godot.Collections.Dictionary _TestState()
    => new() { { "health", _health }, { "phase", _phaseName } };
```

Golden rule: expose only what the game **already computes**. If a test
needs a value the game doesn't know, that's a sign the test is
recomputing the game — see §5.

## 3. Parameterized domain queries (large collections)

When the expected state isn't the property of any single node — "does
cell (3, 4) belong to the player?", "how many enemies are alive?" —
tag the **manager** and give it a pure read by arguments:

```gdscript
## On the manager node (test_id "world") — pure read, safe to call again
## every frame.
func cell_owner(x: int, y: int) -> String:
    return _cells[Vector2i(x, y)].owner_name
```

On the driving side: `act.invoke` for a one-shot read, `wait_for` in
`method` mode to wait for the value to become true (protocol §4):

```gdscript
await wait_for({"test_id": "world"}, {
    "method": "cell_owner", "args": [3, 4], "equals": "player_1",
})
```

The method MUST be a pure read: it is called again every frame.

## 4. Prefer a threshold boolean over a continuous value

A frozen test that asserts an exact continuous physical value (exact
position, angle, timing) is flaky by construction as soon as a `shuffle()`, a
physics frame, or float accumulation gets involved (dogfooding lesson,
[FRICTIONS #1](../dogfooding/FRICTIONS.md)). Expose the **judgment**
rather than the measurement:

```gdscript
func _test_state() -> Dictionary:
    # has_moved: stable judgment; position: debug information.
    return {"has_moved": distance_from_spawn > 2.0, "position": global_position}
```

## 5. Telemetry: expose what the game already computes

When a test's condition depends on an internal game computation (aiming,
targeting, line of sight, pathfinding), never recompute the geometry on
the test side: expose the **result** of the computation in
`_test_state()` and let the test read it (dogfooding lesson,
[FRICTIONS #2](../dogfooding/FRICTIONS.md) and issue #17 —
`aim_target_test_id`). The test stages the scene, the game judges.

## 6. Domain time: network and server-authoritative games

`time.scale` only acts on `Engine.time_scale` of the driven process. In a
game whose meaningful time lives server-side (production, cooldowns,
ticks), it accelerates **nothing** — a test relying on it waits for a
state that will never arrive any faster. The pattern, symmetric to
`_test_state()`: the game exposes its own domain **accelerator** (a debug
method that asks the backend to advance time), drivable via `act.invoke`
on a tagged node — then `wait_for` does what it always does (wait for the
replicated state to arrive, no sleep). Same caveat for `time.step_until`
(ticket #37): stepping the local engine's frames faster does not make a
remote authority tick faster — it only bounds how long the driven process
polls its own domain accelerator before giving up.

Same family: pointing the game at an **ephemeral test backend** goes
through the `env` option of `launch_game` (merged environment variables),
not through ever-longer arguments — and for a frozen test, through the
script that launches the runner.

## 7. Semantic Controls: staying `act.press`-able

`act.press` activates a Control via its `pressed` signal — never
hit-testing, so it works in `--headless` (protocol §6). Design
consequence: a hand-drawn custom menu whose clickable zones are purely
positional hit-testing is only actionable windowed (`act.input` type
`click`), so never in CI. Giving each interactive element a real Control
(or at minimum a `pressed` signal emitted by the menu's logic) keeps it
CI-safe by construction.

## 8. Multi-client harnesses: launching further instances for `attach_instance`

For a networked, server-authoritative game, the most valuable assertions are
between two **connected clients** — B's action becoming visible to A,
staying invisible when A is outside the relevancy set, and so on. A frozen
test drives instance 0 in-process exactly as every other frozen test
(`start_game()`/`self`), and each further instance through a **handle**
returned by `attach_instance("name")` — a client of an already-running
process. The addon never launches or relaunches that process: **the game's
own harness owns launching every extra instance**, the same boundary that
already keeps process supervision, provisioning, and orchestration out of
the tool (ADR-0005).

The contract between the harness and `attach_instance` is one environment
variable:

- `PLAYTEST_ATTACH_PORTS` points at a directory of per-instance port-files —
  filename = instance name, content = the same port-file format
  `--bridge-port-file` already writes (a single ASCII integer). Each
  instance the harness launches writes its own file under this directory
  (e.g. `--bridge-port=0 --bridge-port-file=$PLAYTEST_ATTACH_PORTS/b`); no
  aggregation step exists on either side.
- `attach_instance(name)` reads `$PLAYTEST_ATTACH_PORTS/<name>`, polls it
  with the same retry discipline `launch_game` uses for its own port-file,
  connects, and returns the handle.

The harness's launch is a **hard requirement**, not a suggestion: one
supervised process group, a wall-clock timeout, signal escalation if a
child refuses to exit — the addon's own contribution is limited to its own
suite budget (`PLAYTEST_SUITE_TIMEOUT_SECONDS`, ADR-0009) and a best-effort
`quit` sent to whatever it connected to, once, at the very end of the whole
suite invocation; it never signals a process it didn't launch, and it never
retries a launch that never happened.

Two gotchas worth stating up front, both consequences of the topology
rather than of any single game:

- **`time_scale`/`time.frames` on instance 0 also scale this runner's own
  process** — the local frame budget you're already used to, unaffected by
  any further instance (a separate OS process each, immune by construction).
  There is no synchronized cross-instance step, ever: an unaddressed
  instance drifts by design, which is exactly why an assertion that
  compares two instances is always eventually-based with a budget, never a
  lockstep tick.
- **An attached instance's state persists across `test_*` methods within
  the same suite invocation** — its process is launched once by the
  harness for the life of the whole run, not once per test, so a value one
  test leaves behind is still there for the next one. The remedy is the
  same accelerator idiom as §6: expose a debug method (callable via
  `invoke`) that resets whatever domain state a scenario needs to start
  clean, rather than relying on a fresh process per test.
