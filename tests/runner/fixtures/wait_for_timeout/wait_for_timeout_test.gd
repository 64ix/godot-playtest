## Fixture (spec #9, ticket #10): a `wait_for` whose condition never becomes
## true MUST time out with a failure message naming the full Condition
## (selector plus mode and comparison) and the last observed value — never
## just the selector — with the existing message text preserved as a prefix.
## Every test method here is EXPECTED to fail, driven by
## tests/runner/test_runner.py (same convention as `broken_selector/` and
## `step_until_timeout_parity/`).
extends PlaytestCase

## Property mode: `score_label.text` stays "0" forever, so the timeout must
## report `condition: {"test_id":"score_label","property":"text",...}` and
## `last value: "0"` after the existing "timed out after 300ms" prefix.
func test_wait_for_timeout_names_condition_and_last_value() -> void:
	await start_game("res://fixtures/witness_game/main.tscn")
	await wait_for({"test_id": "score_label"},
		{"property": "text", "equals": "never_this_value", "timeout_ms": 300})
