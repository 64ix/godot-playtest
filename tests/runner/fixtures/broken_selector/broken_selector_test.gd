## Negative fixture (tests/runner/test_runner.py): a test-id renamed by
## mistake ("score_buttonz" instead of "score_button" in the real fixture)
## MUST fail with the rich `not_found` + suggestions diagnostic — never
## a silent timeout ("broken selector test" criterion of ticket #11).
extends PlaytestCase

func test_renamed_test_id_fails_with_rich_diagnostic() -> void:
	await start_game("res://fixtures/witness_game/main.tscn")
	query_one({"test_id": "score_buttonz"})
