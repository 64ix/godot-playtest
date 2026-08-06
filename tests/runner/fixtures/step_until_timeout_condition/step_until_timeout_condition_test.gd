## Fixture (spec #9, ticket #10): `time_step_until`'s frame-budget and
## safety-ceiling timeouts MUST append the same Condition + last-value
## suffix as `wait_for` — keeping pinned substrings like "after 7 frame(s)"
## intact in the existing message text. Every test method here is EXPECTED
## to fail, driven by tests/runner/test_runner.py (same convention as
## `step_until_timeout_parity/`).
extends PlaytestCase

## Frame budget: the never-true condition exhausts `max_frames=7` — the
## message must keep the pinned "after 7 frame(s)" text and append the
## condition + last value.
func test_step_until_frame_budget_names_condition_and_last_value() -> void:
	await start_game("res://fixtures/witness_game/main.tscn")
	var result := await time_step_until({"test_id": "score_label"},
		{"property": "text", "equals": "never_this_value", "max_frames": 7})
	await assert_now_eq(result["frames"], 7)

## Safety ceiling: `timeout_ms` is a wall-clock net only (ADR-0007) — with a
## huge `max_frames` budget the ceiling is guaranteed to fire first, and the
## message must append the same condition + last-value suffix.
func test_step_until_safety_ceiling_names_condition_and_last_value() -> void:
	await start_game("res://fixtures/witness_game/main.tscn")
	var result := await time_step_until({"test_id": "score_label"},
		{"property": "text", "equals": "never_this_value", "timeout_ms": 200, "max_frames": 100000})
	await assert_now_null(result["node"])
