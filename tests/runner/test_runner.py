#!/usr/bin/env python3
"""Test suite for the headless frozen-test runner (ticket #11, ticket #40).

Scenarios, each launched via `res://addons/playtest/runner.tscn`:

1. golden path: `res://playtests/` (the reference frozen test on
   fixtures/witness_game) MUST pass — exit 0, no failures reported.
2. broken selector: `tests/runner/fixtures/broken_selector/` (test-id
   renamed by mistake) MUST fail with the rich `not_found` + `suggestions`
   diagnostic in the report — never a silent timeout (the "Broken selector
   test" criterion of ticket #11).
3. single-file suite: `--suite` naming one `.gd` file runs only that file's
   `test_*` methods (ticket #40).
4. unparseable script: a script that fails to parse MUST be reported as a
   named failure and exit non-zero, never silently green (ticket #40, the
   "silent-green" regression this ticket closes).
5. absent suite directory: a `--suite` directory that does not exist MUST
   exit non-zero with a message distinct from the empty-suite message
   (ticket #40).
6. absent suite file: a `--suite` naming a `.gd` file that does not exist
   MUST exit non-zero — the file form of the same typo (ticket #40).
7. absent default suite: no `--suite` at all and no `res://playtests/` MUST
   exit non-zero too. The rule is about resolving what was named, not about
   who named it, so the default is not special-cased (ticket #40).
8. non-`.gd` suite path: a `--suite` naming a file that isn't `.gd` MUST
   exit non-zero (ticket #40).
9. empty suite directory: an existing directory with zero `.gd` files MUST
   still exit 0 (ticket #40 non-regression).
10. assert_now_* / assert_eventually_*: wrong argument kind is a reported
    failure naming the correct alternative (both directions), and
    `assert_now_property` fails against a value that is wrong *now* even
    though it becomes correct a few frames later — the guarantee
    `assert_eventually_property` cannot provide (ticket #35).
11. root path (ADR-0006): `tests/runner/fixtures/root_path/` — a game whose
    own script resolves a node through an absolute `/root/...` path MUST
    pass, now that start_game() mounts the game as a direct child of
    get_tree().root.
12. two mounts (ADR-0006): `tests/runner/fixtures/two_mounts/` — two
    `test_*` methods in the same file MUST each mount at the same clean
    `/root/Main` path, with no leftover from the first visible to the
    second.
13. self-freeing game (ADR-0006):
    `tests/runner/fixtures/self_freeing_game/` — a game that frees or
    detaches itself mid-test MUST tear down quietly, without a script error
    from `_exit_tree` drowning the test's own report and without leaking the
    game the addon still owns.
14. `time_step_until` parity, resolving path (ticket #38):
    `tests/runner/fixtures/step_until_parity/` — the in-process mirror of
    ticket #37's network verb, exercised against the same fixture/condition/
    budget already pinned by `tests/conformance/scenario.py`'s
    `check_step_until_resolves_after_n_frames`: MUST resolve at the
    identical frame count across repeats.
15. `time_step_until` parity, timeout path (ticket #38):
    `tests/runner/fixtures/step_until_timeout_parity/` — mirrors
    `check_step_until_timeout_property_never_true`/
    `check_step_until_determinism`: a never-true condition MUST time out at
    exactly `max_frames`, every time (the budget timeout is itself a
    reported failure, same rule as `wait_for`'s, so this fixture is
    EXPECTED to fail — same convention as `broken_selector/`).
16. time_scale reset (spec #66): `tests/runner/fixtures/time_scale_reset/` —
    a prior test's `time_scale()` on instance 0 MUST NOT leak into the next
    test; the runner resets `Engine.time_scale` to 1.0 before every
    `test_*()`.
17. `wait_for` timeout naming (spec #9, ticket #10):
    `tests/runner/fixtures/wait_for_timeout/` — a never-true condition MUST
    time out with the full Condition (`condition: {...}`) and the last
    observed value (`last value:`) appended after the existing message text
    (expected to fail, same convention as `broken_selector/`).
18. `time_step_until` timeout naming (spec #9, ticket #10):
    `tests/runner/fixtures/step_until_timeout_condition/` — the frame-budget
    AND safety-ceiling timeouts MUST append the same condition + last-value
    suffix, with pinned substrings like `after 7 frame(s)` kept intact
    (expected to fail).

The two-process, real-second-instance scenarios (attach_instance against a
prepared port-file directory, per-handle verbs/asserts, a dying client as a
named failure, fail-fast for a later test) live in their own driver,
test_multi_client.py, next to this file — they need to launch and tear down
a second Godot process around the whole runner invocation, which does not
fit this script's single-runner-call-per-scenario shape.

Usage: test_runner.py <godot_bin> <project_dir>
Exit 0 = every scenario behaves as expected.
"""
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

