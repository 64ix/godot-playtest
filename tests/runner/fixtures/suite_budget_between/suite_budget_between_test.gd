## Fixture (spec #9, ticket #12): the suite budget is a SUITE-level
## deadline — it survives test boundaries. A fast first test completes, then
## the slow second test's wait outlives the 1s budget: the runner MUST trip
## the budget mid-suite (between tests, one of ADR-0009's enforcement
## points) and exit 1 naming the test that was running when it blew — never
## a summary report, never a FAIL for the cut-off test. Driven by
## tests/runner/test_runner.py with PLAYTEST_SUITE_TIMEOUT_SECONDS=1.
extends PlaytestCase

## Fast, passing first test: completes comfortably inside the 1s budget.
func test_one_fast_pass() -> void:
	await start_game("res://fixtures/witness_game/main.tscn")
	await assert_now_eq(query_one({"test_id": "score_label"}).text, "0")

## 10s never-true wait: the 1s budget must trip while this is running.
func test_two_slow_wait_exceeds_budget() -> void:
	await start_game("res://fixtures/witness_game/main.tscn")
	await wait_for({"test_id": "score_label"},
		{"property": "text", "equals": "never_this_value", "timeout_ms": 10000})
