## Reference frozen test for `wait_for`'s "method" mode (§4, parameterized
## domain query) in in-process projection: the counterpart of the network
## check `check_wait_for_method_out_of_order` in tests/conformance/scenario.py.
## The pattern targeted: a computed domain state, queried by arguments
## (`score_at_least(1)`), which doesn't exist as a node property — see
## docs/INSTRUMENTATION.md "Parameterized domain queries".
extends PlaytestCase

func test_wait_for_method_domain_query() -> void:
	await start_game("res://fixtures/witness_game/main.tscn")

	# Before any action, the domain query says "score < 1".
	var game := query_one({"test_id": "game"})
	if game == null:
		return
	await assert_now_false(game.score_at_least(1))

	press({"test_id": "score_button"})
	var node := await wait_for({"test_id": "game"}, {
		"method": "score_at_least",
		"args": [1],
		"equals": true,
		"timeout_ms": 2000,
	})
	await assert_now_not_null(node)
