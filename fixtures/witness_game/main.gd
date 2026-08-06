extends Node2D
## Witness game: permanent fixture for the godot-playtest protocol conformance
## suite (tests/conformance/scenario.py). A player that moves via the
## "move_right" action, a button that increments a score, and an example of
## `_test_state()` exposing the domain (docs/protocol/DRAFT-v0.md §5).
##
## `DupA`/`DupB` exist solely to exercise the "ambiguous" error (§3): two
## nodes deliberately sharing the same test_id.

var player: ColorRect
var score_label: Label
var score := 0

func _ready() -> void:
	set_meta("test_id", "game")
	add_to_group("game")

	if not InputMap.has_action("move_right"):
		InputMap.add_action("move_right")
		var ev := InputEventKey.new()
		ev.keycode = KEY_D
		InputMap.action_add_event("move_right", ev)

	player = ColorRect.new()
	player.name = "Player"
	player.color = Color.CYAN
	player.size = Vector2(32, 32)
	player.position = Vector2(50, 200)
	player.set_meta("test_id", "player")
	player.add_to_group("actors")
	add_child(player)

	var button := Button.new()
	button.name = "ScoreButton"
	button.text = "Score!"
	button.position = Vector2(280, 60)
	button.set_meta("test_id", "score_button")
	button.add_to_group("ui")
	button.pressed.connect(_on_score)
	add_child(button)

	score_label = Label.new()
	score_label.name = "ScoreLabel"
	score_label.text = "0"
	score_label.position = Vector2(280, 20)
	score_label.set_meta("test_id", "score_label")
	score_label.add_to_group("ui")
	add_child(score_label)

	# C# state contract convention (§5): node whose script defines ONLY
	# `_TestState()` (PascalCase), cf. pascal_witness.gd.
	var pascal: Node = preload("res://fixtures/witness_game/pascal_witness.gd").new()
	pascal.name = "PascalWitness"
	pascal.set_meta("test_id", "pascal_witness")
	add_child(pascal)

	var dup_a := Node.new()
	dup_a.name = "DupA"
	dup_a.set_meta("test_id", "dup_demo")
	dup_a.add_to_group("duplicates")
	add_child(dup_a)

	var dup_b := Node.new()
	dup_b.name = "DupB"
	dup_b.set_meta("test_id", "dup_demo")
	dup_b.add_to_group("duplicates")
	add_child(dup_b)

func _on_score() -> void:
	score += 1
	score_label.text = str(score)

func _process(delta: float) -> void:
	if Input.is_action_pressed("move_right"):
		player.position.x += 120 * delta

## Example of a domain contract (§5): any Dictionary, including non-JSON
## Variants (here a Vector2), goes through variant_json.gd.
func _test_state() -> Dictionary:
	return {"score": score, "player_position": player.position}

## Targets for `act.invoke` (tests/conformance/scenario.py): a pure method
## (generic Variant->JSON mapping) and one that reads game state (Vector2).
func echo(value):
	return value

func get_player_position() -> Vector2:
	return player.position

## Parameterized domain query (§4, `wait_for` mode "method"): pure read
## callable again every frame — the pattern for computed state that doesn't
## exist as a node property (e.g. a large collection queried by key, cf.
## docs/INSTRUMENTATION.md).
func score_at_least(threshold: int) -> bool:
	return score >= threshold

## Deterministic domain query for `time.step_until`'s *resolving*-path
## determinism test (ticket #37 —
## tests/conformance/scenario.py::check_step_until_resolves_after_n_frames,
## mirrored in mcp-server's fixture integration test): becomes true exactly
## `n` engine frames after the first call with a given `n`, then resets.
## Unlike `score_at_least` (which needs an external `act.press` to flip, so
## the exact resolution frame isn't pinned — its arrival frame isn't
## controlled by this suite), this flips purely from the fixture's own
## per-frame state, with no second network message involved, so it can pin
## the resolving path itself to an exact, reproducible frame count.
var step_until_probe_target_frame := -1
func true_after_n_frames(n: int) -> bool:
	if step_until_probe_target_frame < 0:
		step_until_probe_target_frame = Engine.get_process_frames() + n
	if Engine.get_process_frames() < step_until_probe_target_frame:
		return false
	step_until_probe_target_frame = -1
	return true