GODOT, PROJECT = sys.argv[1], sys.argv[2]


def run_suite(suite_path: str) -> tuple[int, str]:
    proc = subprocess.run(
        [
            GODOT, "--headless", "--path", PROJECT,
            "res://addons/playtest/runner.tscn",
            "--", f"--suite={suite_path}",
        ],
        capture_output=True, text=True, timeout=60,
    )
    return proc.returncode, proc.stdout + proc.stderr


def run_default_suite() -> tuple[int, str]:
    """Runs with no `--suite` at all, so the runner falls back to its default
    `res://playtests/`. This project has that directory, so the scenario needs
    a throwaway project holding the addon and nothing else. `--import` first:
    Godot blocks on the initial scan of a project with no `.godot/` yet."""
    with tempfile.TemporaryDirectory() as tmp:
        shutil.copytree(Path(PROJECT) / "addons" / "playtest",
                        Path(tmp) / "addons" / "playtest")
        (Path(tmp) / "project.godot").write_text(
            'config_version=5\n\n[application]\n\n'
            'config/name="playtest-default-suite-probe"\n'
        )
        subprocess.run(
            [GODOT, "--headless", "--path", tmp, "--import"],
            capture_output=True, text=True, timeout=120,
        )
        proc = subprocess.run(
            [
                GODOT, "--headless", "--path", tmp,
                "res://addons/playtest/runner.tscn",
            ],
            capture_output=True, text=True, timeout=60,
        )
    return proc.returncode, proc.stdout + proc.stderr


