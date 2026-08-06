## Hand-written frozen test (issue #17) — demonstrates the "aim telemetry"
## pattern: the game already exposes, via the player's `_test_state()`
## (`aim_target_test_id`), the node currently under the crosshair; this test
## uses it to assert "the target is in the crosshair" *before* triggering a
## real shot (camera raycast + physical bullet, not an
## `act.invoke` on `hit()`) — see dogfooding/INSTRUMENTATION.md.
##
## Deterministic setup, shot not recomputed on the test side:
## `level.gd player_spawn_points.shuffle()` shuffles the player's spawn point
## on every run (dogfooding/FRICTIONS.md #1), and the drawn spawn can end up
## in an alcove with no direct line of sight to a robot before leaving it
## (verified through exploration) — off-topic for what this test demonstrates
## (the aim telemetry pattern, not player navigation). The test therefore
## fixes the player's position near a known robot, on a spot
## re-verified through live exploration as walkable (no free fall), via
## `invoke(..., "set", ...)` — the reflection escape hatch already provided by
## the protocol (§4). The game then computes, as always, the exact
## camera→robot angle itself: the test only sweeps a fixed budget of camera
## rotations (deterministic: same calls on every run) and reads
## `aim_target_test_id` until this robot appears under the crosshair —
## no camera→target trigonometry on the test side, only the game's
## telemetry is read.
extends PlaytestCase

## Target robot (fixed position from `RobotSpawnpoints/Marker3D2` — only the
## *player's* position is shuffled by `level.gd`, not the robots' ;
## re-verified through live exploration the way `freeze_scenario` does).
const TARGET_TEST_ID := "enemy_Marker3D2"
const TARGET_POSITION := Vector3(53.2126007080078, -6.29876375198364, 15.9321002960205)
## Point from which the player aims, chosen and re-verified through live
## exploration: walkable ground (no free fall), with a camera sweep path that
## actually crosses the robot (test staging, never replayed as a
## domain value).
const STAND_POSITION := TARGET_POSITION + Vector3(8.0, 0.0, 0.0)

## Half-width of the swept pitch band, in fine pitch frames (1
## frame ≈ 1.43° at the aiming rotation speed,
## CAMERA_CONTROLLER_ROTATION_SPEED * 0.5 — see player_input.gd). Wide:
## the starting orientation (`Transform3D.looking_at`) does not point the
## camera directly at the target (the camera rig's spring arm has a
## fixed nonzero offset relative to the player's orientation, verified through
## live exploration) — the budget must cover this gap, not just a
## few degrees of noise.
const PITCH_HALF_BAND_FRAMES := 40
## Frames of continuous yaw between two pitch sweeps.
const YAW_FRAMES_PER_STEP := 2
## Number of zigzag passes (continuous yaw + triangle-wave pitch):
## re-verified through live exploration, the robot appears under the crosshair
## within about a hundred passes from `STAND_POSITION` — 2x margin.
const TOTAL_STEPS := 200

func test_tps_demo_player_aims_and_shoots_a_robot() -> void:
	await start_game("res://level/level.tscn")

	await wait_for({"test_id": "player_1"}, {"timeout_ms": 30000})

	var stand_transform := Transform3D(Basis(), STAND_POSITION).looking_at(TARGET_POSITION, Vector3.UP)
	invoke({"test_id": "player_1"}, "set", ["global_transform", stand_transform])
	await time_frames(15, true)

	input({"type": "action", "action": "aim", "pressed": true})
	await time_frames(20)

	var found: bool = await _search_aim_target()
	if not found:
		_record_failure("%s never confirmed under the crosshair within the search budget" % TARGET_TEST_ID)
		return

	# Domain precondition: the aim telemetry says the target is
	# under the crosshair *before* the shot — assertion enabled by the pattern
	# (issue #17), impossible to write on the test side without the game
	# exposing it itself. `eventually`: `_search_aim_target()` above already
	# confirmed it once, but the crosshair can drift by the time this runs.
	await assert_eventually_property({"test_id": "player_1"}, "aim_target_test_id", TARGET_TEST_ID,
		"%s is under the crosshair before the shot" % TARGET_TEST_ID)

	var health_before: Variant = query_one({"test_id": TARGET_TEST_ID}).get("health")

	# Real shot: camera raycast + physical bullet (player.gd apply_input),
	# never `act.invoke` on `hit()` — see dogfooding/FRICTIONS.md #2.
	input({"type": "action", "action": "shoot", "pressed": true})
	await time_frames(3, true)
	input({"type": "action", "action": "shoot", "pressed": false})

	# The bullet travels at finite speed (BULLET_VELOCITY = 20 m/s, bullet.gd):
	# retry-until-timeout assertion (§7) for it to reach the target.
	await assert_eventually_property({"test_id": TARGET_TEST_ID}, "health", int(health_before) - 1,
		"the real shot hit %s (HP decremented)" % TARGET_TEST_ID, 8000)


## Bounded, deterministic zigzag search (same calls on every run):
## continuous yaw (`view_right` held) + triangle-wave pitch, until
## `player_1.aim_target_test_id == TARGET_TEST_ID`. Stops as soon as
## confirmed, without letting the camera keep turning (reading and stopping
## the yaw are synchronous, no frame elapses between the two). Returns
## `false` if the budget runs out with no result (the calling test turns
## that into an explicit failure rather than a silent timeout).
##
## Implementation note: in this third-party project, `view_down`/`view_up`
## drive `camera_rot.rotation.x` opposite to what their name suggests
## (verified through live exploration; `view_down` tilts upward,
## `view_up` downward) — no functional consequence here (only the zigzag's
## direction matters, not the action's name), so left unfixed in
## `player_input.gd`, out of scope for issue #17.
func _search_aim_target() -> bool:
	var player := query_one({"test_id": "player_1"})
	if String(player.get("aim_target_test_id")) == TARGET_TEST_ID:
		return true

	input({"type": "action", "action": "view_up", "pressed": true})
	await time_frames(PITCH_HALF_BAND_FRAMES)
	input({"type": "action", "action": "view_up", "pressed": false})

	input({"type": "action", "action": "view_right", "pressed": true})
	var found := false
	var pitch_action := "view_down"
	var steps_in_direction := 0
	for _i in range(TOTAL_STEPS):
		input({"type": "action", "action": pitch_action, "pressed": true})
		await time_frames(1)
		input({"type": "action", "action": pitch_action, "pressed": false})
		steps_in_direction += 1
		if steps_in_direction >= PITCH_HALF_BAND_FRAMES * 2:
			pitch_action = "view_up" if pitch_action == "view_down" else "view_down"
			steps_in_direction = 0
		await time_frames(YAW_FRAMES_PER_STEP)

		player = query_one({"test_id": "player_1"})
		if String(player.get("aim_target_test_id")) == TARGET_TEST_ID:
			found = true
			break
	input({"type": "action", "action": "view_right", "pressed": false})
	return found
