# Frictions encountered (dogfooding TPS demo, issue #14)

Meant to become follow-up issues (the orchestrator opens them from this
file — no GitHub issue is created directly here).

## 1. Player spawn determinism — `player_spawn_points.shuffle()`

`level.gd add_player()` randomly shuffles the player spawn points on every
run (`randomize()` in `main.gd _ready()` + `.shuffle()`). Result: the
player's absolute position on load is **never** the same from one run to
another — a frozen test asserting an exact position would be flaky by
construction. Workaround used here: expose a domain boolean (`has_moved`,
distance-traveled threshold) rather than the absolute position. **Proposed
follow-up**: the godot-playtest protocol could document this pattern more
explicitly (`prefer a threshold boolean over a continuous, non-reproducible
physical value`) in the instrumentation guide, instead of rediscovering it
project by project.

## 2. 3D / aiming selectors — the player's real shot is hard to harden headless

The player's shot (`player.gd`, `aiming` branch) starts from a camera
raycast through the exact center of the screen (`crosshair.position +
crosshair.size * 0.5`) into the 3D world. For a frozen test to simulate a
shot that actually hits an enemy, the player would need to be positioned and
its camera oriented with sub-degree precision relative to the target —
feasible, but with a calibration budget (exact transforms, raycast error
margin) beyond the scope of this ticket. Workaround used: direct
`act.invoke` on `red_robot.gd hit()` (see `INSTRUMENTATION.md`) — tests the
domain (dying after N hits) without depending on aiming geometry. **Proposed
follow-up**: if a future frozen test wants to cover the real shot, consider
an "aiming telemetry" mode on the Bridge side (e.g. expose the
camera→target angle computed by the game itself via `_test_state()`)
instead of recomputing trigonometry in the test script.

**Resolved (issue #17)**: `player.gd` now exposes `aim_target_test_id`/
`aim_target_position` (aiming telemetry, see the dedicated section in
`INSTRUMENTATION.md`) and
[`playtests/tps_demo_player_aims_and_shoots_a_robot.gd`](playtests/tps_demo_player_aims_and_shoots_a_robot.gd)
covers a real shot that hits, 20/20 green headless — without recomputing
any trigonometry in the test (just a fixed camera-rotation budget, read via
telemetry).

## 3. `act.invoke` on an `@rpc("call_local")` method with an internal `await`

`red_robot.gd hit()` is annotated `@rpc("call_local")` and contains an
`await get_tree().create_timer(10.0).timeout` in the "death" branch
(`health == 0`). When called directly via `node.callv(method, args)` (what
`act.invoke` does, outside the RPC registry), it does start correctly, but
since it is compiled as a coroutine by GDScript, the immediate return value
is a `GDScriptFunctionState` — serialized by `variant_json.gd` as
`{"$gd": "str", "v": "Object(GDScriptFunctionState,...)"}"` rather than a
useful value. Harmless here (the trace never relies on this return value,
only on `assert_property` afterward), but surprising during exploration
(raw `query`/`act.invoke`). **Proposed follow-up**: document this case in
`ANNEX-variant-json.md` ("an `act.invoke` on a coroutine returns its
`GDScriptFunctionState`, not its final value — verify the effect via
`assert_property`/`wait_for`, never via `act.invoke`'s return value").

## 4. `ERROR`/`WARNING` engine noise in `--headless` on this third-party project

The first headless boot of tps-demo (even before any instrumentation)
produces several noise lines on process shutdown: `ERROR: Parameter
"t" is null.` (`texture_2d_initialize`, dummy rendering), a `WARNING`
"Interpolated Camera3D triggered from outside physics process" documented
as "possibly benign" by the engine itself, and `ERROR: BUG: Unreferenced
static string` when the process is force-`kill()`ed. None of these affected
the frozen tests' results (20/20 green), but this noise makes raw CI logs
harder to read if a run fails for another reason. **Proposed follow-up**:
document in the runner's README that these lines are known tps-demo noise
in headless mode, not a failure signal — the contract remains the runner's
exit code (`0`/`1`), never a grep on `ERROR` in raw logs.

## 5. Clone weight (~800MB) and import time (several minutes)

`--depth 1` limits history but not assets (high-resolution glTF, HDR
textures). The first `--import` takes several minutes on this machine. No
impact on this ticket's acceptance criterion (reproducible setup, not fast),
but worth keeping in mind for a future CI script that would want to
automate this dogfooding continuously (cache the clone + `.godot/imported/`
between runs, instead of re-cloning/re-importing every time).

**Handled (issue #18)**: dedicated workflow
[`.github/workflows/dogfooding-tps-demo.yml`](../.github/workflows/dogfooding-tps-demo.yml)
that replays `setup-tps-demo.sh` + the dogfooding frozen test in CI, with
`actions/cache` on `.dogfood/tps-demo` (both the clone **and**
`.godot/imported/`, the latter living under the former). Cache key tied to
the setup script + the instrumentation patch (not the application code): a
change to either invalidates the cache and starts from a fresh clone.
Measured locally (same Godot 4.6.3 version and steps as the workflow, clone
already present and already imported — the equivalent of a warm cache in
CI): import pass ~3.8s, frozen test replay ~2.9s, so a total well under 10s
instead of "several minutes" cold. The run fails cleanly on the
`runner.tscn` exit code (no `|| true` on this step, unlike the import).

## 6. The `--headless` auto-host menu bypasses the "Play" button's instrumentation

`menu.gd _ready()` calls `_on_host_pressed.call_deferred()` as soon as it
detects `DisplayServer.get_name() == "headless"` — the headless session
therefore never goes through an actual click on `menu_play_button`. The
test-id placed on this button (see `INSTRUMENTATION.md`) remains a valid
canonical example (useful in a manual windowed session), but is not covered
by any automated assertion in this ticket's frozen test. **Proposed
follow-up**: a future "windowed" frozen test (`PLAYTEST_WINDOWED := true`)
could explicitly cover the menu → Play click → load path, complementing the
headless auto-host path covered here.

## 7. In windowed mode, shader compilation freezes the game beyond the 10s client timeout

Observed in a windowed agent session (without `--headless`) on the TPS
demo: on the first render of the 3D menu (then of the level), shader
compilation freezes the game's main thread **beyond the default 10s**
client-side timeout (`DEFAULT_REQUEST_TIMEOUT_MS`,
`mcp-server/src/bridge-client.ts`) — the first `query` after `hello` times
out with `BridgeTimeoutError` even though the Bridge would eventually have
responded. `BridgeClient.send()` already accepted a custom timeout, but
neither `Session.call()` nor the MCP tools exposed it: a real agent session
through the MCP server hit this wall with no escape hatch — a problem for
the launch demo, which is planned to run windowed (see `SESSION.md`).
**Resolved**: the "verb" tools now expose an optional `client_timeout_ms`
parameter (purely client-side: never sent to the Bridge, never recorded in
the trace, so never frozen by `freeze_scenario`), propagated through
`Session.call()` → `BridgeClient.send()`.