def main() -> None:
    failures = []

    code, output = run_suite("res://playtests/")
    if code != 0:
        failures.append(f"golden path: expected exit=0, got exit={code}\n{output}")
    elif "0 failure" not in output:
        failures.append(f"golden path: no '0 failure' report in output\n{output}")
    else:
        print("OK golden path (res://playtests/): exit=0")

    code, output = run_suite("res://tests/runner/fixtures/broken_selector/")
    if code == 0:
        failures.append(f"broken selector: expected exit!=0, got exit=0\n{output}")
    elif "not_found" not in output:
        failures.append(f"broken selector: 'not_found' diagnostic missing from output\n{output}")
    elif "suggestions" not in output:
        failures.append(f"broken selector: 'suggestions' missing from output (silent timeout?)\n{output}")
    elif "timeout" in output.lower():
        failures.append(f"broken selector: failed by timeout instead of the rich diagnostic\n{output}")
    else:
        print(f"OK broken selector: exit={code}, not_found + suggestions diagnostic present")

    code, output = run_suite("res://playtests/score_button_test.gd")
    if code != 0:
        failures.append(f"single-file suite: expected exit=0, got exit={code}\n{output}")
    elif "1 test file(s) discovered" not in output:
        failures.append(f"single-file suite: expected exactly 1 file discovered\n{output}")
    elif "2 test(s), 0 failure(s)" not in output:
        failures.append(f"single-file suite: expected 2 test(s) (score_button_test.gd's own methods), 0 failure(s)\n{output}")
    elif "domain_query_test" in output or "wait_for_method_domain_query" in output:
        failures.append(f"single-file suite: another suite file leaked into the run\n{output}")
    else:
        print("OK single-file suite (score_button_test.gd): exit=0, only that file's tests ran")

    code, output = run_suite("res://tests/runner/fixtures/unparseable_script/")
    if code == 0:
        failures.append(f"unparseable script: expected exit!=0, got exit=0 (silent-green regression, ticket #40)\n{output}")
    elif "unparseable_script_test.gd" not in output:
        failures.append(f"unparseable script: offending script not named in the report\n{output}")
    else:
        print(f"OK unparseable script: exit={code}, offending script named as a failure")

    code, output = run_suite("res://tests/runner/fixtures/does_not_exist/")
    if code == 0:
        failures.append(f"absent suite directory: expected exit!=0, got exit=0\n{output}")
    elif "no frozen test found" in output:
        failures.append(f"absent suite directory: message not distinguished from the empty-suite case\n{output}")
    else:
        print(f"OK absent suite directory: exit={code}, message distinct from empty-suite")

    code, output = run_suite("res://playtests/does_not_exist_test.gd")
    if code == 0:
        failures.append(f"absent suite file: expected exit!=0, got exit=0\n{output}")
    elif "no frozen test found" in output:
        failures.append(f"absent suite file: message not distinguished from the empty-suite case\n{output}")
    else:
        print(f"OK absent suite file: exit={code}, message distinct from empty-suite")

    code, output = run_default_suite()
    if code == 0:
        failures.append(f"absent default suite: expected exit!=0, got exit=0 (the default must not be special-cased)\n{output}")
    elif "res://playtests/" not in output:
        failures.append(f"absent default suite: the unresolved default path is not named in the message\n{output}")
    else:
        print(f"OK absent default suite (no --suite, no res://playtests/): exit={code}")

    code, output = run_suite("res://addons/playtest/plugin.cfg")
    if code == 0:
        failures.append(f"non-.gd suite path: expected exit!=0, got exit=0\n{output}")
    else:
        print(f"OK non-.gd suite path: exit={code}")

    code, output = run_suite("res://tests/runner/fixtures/empty_suite/")
    if code != 0:
        failures.append(f"empty suite directory: expected exit=0, got exit={code}\n{output}")
    else:
        print("OK empty suite directory: exit=0")

    code, output = run_suite("res://tests/runner/fixtures/assert_now_vs_eventually/")
    if code == 0:
        failures.append(f"assert_now_*/assert_eventually_*: expected exit!=0, got exit=0\n{output}")
    elif "3 test(s), 3 failure(s)" not in output:
        failures.append(f"assert_now_*/assert_eventually_*: expected 3 test(s), 3 failure(s)\n{output}")
    elif "use assert_eventually_eq instead" not in output:
        failures.append(
            f"assert_now_*/assert_eventually_*: assert_now_eq given a Callable must name "
            f"assert_eventually_eq as the alternative\n{output}"
        )
    elif "use assert_now_eq instead" not in output:
        failures.append(
            f"assert_now_*/assert_eventually_*: assert_eventually_eq given a value must name "
            f"assert_now_eq as the alternative\n{output}"
        )
    elif "assert_now_property" not in output or "got not_ready" not in output:
        failures.append(
            f"assert_now_*/assert_eventually_*: assert_now_property must fail against "
            f"ready_widget's not-yet-settled value at t0\n{output}"
        )
    else:
        print("OK assert_now_*/assert_eventually_*: wrong-kind + now-vs-eventually timing guarantee")

    code, output = run_suite("res://tests/runner/fixtures/root_path/")
    if code != 0:
        failures.append(f"root path: expected exit=0, got exit={code}\n{output}")
    elif "0 failure" not in output:
        failures.append(f"root path: no '0 failure' report in output\n{output}")
    else:
        print("OK root path (ADR-0006): exit=0, absolute /root/... path resolved from the fixture's own script")

    code, output = run_suite("res://tests/runner/fixtures/two_mounts/")
    if code != 0:
        failures.append(f"two mounts: expected exit=0, got exit={code}\n{output}")
    elif "0 failure" not in output:
        failures.append(f"two mounts: no '0 failure' report in output\n{output}")
    else:
        print("OK two mounts (ADR-0006): exit=0, both mounts landed at a clean /root/Main")

    code, output = run_suite("res://tests/runner/fixtures/self_freeing_game/")
    if code != 0:
        failures.append(f"self-freeing game: expected exit=0, got exit={code}\n{output}")
    elif "0 failure" not in output:
        failures.append(f"self-freeing game: no '0 failure' report in output\n{output}")
    elif "SCRIPT ERROR" in output:
        failures.append(f"self-freeing game: teardown raised a script error over the test's report\n{output}")
    elif "leaked at exit" in output:
        failures.append(f"self-freeing game: teardown left the detached game unfreed\n{output}")
    else:
        print("OK self-freeing game (ADR-0006): exit=0, teardown quiet and leak-free on a game that freed or detached itself")

    code, output = run_suite("res://tests/runner/fixtures/step_until_parity/")
    if code != 0:
        failures.append(f"time_step_until parity (resolving path): expected exit=0, got exit={code}\n{output}")
    elif "1 test(s), 0 failure(s)" not in output:
        failures.append(f"time_step_until parity (resolving path): expected 1 test(s), 0 failure(s)\n{output}")
    else:
        print("OK time_step_until parity, resolving path (ticket #38): exit=0, resolves at the identical frame count across 5 repeats")

    code, output = run_suite("res://tests/runner/fixtures/step_until_timeout_parity/")
    if code == 0:
        failures.append(f"time_step_until parity (timeout path): expected exit!=0, got exit=0\n{output}")
    elif "4 test(s), 4 failure(s)" not in output:
        failures.append(f"time_step_until parity (timeout path): expected 4 test(s), 4 failure(s)\n{output}")
    elif output.count("after 7 frame(s)") != 6:
        # 3 methods x 2 (each failure is both printed to stdout by runner.gd
        # and push_error()-ed to stderr by _record_failure; run_suite()
        # concatenates both streams).
        failures.append(f"time_step_until parity (timeout path): expected exactly 3 timeouts at frame 7\n{output}")
    elif "after 5 frame(s)" not in output:
        failures.append(f"time_step_until parity (timeout path): expected a timeout at frame 5\n{output}")
    else:
        print("OK time_step_until parity, timeout path (ticket #38): exit!=0, times out at exactly max_frames every time")

    code, output = run_suite("res://tests/runner/fixtures/time_scale_reset/")
    if code != 0:
        failures.append(f"time_scale reset: expected exit=0, got exit={code}\n{output}")
    elif "2 test(s), 0 failure(s)" not in output:
        failures.append(
            f"time_scale reset: expected '2 test(s), 0 failure(s)' — a leftover time_scale(5.0) from the "
            f"first test must not leak into the second\n{output}"
        )
    else:
        print("OK time_scale reset (spec #66): exit=0, Engine.time_scale back to 1.0 before the second test")

    code, output = run_suite("res://tests/runner/fixtures/wait_for_timeout/")
    if code == 0:
        failures.append(f"wait_for timeout naming: expected exit!=0, got exit=0\n{output}")
    elif "1 test(s), 1 failure(s)" not in output:
        failures.append(f"wait_for timeout naming: expected 1 test(s), 1 failure(s)\n{output}")
    elif "timed out after 300ms" not in output:
        failures.append(f"wait_for timeout naming: existing prefix not preserved in the message\n{output}")
    elif 'condition: {"test_id":"score_label","property":"text","equals":"never_this_value"}' not in output:
        failures.append(f"wait_for timeout naming: full Condition missing from the message\n{output}")
    elif 'last value: "0"' not in output:
        # `score_label.text` stays "0" for the whole fixture run, so the
        # last OBSERVED VALUE is pinned, not just the `last value:` label.
        failures.append(f"wait_for timeout naming: last observed value missing or wrong in the message\n{output}")
    else:
        print("OK wait_for timeout naming (ticket #10): exit!=0, condition + last value after the preserved prefix")

    code, output = run_suite("res://tests/runner/fixtures/step_until_timeout_condition/")
    if code == 0:
        failures.append(f"time_step_until timeout naming: expected exit!=0, got exit=0\n{output}")
    elif "2 test(s), 2 failure(s)" not in output:
        failures.append(f"time_step_until timeout naming: expected 2 test(s), 2 failure(s)\n{output}")
    elif "after 7 frame(s)" not in output:
        failures.append(f"time_step_until timeout naming: pinned 'after 7 frame(s)' substring lost\n{output}")
    elif 'condition: {"test_id":"score_label","property":"text","equals":"never_this_value"}' not in output:
        failures.append(f"time_step_until timeout naming: full Condition missing from the message\n{output}")
    elif 'last value: "0"' not in output:
        # Same pin as the wait_for fixture: `score_label.text` stays "0" on
        # both the budget and the safety-ceiling timeouts, so the last
        # OBSERVED VALUE is pinned, not just the `last value:` label.
        failures.append(f"time_step_until timeout naming: last observed value missing or wrong in the message\n{output}")
    elif "safety ceiling" not in output:
        failures.append(f"time_step_until timeout naming: safety-ceiling timeout did not fail as expected\n{output}")
    else:
        print("OK time_step_until timeout naming (ticket #10): exit!=0, condition + last value on budget and ceiling timeouts")

    if failures:
        print("--- FAILURES ---", file=sys.stderr)
        for f in failures:
            print(f, file=sys.stderr)
        sys.exit(1)

    print("PASS 18/18")


if __name__ == "__main__":
    main()
