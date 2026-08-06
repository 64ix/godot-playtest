## Unit test for `PlaytestActivationPolicy` (ticket #10).
##
## Pure function tested directly (without launching a real release binary,
## impossible to obtain headless without actually exporting): covers the
## four combinations (is_release × opt-in) the guard must decide between.
## Usage: godot --headless --script res://tests/export_guard/activation_policy_test.gd
## Exit 0 = all assertions pass.
extends SceneTree

const ActivationPolicy = preload("res://addons/playtest/activation_policy.gd")

var _failures: Array[String] = []

func _init() -> void:
	_check(
		"release without feature, without arg → refused + guard triggered",
		ActivationPolicy.decide(true, false, false),
		false, true
	)
	_check(
		"release without feature, with --playtest → refused + guard triggered (the arg alone isn't enough)",
		ActivationPolicy.decide(true, false, true),
		false, true
	)
	_check(
		"release with feature → starts",
		ActivationPolicy.decide(true, true, false),
		true, false
	)
	_check(
		"non-release, without opt-in → silently dormant",
		ActivationPolicy.decide(false, false, false),
		false, false
	)
	_check(
		"non-release, with --playtest → starts",
		ActivationPolicy.decide(false, false, true),
		true, false
	)
	_check(
		"non-release, with feature → starts",
		ActivationPolicy.decide(false, true, false),
		true, false
	)

	if _failures.is_empty():
		print("PASS 6/6")
		quit(0)
	else:
		for f in _failures:
			printerr("FAIL: %s" % f)
		quit(1)

func _check(label: String, decision: Dictionary, expected_start: bool, expected_guard: bool) -> void:
	if decision["start"] != expected_start or decision["guard_triggered"] != expected_guard:
		_failures.append(
			"%s: expected start=%s guard_triggered=%s, got %s"
			% [label, expected_start, expected_guard, decision]
		)
	elif expected_guard and decision["reason"] == "":
		_failures.append("%s: guard_triggered is true but reason is empty (log not explicit)" % label)
	else:
		print("ok: %s" % label)
