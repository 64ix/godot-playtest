# Suite budget in the runner, not just the harness

Frozen-test suites had no global run budget: cascading
`wait_for`/`time_step_until` timeouts could burn 20+ minutes with no fast
fail, and docs/INSTRUMENTATION.md §8 delegated all wall-clock timeouts to the
external harness. Decision (issue #8): the runner enforces its own suite
budget via the `PLAYTEST_SUITE_TIMEOUT_SECONDS` env var (unset = off); when
exceeded, it prints a distinct line naming the offending test and quits with
exit 1. The harness wall-clock timeout and CI `timeout-minutes` remain as the
backstop for hard synchronous hangs, which no in-process code can interrupt.

The runner can only enforce a deadline where it runs between frames: the
wait loops (`wait_for`/`time_step_until`/`assert_eventually_*` share the
check via the heartbeat tick helper), between tests, and in its own
`_process` (which also covers `attach_instance` multi-client waits). A test
stuck in a synchronous infinite loop (no `await`) still blocks the whole
process — only the external harness catches that; the budget is therefore a
fast-fail backstop for the issue's actual pain (cascading timeouts), not a
hang-proof guarantee.

This is runner surface, not wire protocol (ADR-0004): the env var never
travels over the bridge. docs/INSTRUMENTATION.md §8's "harness owns the
wall-clock timeout" wording is amended accordingly.

## Considered Options

- **Harness-only (status quo)** — rejected: the harness kill is a blunt
  external kill with no offending-test report, and the in-repo harness's
  `subprocess timeout=60` predates realistic suite sizes; the issue's
  measured pain (a 10-minute suite hang) needs an in-tool fast fail that
  names the culprit.
- **Runner-internal budget (chosen)** — fast fail with a diagnostic that
  names the test, works for every user regardless of which harness they use,
  and complements rather than replaces the harness backstop.
