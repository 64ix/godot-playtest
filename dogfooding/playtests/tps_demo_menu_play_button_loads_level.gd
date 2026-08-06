## Windowed frozen test (issue #19, tracked by FRICTIONS.md #6): the
## menu → click Play → level loading path, complementary to the
## headless auto-host path covered by
## `tps_demo_player_moves_and_neutralizes_a_robot.gd`.
##
## In `--headless`, `menu.gd _ready()` calls `_on_host_pressed.call_deferred()`
## right at boot (see FRICTIONS.md #6): the session never goes through a
## real `press` on `menu_play_button`, so this canonical test-id (see
## `INSTRUMENTATION.md`) is not covered by any automated assertion in
## headless. This test starts `main.tscn` (not directly `level.tscn`
## like the headless test) so that `menu.gd`'s `DisplayServer.get_name() ==
## "headless"` branch is false — a necessary condition for
## `_on_play_pressed()` to only trigger via the `press()` below, not
## automatically.
##
## Replay (windowed, without `--headless` — see this folder's README.md):
##
##     GODOT_BIN --path .dogfood/tps-demo \
##       res://addons/playtest/runner.tscn -- --suite=res://playtests/
extends PlaytestCase

## Windowed-only: the runner skips it in --headless (no display) — see
## runner.gd `_is_windowed_only` and addons/playtest/README.md "Freeze".
## Note: `press()` (direct emission of the `pressed` signal) would work
## just as well in headless — the constant is needed here because it's
## the *scene* that behaves differently depending on `DisplayServer.get_name()`
## (auto-host in headless, see header), not because `press()` needs
## a display.
const PLAYTEST_WINDOWED := true

func test_tps_demo_menu_play_button_loads_level() -> void:
	await start_game("res://main/main.tscn")

	# Sanity: the menu is indeed displayed (not already auto-hosted) and the
	# Play button (canonical test-id `menu_play_button`, INSTRUMENTATION.md) is
	# there, visible and actionable — precisely the path the headless
	# test cannot exercise (FRICTIONS.md #6).
	await wait_for({"test_id": "menu_play_button"}, {"timeout_ms": 10000})
	# Ambiguous intent (a menu scene may need a few frames to become visible
	# after the node exists) — `eventually` is the safer default here (ticket
	# #35 addendum): a `now` check on a value that hasn't settled yet is
	# exactly the flake this ticket removes.
	await assert_eventually_property({"test_id": "menu_play_button"}, "visible", true, "Play button visible before the click")

	# Real click on "Play" (offline/solo, not "Host"): triggers
	# `menu.gd _on_play_pressed()` -> threaded loading of `level.tscn` ->
	# `replace_main_scene` -> `main.gd` switches the current scene.
	press({"test_id": "menu_play_button"})

	# Domain assertion: the level did load and a solo player
	# (`multiplayer.is_server()` true for the solo Play's
	# `OfflineMultiplayerPeer`) has spawned — same test-id as the headless
	# path (`player_1`, level.gd add_player()). Large timeout: threaded
	# loading + 0.5s timer (`menu.tscn UI/Loading/DoneTimer`) + shader
	# compilation on the level's first load.
	await wait_for({"test_id": "player_1"}, {"timeout_ms": 30000})
