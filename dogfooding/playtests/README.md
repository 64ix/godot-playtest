# Dogfooding frozen tests: replay

[`tps_demo_player_moves_and_neutralizes_a_robot.gd`](tps_demo_player_moves_and_neutralizes_a_robot.gd)
is the frozen test produced by `freeze_scenario` from the session
documented in [`../SESSION.md`](../SESSION.md): moving the player then
neutralizing an enemy robot, domain assertions (`has_moved`, `health`,
`dead`), `ci_safe = true` (replayable in `--headless`). The shot itself is
simulated via `act.invoke` on `hit()` (not a real shot — see
`FRICTIONS.md` #2).

[`tps_demo_player_aims_and_shoots_a_robot.gd`](tps_demo_player_aims_and_shoots_a_robot.gd)
is a hand-written frozen test (issue #17) that this time covers a **real
shot**: camera raycast + physical bullet, never `act.invoke`. It uses the
aiming telemetry (`player.gd aim_target_test_id`, see
`INSTRUMENTATION.md`) to assert "the target is under the crosshair" before
triggering the shot semantically, then verifies the domain (HP
decremented) — without ever recomputing camera→target trigonometry on the
test side.

## Replay

```sh
# 1. Instrumented clone (if not already done)
dogfooding/setup-tps-demo.sh
GODOT_BIN --headless --path .dogfood/tps-demo --import   # first time only

# 2. Copy the frozen tests into the clone
mkdir -p .dogfood/tps-demo/playtests
cp dogfooding/playtests/*.gd .dogfood/tps-demo/playtests/

# 3. Replay (exit 0 = green)
GODOT_BIN --headless --path .dogfood/tps-demo \
  res://addons/playtest/runner.tscn -- --suite=res://playtests/
```

## Verify ×20 headless (the criterion for tickets #14/#17)

```sh
for i in $(seq 1 20); do
  GODOT_BIN --headless --path .dogfood/tps-demo \
    res://addons/playtest/runner.tscn -- --suite=res://playtests/ \
    | grep -q "0 failure(s)" && echo "run $i: OK" || echo "run $i: FAIL"
done
```

Both tests validated 20/20 locally (see `SESSION.md` for the first,
generated from an agent session; the second hand-written for issue #17).
Note: the player spawn point shuffle (`FRICTIONS.md` #1) makes the spawn
position vary on every run.

- `tps_demo_player_moves_and_neutralizes_a_robot.gd` never depends on the
  absolute position, only on `has_moved` (distance-traveled threshold) and
  the enemy's state (`health`/`dead`), both deterministic.
- `tps_demo_player_aims_and_shoots_a_robot.gd` explicitly fixes the
  player's starting position (`invoke(..., "set", ...)`, see
  `INSTRUMENTATION.md`) rather than depending on the spawn draw — a random
  spawn can end up in an area with no direct line of sight to a robot
  before leaving it, off-topic for what this test demonstrates.

## Windowed frozen test: menu → Play click → loading (issue #19)

[`tps_demo_menu_play_button_loads_level.gd`](tps_demo_menu_play_button_loads_level.gd)
covers the path that the test above cannot exercise: in `--headless`,
`menu.gd _ready()` auto-hosts at boot (`FRICTIONS.md` #6), so the headless
session never goes through an actual `press` on `menu_play_button`. This
test carries `const PLAYTEST_WINDOWED := true` — the runner cleanly skips
it in `--headless` (`SKIP (windowed-only, ...)`, exit 0) and only runs it
windowed. It starts `res://main/main.tscn` (not directly `level.tscn`) so
that `menu.gd`'s auto-host branch stays false, presses
`menu_play_button`, then waits for the `player_1` test-id of the loaded
level (domain assertion, same selector as the headless test).

### Replay (windowed, requires a local display — no CI)

```sh
# 1. Instrumented clone + import (if not already done, see section above)
dogfooding/setup-tps-demo.sh
GODOT_BIN --headless --path .dogfood/tps-demo --import

# 2. Copy the frozen test into the clone
mkdir -p .dogfood/tps-demo/playtests
cp dogfooding/playtests/tps_demo_menu_play_button_loads_level.gd \
   .dogfood/tps-demo/playtests/

# 3. Replay WITHOUT --headless (a window opens then closes, exit 0 = green)
GODOT_BIN --path .dogfood/tps-demo \
  res://addons/playtest/runner.tscn -- --suite=res://playtests/
```

Windowed pass validated locally (`1 test(s), 0 failure(s)`, exit 0, following
exactly the 3 steps above) during this ticket's implementation. Verify the
clean skip in headless:

```sh
GODOT_BIN --headless --path .dogfood/tps-demo \
  res://addons/playtest/runner.tscn -- --suite=res://playtests/
# → "SKIP (windowed-only, no display in --headless — ticket #13)"
#   for tps_demo_menu_play_button_loads_level.gd, exit 0.
```
