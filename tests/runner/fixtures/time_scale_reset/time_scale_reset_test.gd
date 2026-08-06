## Regression fixture (tests/runner/test_runner.py, spec #66): a prior
## test's time_scale() on instance 0 must never leak into the next test —
## the runner resets Engine.time_scale to 1.0 before each test_*() method
## (runner.gd). Without that reset, test_2 below would observe 5.0 (this
## file's own test_1 leftover) instead of the clean default.
extends PlaytestCase

func test_1_sets_time_scale_away_from_default() -> void:
	await start_game("res://fixtures/witness_game/main.tscn")
	time_scale(5.0)
	await assert_now_eq(Engine.time_scale, 5.0, "time_scale(5.0) takes effect immediately")

func test_2_time_scale_resets_between_tests() -> void:
	await start_game("res://fixtures/witness_game/main.tscn")
	await assert_now_eq(Engine.time_scale, 1.0, "the runner must reset Engine.time_scale between tests")
