## Negative fixture (tests/runner/test_runner.py): a script that fails to
## parse (calls an undefined method on self) MUST be reported as a named
## failure and make the runner exit non-zero — never invisible, never a
## silent green suite (ticket #40 "silent-green" class of bug).
extends PlaytestCase

func test_calls_a_function_that_does_not_exist() -> void:
	this_function_does_not_exist()
