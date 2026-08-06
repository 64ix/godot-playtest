#!/usr/bin/env python3
"""Two-process GDScript suite through the runner harness (spec #66).

Plays the role of "the game's own harness" (ADR-0005/ADR-0008: the addon
never launches game processes, only attaches) for
tests/runner/fixtures/multi_client/multi_client_test.gd: builds a small
throwaway "remote" project in a temp dir (same technique as
`run_default_suite()` in test_runner.py — copy addons/playtest/ + a minimal
project.godot), launches it headless with `--playtest`, waits for its
port-file, points `PLAYTEST_ATTACH_PORTS` at the directory holding it (named
"b", the attach contract: filename = instance name), then runs the addon's
real headless runner against THIS repo's own project with that env var set.

Proves, against a REAL second process (not a fake bridge):
1. `attach_instance` against a prepared port-file directory, and per-handle
   verbs/asserts against that real process.
2. A broken selector on one handle aborts only that handle — self and the
   rest of the report keep going, one aggregated report.
3. A client dying mid-test (the fixture's own `self_destruct`, invoked
   in-protocol via `act.invoke` — no race against an external process kill)
   is a named failure, never a skip.
4. A later test naming the same (now-dead) instance fails fast instead of
   repeating the same doomed retry/timeout — proven by an overall wall-clock
   budget well under what a real retry at that test's (deliberately large)
   timeout would take.

Usage: test_multi_client.py <godot_bin> <project_dir>
Exit 0 = the suite behaves exactly as documented in the fixture's own header.
"""
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

GODOT, PROJECT = sys.argv[1], sys.argv[2]

REMOTE_GAME_GD = """extends Node2D
## Minimal remote game for the multi-client regression suite
## (tests/runner/test_multi_client.py): a Button/Label pair like the other
## fixtures, plus self_destruct() -- the deterministic, in-protocol way the
## suite makes this instance die mid-test, instead of racing an external
## process kill against the runner's own timing.
var _score := 0
var _label: Label

func _ready() -> void:
\tset_meta("test_id", "remote_game")

\tvar button := Button.new()
\tbutton.name = "RemoteButton"
\tbutton.text = "Score!"
\tbutton.set_meta("test_id", "remote_button")
\tadd_child(button)
\tbutton.pressed.connect(_on_pressed)

\t_label = Label.new()
\t_label.name = "RemoteLabel"
\t_label.text = "0"
\t_label.set_meta("test_id", "remote_label")
\tadd_child(_label)

func _on_pressed() -> void:
\t_score += 1
\t_label.text = str(_score)

func self_destruct() -> void:
\tget_tree().quit()
"""

REMOTE_GAME_TSCN = """[gd_scene load_steps=2 format=3]

[ext_resource type="Script" path="res://main.gd" id="1"]

[node name="Main" type="Node2D"]
script = ExtResource("1")
"""


def build_remote_project(remote_dir: Path) -> None:
    shutil.copytree(Path(PROJECT) / "addons" / "playtest", remote_dir / "addons" / "playtest")
    (remote_dir / "project.godot").write_text(
        'config_version=5\n\n[application]\n\n'
        'config/name="playtest-multi-client-remote-probe"\n'
        'run/main_scene="res://main.tscn"\n'
        'config/features=PackedStringArray("4.6")\n\n'
        '[autoload]\n\n'
        'TestBridge="*res://addons/playtest/bridge.gd"\n'
    )
    (remote_dir / "main.gd").write_text(REMOTE_GAME_GD)
    (remote_dir / "main.tscn").write_text(REMOTE_GAME_TSCN)


def wait_for_port_file(path: Path, timeout_s: float = 30.0) -> int:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        if path.exists():
            content = path.read_text().strip()
            if content:
                return int(content)
        time.sleep(0.05)
    raise TimeoutError(f"port-file never appeared: {path}")


def terminate(proc: subprocess.Popen) -> None:
    if proc.poll() is not None:
        return
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=5)


