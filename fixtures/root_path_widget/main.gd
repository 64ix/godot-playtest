extends Node
## Fixture dedicated to the ADR-0006 acceptance criterion: a game whose own
## script resolves a node through an absolute `/root/...` path — exactly
## the pattern that broke under the old mount (the game landed at an
## auto-generated path such as `/root/PlaytestRunner/@Node@2/Main`, so
## `/root/Main` never resolved). Mounting the game as a direct child of
## `get_tree().root` (see playtestcase.gd start_game) makes it resolve
## identically to a live scenario.
## Deliberately separate from `fixtures/witness_game/`: the network
## conformance suite (`tests/conformance/scenario.py`) makes an exhaustive
## assertion over the tree's test_id list (`check_query_all`) — adding a
## node there would break that check for a reason unrelated to what it
## verifies (see fixtures/ready_widget/main.gd).

var status_label: Label

func _ready() -> void:
	status_label = Label.new()
	status_label.name = "StatusLabel"
	status_label.set_meta("test_id", "root_path_status")
	var resolved := get_node_or_null("/root/Main")
	status_label.text = "resolved" if resolved == self else "not_resolved"
	add_child(status_label)
