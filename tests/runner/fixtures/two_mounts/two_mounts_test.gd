## Regression fixture (tests/runner/test_runner.py), ADR-0006: two `test_*`
## methods in the same file each mount and tear down cleanly — no leftover
## game node from the first visible to the second. Without the addon
## detaching what it mounted before freeing it, the second mount would
## collide on the name "Main" under get_tree().root and get auto-renamed by
## Godot, reintroducing the fidelity gap this ticket fixes.
extends PlaytestCase

func test_first_mount() -> void:
	var node := await start_game("res://fixtures/witness_game/main.tscn")
	await assert_now_eq(str(node.get_path()), "/root/Main")
	await assert_now_eq(query({}).size(), 7)

func test_second_mount_sees_no_leftover_from_first() -> void:
	var node := await start_game("res://fixtures/witness_game/main.tscn")
	await assert_now_eq(str(node.get_path()), "/root/Main")
	await assert_now_eq(query({}).size(), 7)
