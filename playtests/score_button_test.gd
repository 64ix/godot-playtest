## Reference frozen test (golden path, ticket #11): replays in in-process
## projection what tests/conformance/scenario.py verifies over the network —
## pressing `score_button` moves `score_label` from "0" to "1". Runs in
## `--headless`, without network or AI, via the addon's runner:
##
##     godot --headless --path . res://addons/playtest/runner.tscn -- --suite=res://playtests/
##
## This is the test CI replays x20 (the "golden path CI" criterion).
extends PlaytestCase

func test_score_button_increments_score_label() -> void:
	await start_game("res://fixtures/witness_game/main.tscn")

	var label := query_one({"test_id": "score_label"})
	if label == null:
		return
	await assert_now_eq(label.text, "0")

	press({"test_id": "score_button"})
	await wait_for({
		"test_id": "score_label",
		"property": "text",
		"equals": "1",
		"timeout_ms": 2000,
	})

	# Canonical form of the retry-until-timeout assertion (§7, ticket #11
	# remediation): `score_label` is already at "1" here (the `wait_for`
	# above just waited for it), so it succeeds without retrying — but unlike
	# an `assert_now_eq(label.text, "1")` on a pre-captured value, the
	# selector+property form re-resolves and re-reads the property live.
	await assert_eventually_property({"test_id": "score_label"}, "text", "1")

## Complementary golden path (ticket #11 remediation): on
## `fixtures/ready_widget/`, `ready_label` goes from "not_ready" to "ready"
## after a few idle frames — the target the review asked for to demonstrate
## the retry-until-timeout assertion on a value that becomes true over time,
## plus `time_frames` (§4, §6) for deterministic synchronization. Fixture
## deliberately separate from `witness_game/` (see fixtures/ready_widget/main.gd)
## so as not to disturb the network conformance suite
## (`tests/conformance/scenario.py`, `check_query_all`).
func test_ready_widget_becomes_ready_via_retry_assertion_and_time_frames() -> void:
	await start_game("res://fixtures/ready_widget/main.tscn")

	# Captured right after `start_game`, `ready_label.text` is still
	# "not_ready" (0 idle frames elapsed): the non-regression test for the
	# one-shot form (ticket #35: this genuinely is a `now` check — nothing
	# left to settle yet).
	await assert_now_property({"test_id": "ready_label"}, "text", "not_ready")

	# Canonical form (§7): retries until `ready_label` becomes "ready"
	# (3 frames later in the fixture) or times out — never a hardcoded
	# timing on the test side.
	await assert_eventually_property({"test_id": "ready_label"}, "text", "ready")

	# In-process `time.frames` (§4, §6): advances 2 deterministic idle frames,
	# then verifies state doesn't regress once stabilized — already settled
	# by the retry above plus these 2 extra frames, so a `now` check.
	await time_frames(2)
	await assert_now_property({"test_id": "ready_label"}, "text", "ready")
