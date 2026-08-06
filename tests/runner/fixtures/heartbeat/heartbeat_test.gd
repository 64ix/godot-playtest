## Fixture (spec #9, ticket #11): a Frozen test whose wait outlives the
## heartbeat interval MUST emit periodic `still waiting for <condition>
## (<elapsed>/<total>)` lines on stderr — naming the Condition and the
## elapsed/total budget — while a wait shorter than the interval stays
## silent. Driven by tests/runner/test_runner.py with a short
## PLAYTEST_HEARTBEAT_MS (200ms) so the whole scenario costs well under a
## second per test of CI time. Every test method here is EXPECTED to fail (a
## never-true condition), same convention as `wait_for_timeout/`.
extends PlaytestCase

## `wait_for` (time-budgeted): 900ms on a never-true condition with a 200ms
## interval MUST produce three-plus heartbeat lines naming the full
## Condition, with the elapsed/total budget in seconds.
func test_wait_for_emits_heartbeats() -> void:
	await start_game("res://fixtures/witness_game/main.tscn")
	await wait_for({"test_id": "score_label"},
		{"property": "text", "equals": "never_this_value", "timeout_ms": 900})

## `time_step_until` (frame-budgeted): the heartbeat MUST show the budget as
## frames. The safety-ceiling path (huge `max_frames`, small `timeout_ms`)
## keeps the wait wall-clock-bound — a frame-budgeted wait of `max_frames`
## frames lasts a frame-rate-dependent wall time (headless runs uncapped,
## ~145fps on a dev machine, faster on CI), which could dip below the
## interval on a fast machine and emit nothing.
func test_time_step_until_emits_heartbeats() -> void:
	await start_game("res://fixtures/witness_game/main.tscn")
	await time_step_until({"test_id": "score_label"},
		{"property": "text", "equals": "never_this_value", "timeout_ms": 900, "max_frames": 100000})

## `assert_eventually_property`: the retry-until-timeout assertion family
## MUST emit the same heartbeat lines, naming its Condition — a distinct
## target (`score_button.text`), so the driver can tell these lines from
## `wait_for`'s. (Deliberately a String property: a mismatched-type
## comparison raises a script error in `assert_eventually_property`, killing
## the coroutine silently — pre-existing addon landmine, out of scope here.)
func test_assert_eventually_property_emits_heartbeats() -> void:
	await start_game("res://fixtures/witness_game/main.tscn")
	await assert_eventually_property({"test_id": "score_button"}, "text", "never_this_value", "", 900)

## Callable-based `assert_eventually_eq`: no Condition exists (the Callable
## IS the check — ADR-0006), so the heartbeat names the assertion kind.
func test_assert_eventually_eq_emits_heartbeats() -> void:
	await start_game("res://fixtures/witness_game/main.tscn")
	await assert_eventually_eq(func(): return 1, 2, "", 900)
