## Fixture (spec #9, ticket #12): a Frozen test whose wait outlives the
## suite budget MUST trip `PLAYTEST_SUITE_TIMEOUT_SECONDS` — the runner
## exits 1 with the distinct `[playtest-runner] suite budget exceeded (1s)
## while running <file> :: <method>` line naming the offending test —
## instead of burning the wait's own 10s timeout. Driven by
## tests/runner/test_runner.py with PLAYTEST_SUITE_TIMEOUT_SECONDS=1; the
## test method here is EXPECTED to be cut off by the budget (the suite never
## completes), same convention as `wait_for_timeout/`.
extends PlaytestCase

## `wait_for` on a never-true condition with a 10s timeout: the 1s suite
## budget MUST trip via the shared heartbeat tick — well before the wait's
## own timeout could record an ordinary failure.
func test_slow_wait_exceeds_budget() -> void:
	await start_game("res://fixtures/witness_game/main.tscn")
	await wait_for({"test_id": "score_label"},
		{"property": "text", "equals": "never_this_value", "timeout_ms": 10000})
