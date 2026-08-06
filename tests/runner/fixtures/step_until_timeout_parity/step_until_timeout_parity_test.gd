## Fixture (ticket #38): every test method here is EXPECTED to fail — driven
## by tests/runner/test_runner.py, which asserts the exact frame count named
## in the resulting diagnostic (same convention as `broken_selector/`/
## `assert_now_vs_eventually/`). Deliberately separate from
## `step_until_parity/` (which MUST stay green): `time_step_until`'s budget
## timeout is a reported failure, same rule as `wait_for`'s (see its doc
## comment in playtestcase.gd) — a condition that never becomes true within
## `max_frames` is exactly what these methods intend to exercise.
##
## This is the timeout-path half of `time_step_until`'s in-process parity
## proof against the network verb `time.step_until` (`dispatch.gd
## _poll_step_until`, ticket #37) — the resolving-path half lives in the
## sibling fixture `tests/runner/fixtures/step_until_parity/`. Mirrors
## `check_step_until_timeout_property_never_true`/
## `check_step_until_determinism` in `tests/conformance/scenario.py` exactly
## (`property="text"`, `equals="never_this_value"`): given the SAME fixture,
## the SAME never-true condition and the SAME `max_frames` budget already
## pinned over the wire, the in-process projection times out at the
## identical exact frame count too — proof by the same method as
## `step_until_parity/`'s resolving-path check (see its header comment for
## why a literal single-process side-by-side isn't achievable).
extends PlaytestCase

## Mirrors `check_step_until_timeout_property_never_true` exactly
## (`max_frames=5`): a condition that never becomes true exhausts the frame
## budget and resolves as a timeout at EXACTLY `max_frames` engine frames —
## never a value below or above it.
func test_step_until_times_out_at_exactly_max_frames() -> void:
	await _assert_timeout_at_frame(5)

## Repeated across 3 independently-mounted PlaytestCase instances (the
## runner gives each `test_*` method a fresh one, see `runner.gd`) — a
## never-true condition's frame budget exhausts at the SAME exact frame
## count every time, mirroring `check_step_until_determinism`'s 5 repeats
## over the wire (extra guardrail #4's determinism requirement, applied to
## the timeout path; split across methods rather than a single loop because
## a budget timeout flips `_aborted`, same as `wait_for`'s, so a second call
## in the same method would short-circuit instead of exercising its own
## budget).
func test_step_until_timeout_is_deterministic_repeat_1() -> void:
	await _assert_timeout_at_frame(7)

func test_step_until_timeout_is_deterministic_repeat_2() -> void:
	await _assert_timeout_at_frame(7)

func test_step_until_timeout_is_deterministic_repeat_3() -> void:
	await _assert_timeout_at_frame(7)

func _assert_timeout_at_frame(max_frames: int) -> void:
	await start_game("res://fixtures/witness_game/main.tscn")
	var result := await time_step_until({"test_id": "score_label"},
		{"property": "text", "equals": "never_this_value", "max_frames": max_frames})
	await assert_now_null(result["node"])
	await assert_now_eq(result["frames"], max_frames)
