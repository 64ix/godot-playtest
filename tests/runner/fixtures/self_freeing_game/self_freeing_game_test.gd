## Regression fixture (tests/runner/test_runner.py), ADR-0006: the addon owns
## the teardown of what it mounted, but it does not own the game — a game that
## transitions scene or returns to a menu frees or detaches itself mid-test.
## Teardown must stay quiet about it.
## `test_teardown_survives_a_game_detached_from_the_tree` is the one that
## reproduced a bug: without the `parent` guard in playtestcase.gd `_exit_tree`
## it printed "SCRIPT ERROR: Cannot call method 'remove_child' on a null value"
## and leaked the game at exit. The freed-itself half already passed (Godot
## compares a freed reference equal to `null`) and is here to pin that, since
## nothing else states it.
## Reuses `fixtures/witness_game/` rather than adding a scene: what is under
## test is the teardown path, not anything the game does.
extends PlaytestCase

func test_teardown_survives_a_game_that_freed_itself() -> void:
	var node := await start_game("res://fixtures/witness_game/main.tscn")
	node.queue_free()
	await get_tree().process_frame
	await assert_now_false(is_instance_valid(node), "the game must really be freed, or this asserts nothing")

func test_teardown_survives_a_game_detached_from_the_tree() -> void:
	var node := await start_game("res://fixtures/witness_game/main.tscn")
	node.get_parent().remove_child(node)
	await assert_now_null(node.get_parent(), "the game must really be out of the tree, or this asserts nothing")
