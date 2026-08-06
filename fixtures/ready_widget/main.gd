extends Node
## Minimal fixture dedicated to demonstrating the retry-until-timeout
## assertion (§7) and in-process `time.frames` (ticket #11, remediation).
## Deliberately separate from `fixtures/witness_game/`: the latter is the
## fixture shared by the network conformance suite
## (`tests/conformance/scenario.py`), which does an exhaustive assertion on
## the tree's `test_id` list (`check_query_all`) — adding a node here would
## break that check for a reason unrelated to what it verifies.
##
## `ready_label` goes from "not_ready" to "ready" after `ready_after_frames`
## idle frames, then stays stable: the ideal target for demonstrating that a
## one-shot `assert_now_eq`/`assert_now_property` captured right after
## `start_game()` would fail depending on timing, while the
## `assert_eventually_*` retry-until-timeout form waits for the value to
## become true.

@export var ready_after_frames := 3

var ready_label: Label
var _frames_elapsed := 0

func _ready() -> void:
	ready_label = Label.new()
	ready_label.name = "ReadyLabel"
	ready_label.text = "not_ready"
	ready_label.set_meta("test_id", "ready_label")
	add_child(ready_label)

func _process(_delta: float) -> void:
	if _frames_elapsed < ready_after_frames:
		_frames_elapsed += 1
		if _frames_elapsed >= ready_after_frames:
			ready_label.text = "ready"
