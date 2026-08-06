## Fixture (ticket #38): the resolving-path half of `time_step_until`'s
## in-process parity proof against the network verb `time.step_until`
## (`dispatch.gd _poll_step_until`, ticket #37). The timeout-path half lives
## in the sibling fixture `tests/runner/fixtures/step_until_timeout_parity/`
## (separate directory: a budget timeout is a reported failure — see
## `time_step_until`'s doc comment in playtestcase.gd — so it needs its own
## "expected to fail" fixture, same convention as `broken_selector/`).
##
## A true side-by-side comparison inside a single running process is not
## achievable: the network projection is only reachable from a Godot
## process driven over a TCP loopback socket
## (`tests/conformance/scenario.py`), while the in-process projection runs
## directly inside this runner's own process, with no bridge/socket in the
## loop at all — the two literally cannot be exercised by the same call in
## the same tick. What this fixture proves instead: given the SAME fixture
## (`fixtures/witness_game/`), the SAME condition (`true_after_n_frames`),
## and the SAME budget parameters as
## `check_step_until_resolves_after_n_frames` in scenario.py, the in-process
## projection produces the SAME observable outcome (an identical resolution
## frame count across repeats) that the network projection is already
## pinned to produce — the strongest parity evidence available without
## literally running both projections in one process.
extends PlaytestCase

## Mirrors `check_step_until_resolves_after_n_frames` exactly (n=6,
## max_frames=30, 5 repeats over the same started game): `true_after_n_frames`
## flips purely from the fixture's own per-frame counter, no second message
## and no wall-clock involved, so the resolving path is bit-for-bit
## reproducible — same guarantee ticket #37 pins over the wire.
func test_step_until_resolves_after_n_frames() -> void:
	await start_game("res://fixtures/witness_game/main.tscn")
	var frames_seen: Array = []
	for i in range(5):
		var result := await time_step_until({"test_id": "game"},
			{"method": "true_after_n_frames", "args": [6], "equals": true, "max_frames": 30})
		await assert_now_not_null(result["node"])
		frames_seen.append(result["frames"])
	await assert_now_eq(frames_seen, [6, 6, 6, 6, 6])
