## Fixture (spec #9, ticket #12): a multi-client Frozen test whose attached
## instance hangs MUST also trip the suite budget. `attach_instance` polls
## for `$PLAYTEST_ATTACH_PORTS/b`, which this fixture's driver
## (tests/runner/test_multi_client.py) leaves NEVER appearing — so the
## attach sits in its port-file poll for the whole 15s `port_file_timeout`.
## No wait-loop heartbeat tick ever runs here (the hang is inside
## `PlaytestClient._connect`, not in any wait_for/assert), so the RUNNER's
## own per-frame tick is the enforcement point (ADR-0009): with
## PLAYTEST_SUITE_TIMEOUT_SECONDS=1 it MUST quit(1) naming this test —
## never a FAIL, never the port-file timeout.
extends PlaytestCase

func test_attach_hung_instance_exceeds_budget() -> void:
	await attach_instance("b", 15000)
