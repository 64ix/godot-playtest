## Fixture (ticket #35): every test method here is EXPECTED to fail — driven
## by tests/runner/test_runner.py, which asserts the exact diagnostic
## substrings below appear in the runner's report. Deliberately NOT under
## res://playtests/ (which must stay green, ticket #11's golden-path CI
## criterion).
##
## Covers two acceptance criteria that a passing suite cannot demonstrate:
## - wrong-argument-kind is a reported failure naming the correct alternative
##   (ADR-0006 naming corollary), for both directions;
## - `assert_now_property` fails when the property is wrong at the moment of
##   the call, even though it becomes correct a few frames later — the
##   guarantee `assert_eventually_property` cannot provide. Uses
##   fixtures/ready_widget/, which flips its label a few frames after
##   `_ready()` for exactly this purpose (see its header comment).
extends PlaytestCase

func test_assert_now_eq_rejects_a_callable() -> void:
	# Wrong kind: assert_now_eq wants an already-evaluated value, not a
	# Callable — must fail naming assert_eventually_eq as the alternative.
	await assert_now_eq(func(): return "0", "0")

func test_assert_eventually_eq_rejects_a_value() -> void:
	# Wrong kind, the other direction: assert_eventually_eq wants a
	# Callable, not an already-evaluated value — must fail naming
	# assert_now_eq as the alternative.
	await assert_eventually_eq("0", "0")

func test_assert_now_property_fails_before_the_fixture_settles() -> void:
	await start_game("res://fixtures/ready_widget/main.tscn")
	# `ready_label` only becomes "ready" a few frames after `_ready()`
	# (fixtures/ready_widget/main.gd): at t0, checking it right now for the
	# value it will EVENTUALLY hold must fail — assert_eventually_property
	# would instead wait for it and pass (see playtests/score_button_test.gd
	# for that non-regression case).
	await assert_now_property({"test_id": "ready_label"}, "text", "ready")