def main() -> None:
    failures = []

    with tempfile.TemporaryDirectory() as remote_tmp, tempfile.TemporaryDirectory() as attach_tmp:
        remote_dir = Path(remote_tmp)
        attach_dir = Path(attach_tmp)
        build_remote_project(remote_dir)

        subprocess.run(
            [GODOT, "--headless", "--path", str(remote_dir), "--import"],
            capture_output=True, text=True, timeout=120,
        )

        port_file = attach_dir / "b"
        remote_proc = subprocess.Popen(
            [
                GODOT, "--headless", "--path", str(remote_dir),
                "--", "--playtest", "--bridge-port=0", f"--bridge-port-file={port_file}",
            ],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        )
        try:
            wait_for_port_file(port_file)

            env = dict(os.environ)
            env["PLAYTEST_ATTACH_PORTS"] = str(attach_dir)

            started = time.perf_counter()
            proc = subprocess.run(
                [
                    GODOT, "--headless", "--path", PROJECT,
                    "res://addons/playtest/runner.tscn", "--",
                    "--suite=res://tests/runner/fixtures/multi_client/",
                ],
                capture_output=True, text=True, timeout=60, env=env,
            )
            elapsed_s = time.perf_counter() - started
            output = proc.stdout + proc.stderr

            if proc.returncode == 0:
                failures.append(f"expected a non-zero exit (3 deliberate failures), got 0\n{output}")
            elif "4 test(s), 3 failure(s)" not in output:
                failures.append(f"expected '4 test(s), 3 failure(s)' in the report\n{output}")
            else:
                print("OK report: 4 test(s), 3 failure(s)")

            if "[b] " not in output:
                failures.append(f"handle failures must be tagged with the instance name ('[b] ...')\n{output}")
            else:
                print("OK handle failures are tagged with the instance name")

            if "no_such_remote_button" not in output or "not_found" not in output:
                failures.append(f"test 2's broken selector on b must surface not_found for no_such_remote_button\n{output}")
            else:
                print("OK broken selector on b surfaces the rich not_found diagnostic")

            # Test 2 must NOT abort self: proven by checking that no reported
            # failure line names score_label (self's own selector) anywhere.
            failure_lines = [line for line in output.splitlines() if "FAIL" in line or line.strip().startswith("-")]
            if any("score_label" in line for line in failure_lines):
                failures.append(f"self's own assertion in test 2 must not fail alongside b's broken selector\n{output}")
            else:
                print("OK a broken selector on b never aborts self — self's own assertion still passes")

            if "instance unavailable" not in output and "instance 'b'" not in output:
                failures.append(f"a dead client mid-test must surface a named 'instance unavailable' failure\n{output}")
            else:
                print("OK a client dying mid-test is a named failure, never a silent skip")

            # Test 4 passes a deliberately large nominal timeout (15000ms twice)
            # for an instance already known dead: if the fail-fast short-circuit
            # regressed, the whole run would balloon well past this budget.
            if elapsed_s > 10.0:
                failures.append(
                    f"suite took {elapsed_s:.1f}s — fail-fast for an already-dead instance regressed "
                    f"(test 4 would otherwise burn its full ~15s+15s timeout)\n{output}"
                )
            else:
                print(f"OK instance-unavailable fails fast: whole suite ran in {elapsed_s:.1f}s")
        except BaseException:
            if remote_proc.poll() is None:
                remote_proc.kill()
            out = remote_proc.stdout.read().decode(errors="replace")[-2000:] if remote_proc.stdout else ""
            print("---remote game output---\n" + out, file=sys.stderr)
            raise
        finally:
            terminate(remote_proc)

    if failures:
        print("--- FAILURES ---", file=sys.stderr)
        for f in failures:
            print(f, file=sys.stderr)
        sys.exit(1)

    print("PASS 5/5")


if __name__ == "__main__":
    main()
