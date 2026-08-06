#!/usr/bin/env python3
"""CI test for the export guard (ticket #10, "CI test" criterion).

Runs `addons/playtest/export_guard_check.gd` against synthetic
project.godot + export_presets.cfg fixtures (tests/export_guard/fixtures)
and checks the expected exit code for each:

- prod_instrumented    : preset with no `playtest` feature nor exclusion → fails.
- prod_legit_feature   : preset with `custom_features="playtest"` → passes.
- prod_legit_excluded  : preset that excludes addons/playtest/* → passes.
- no_bridge            : no TestBridge autoload → nothing to guard, passes.

Usage: test_export_guard.py <godot_bin> <project_dir>
Exit 0 = all fixtures behave as expected.
"""
import subprocess
import sys
from pathlib import Path

GODOT, PROJECT = sys.argv[1], sys.argv[2]
FIXTURES = Path(__file__).parent / "fixtures"

CASES = [
    ("prod_instrumented", 1),
    ("prod_legit_feature", 0),
    ("prod_legit_excluded", 0),
    ("no_bridge", 0),
]


def run_check(fixture_name: str) -> tuple[int, str]:
    fixture_path = FIXTURES / fixture_name
    proc = subprocess.run(
        [
            GODOT, "--headless", "--path", PROJECT,
            "--script", "res://addons/playtest/export_guard_check.gd",
            "--", f"--project={fixture_path}",
        ],
        capture_output=True, text=True, timeout=60,
    )
    return proc.returncode, proc.stdout + proc.stderr


def main() -> None:
    failures = []
    for fixture_name, expected_code in CASES:
        code, output = run_check(fixture_name)
        if code != expected_code:
            failures.append(
                f"{fixture_name}: expected exit={expected_code}, got exit={code}\n{output}"
            )
        else:
            print(f"OK {fixture_name}: exit={code} (expected)")

    if failures:
        print("--- FAILURES ---", file=sys.stderr)
        for f in failures:
            print(f, file=sys.stderr)
        sys.exit(1)

    print(f"PASS {len(CASES)}/{len(CASES)}")


if __name__ == "__main__":
    main()
