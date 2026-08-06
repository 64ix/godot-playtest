# TPS demo instrumentation (issues #14, #17)

Canonical example of "minimal" instrumentation (§ solution of spec #7):
deterministic test-ids + a few domain `_test_state()`, full patch in
[`patches/0001-instrument-playtest-bridge.patch`](patches/0001-instrument-playtest-bridge.patch),
applied by [`setup-tps-demo.sh`](setup-tps-demo.sh).

## Why not metas placed in the `.tscn` files?

The player (`level.gd add_player`) and the enemy robots (`level.gd
spawn_robot`) are **instantiated dynamically at runtime**
(`PackedScene.instantiate()`), never present as-is in `level.tscn`.
`set_meta("test_id", ...)` therefore cannot be placed in the scene editor —
it is set at spawn time, in `level.gd`, right after instantiation. The
menu's "Play" button, on the other hand, exists statically in `menu.tscn`:
its test-id is set in `menu.gd _ready()` (same mechanism, different
trigger), but remains illustrative since in `--headless` mode the menu
auto-hosts without a click (see `SESSION.md`).

## Test-ids placed

| test_id | Node | Set in |
|---|---|---|
| `menu_play_button` | Main menu "Play" `Button` | `menu.gd _ready()` |
| `player_1` | Host `Player` (always `player_id=1` in solo/dogfooding) | `level.gd add_player()` |
| `enemy_Marker3D1`..`enemy_Marker3D4` | The 4 `RedRobot`s (one per `RobotSpawnpoints/Marker3D*`) | `level.gd spawn_robot()` |

The `enemy_<spawn point name>` convention is deterministic (stable child
order of `RobotSpawnpoints` in `level.tscn`) without depending on runtime
instantiation order.

## Domain `_test_state()` added

- **`enemies/red_robot/red_robot.gd`**: `{"health": int, "dead": bool,
  "state": String}` — exposes the combat loop (HP, death, state machine
  IDLE/APPROACH/AIM/SHOOTING) without the tool having to inspect the scene
  tree or animations.
- **`player/player.gd`**: `{"position": Vector3, "distance_from_spawn":
  float, "has_moved": bool, "airborne_time": float, "aim_target_test_id":
  String, "aim_target_position": Vector3}` — the last two fields are the
  aiming telemetry (issue #17, see dedicated section below).

## Pattern to remember: domain threshold boolean, never a continuous physical value

General lesson, beyond this project (see `FRICTIONS.md` #1): as soon as a
game mixes randomness into its initial state (here
`player_spawn_points.shuffle()` in `level.gd add_player()`), any continuous
physical value that depends on it — absolute position, exact distance
traveled, physical timestamp — is **never bit-for-bit reproducible** from
one run to another. A frozen test asserting this value would be flaky by
construction, not because of a bug in the tool or the game.

The workaround to apply, rather than rediscovering it project by project:
expose a **domain threshold boolean** (e.g. `has_moved` below) rather than
the continuous physical value itself (`position`, `distance_from_spawn`).
The threshold lives **in the game**, never in the test: it's the game that
defines what "having moved" (or any other threshold-based domain concept)
means for itself — see the tps-demo example in the next section.

## A real property in addition to `_test_state()`

`assert_property`/`wait_for` (protocol §4/§7) compare `node.get(property)`
by **strict equality** — never `>=`/`<=`. Two consequences kept here,
documented as comments right in the patch:

- **`player.gd` exposes `has_moved: bool`** (a real property, not just in
  `_test_state()`) rather than comparing `distance_from_spawn` (float) to
  an exact value — a position/physics float is never bit-for-bit
  reproducible from one run to another. The threshold
  (`MOVED_THRESHOLD_METERS = 2.0`) lives in the game, not in the test: it's
  the game that defines what "having moved" means for its domain.
- **`red_robot.gd hit()` is called directly via `act.invoke`**, without
  going through the player's shot raycast (`shoot()`/3D collision): aiming
  a headless raycast deterministically (cursor position at the center of
  the screen, exact line of sight to the collider) turned out to be too
  fragile for a reproducible frozen test — see `FRICTIONS.md` ("3D
  selectors"). `act.invoke` is the assumed escape hatch of the protocol
  (§4: "reflection") for this case.

## Aiming telemetry (issue #17): the "the game exposes what it already computes" pattern

The player's real shot (`player.gd apply_input`, `aiming` branch) starts
from a camera raycast through the exact center of the screen (`crosshair`)
into the 3D world — this is already, in the game, all the computation
needed to know "what is currently under the crosshair?". Before issue #17,
a frozen test had no way to read this result: either it recomputed the
camera→target trigonometry itself (fragile, depends on the player's exact
orientation — see `FRICTIONS.md` friction #2), or it bypassed the shot
entirely via `act.invoke` on `red_robot.gd hit()` (see section above —
still the demonstration used for the CI golden path, which tests the
combat domain without depending on aiming geometry).

**What to expose, and why on the game side rather than the test side**:
`player_input.gd` already computed `shoot_target` (the raycast's impact
point) at shot time; this patch (1) runs that same raycast **throughout
aiming** (`if aiming:`, not just `if shooting:`) and (2) republishes its
result as domain data on the player, as real properties (like `has_moved`,
see above) rather than only in `_test_state()` — `assert_property` reads
`node.get(property)` directly, with no detour:

- **`aim_target_test_id: String`** — the `test_id` of the node currently
  under the crosshair (`""` if nothing, or if the target has no
  `test_id`). A frozen test asserts "the target is under the crosshair"
  with this single field, without reconstructing the camera/target
  geometry. It's the game that resolves the collider into a `test_id`
  (`col.collider.get_meta("test_id")`), never the test.
- **`aim_target_position: Vector3`** — the raycast's impact point (mirror
  of `shoot_target`), useful for diagnostics (`query`) but never compared
  by strict equality (a position float, cf. `has_moved`).

Useful side effect found while writing this pattern: the original raycast
excluded `self` (the `MultiplayerSynchronizer`, with no physics RID — a
no-op) instead of the player itself; fixed to `get_parent()` (the
`CharacterBody3D`), otherwise the camera could end up "under its own
crosshair" at certain angles.

**Demonstration**: [`playtests/tps_demo_player_aims_and_shoots_a_robot.gd`](playtests/tps_demo_player_aims_and_shoots_a_robot.gd)
covers a real shot (raycast + physical bullet, never `act.invoke`) that
hits a robot: the test reads `aim_target_test_id` to assert "the target is
under the crosshair" before triggering the shot semantically (`act.input`
`shoot`), then verifies the domain (HP decremented) — 20/20 green headless
(see `playtests/README.md`).

Like `has_moved` (friction #1), the player's spawn is shuffled on every run
(`level.gd player_spawn_points.shuffle()`) and can land in an area with no
direct line of sight to a robot before leaving it — off-topic for what this
test demonstrates (the telemetry pattern, not navigation). The test
therefore fixes the player's starting position via `invoke(..., "set",
...)` (the protocol's reflection escape hatch, §4) on a spot re-verified
live as workable, then lets the game compute, as always, the exact
camera→robot angle: only a fixed camera-rotation budget is swept on the
test side, never any trigonometry.

## Reproduce

```sh
dogfooding/setup-tps-demo.sh                 # clone + addon + patch
GODOT_BIN --headless --path .dogfood/tps-demo --import
```

Then see `SESSION.md` (agent session) and `playtests/README.md` (frozen
test replay).
