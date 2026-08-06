## Positive fixture (tests/runner/test_runner.py), ADR-0006: a game whose own
## script resolves a node through an absolute `/root/...` path (see
## fixtures/root_path_widget/main.gd) must resolve exactly as it would in a
## live scenario, now that start_game() mounts the game as a direct child of
## get_tree().root.
extends PlaytestCase

func test_root_path_resolves_from_fixture_script() -> void:
	await start_game("res://fixtures/root_path_widget/main.tscn")
	await assert_now_property({"test_id": "root_path_status"}, "text", "resolved")
