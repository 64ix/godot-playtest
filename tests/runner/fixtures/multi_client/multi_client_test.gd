## Two-process GDScript suite through the runner harness (spec #66) — driven
## by tests/runner/test_multi_client.py, which launches a small throwaway
## "remote" project as instance "b" (writing its port-file into the
## directory PLAYTEST_ATTACH_PORTS points at) BEFORE this suite ever runs,
## and leaves it running for the whole invocation (per-suite lifetime, §61).
##
## Proves, against a REAL second process:
## - attach_instance against a prepared port-file directory, and per-handle
##   verbs/asserts against that real process (test 1);
## - a broken selector on one handle aborts only that handle — self and the
##   rest of the report keep going, one aggregated report (test 2);
## - a client dying mid-test is a named failure, never a skip (test 3);
## - a later test naming the same (now-dead) instance fails fast instead of
##   repeating the same doomed retry/timeout (test 4).
##
## Expected report: 4 test(s), 3 failure(s) (tests 2/3/4 each contribute
## exactly one) — asserted by test_multi_client.py.
extends PlaytestCase

func test_1_attach_and_drive_second_client() -> void:
	await start_game("res://fixtures/witness_game/main.tscn")
	await assert_now_eq(query_one({"test_id": "score_label"}).text, "0", "self starts at 0")

	var b := await attach_instance("b")
	var remote_before = await b.query_one({"test_id": "remote_label"})
	await assert_now_eq(remote_before.get("text"), "0", "b starts at 0, independent of self")

	press({"test_id": "score_button"})
	await assert_eventually_property({"test_id": "score_label"}, "text", "1")

	await b.press({"test_id": "remote_button"})
	# The exact shape Freeze renders for a handle-addressed time.step_until —
	# a real network round trip stepping b's OWN frames until the press lands.
	var stepped := await b.time_step_until({"test_id": "remote_label"},
		{"property": "text", "equals": "1", "max_frames": 300})
	await assert_now_not_null(stepped.get("node"), "time_step_until on b resolves its condition")
	await b.assert_eventually_property({"test_id": "remote_label"}, "text", "1")

	# Self's own press never touched b, and vice versa: two independently
	# connected clients, not one process driven twice.
	await assert_now_eq(query_one({"test_id": "score_label"}).text, "1")
	var remote_after = await b.query_one({"test_id": "remote_label"})
	await assert_now_eq(remote_after.get("text"), "1")

func test_2_broken_selector_on_b_aborts_only_b() -> void:
	await start_game("res://fixtures/witness_game/main.tscn")
	var b := await attach_instance("b")

	# not_found on b: exactly one failure, aborts b only.
	await b.press({"test_id": "no_such_remote_button"})
	# b is now aborted: a no-op, must NOT add a second failure.
	await b.press({"test_id": "remote_button"})

	# self is a totally different object: unaffected by b's abort.
	press({"test_id": "score_button"})
	await assert_eventually_property({"test_id": "score_label"}, "text", "1")

func test_3_b_dies_mid_test_is_a_named_failure() -> void:
	var b := await attach_instance("b")
	# Deterministic, in-protocol way to make instance b die mid-test
	# (act.invoke, the accepted escape hatch) — no race against an external
	# process kill's timing.
	await b.invoke({"test_id": "remote_game"}, "self_destruct")
	await get_tree().create_timer(0.5).timeout
	# The process is gone: this call must fail — a NAMED failure (never a
	# skip), never an uncaught exception on this side.
	await b.query({})

func test_4_instance_unavailable_after_death_fails_fast() -> void:
	# `b` already died in test 3 and was marked unavailable for the rest of
	# this runner invocation (PlaytestClient static bookkeeping, spec #66
	# §61): a large nominal timeout here proves the failure is immediate — a
	# real retry against a long-dead port would burn the whole timeout.
	var b := await attach_instance("b", 15000, 15000)
