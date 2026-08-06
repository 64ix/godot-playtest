## Bridge activation policy (ticket #10): never instrument a prod build by
## accident (AltTester lesson).
##
## Pure function, isolated from `bridge.gd` so it can be tested without
## depending on a real `template_release` binary (impossible to get in
## headless mode without actually exporting): the Bridge starts if and only
## if
## - the build is NOT a release export (`template_release`), and there is an
##   opt-in (export feature `playtest` OR argument `--playtest`); or
## - the build IS a release export, and the `playtest` export feature is
##   present.
## A release export can never be activated by the `--playtest` argument
## alone: the feature must be set at export time (Project > Export > preset
## > Features), not slipped in on the command line at launch.
class_name PlaytestActivationPolicy
extends RefCounted

## Returns `{"start": bool, "reason": String, "guard_triggered": bool}`.
## `reason` is empty if `start` is true. `guard_triggered` distinguishes a
## "normal dormancy" refusal (silent, no log) from an "anti-prod-instrumented
## guard" refusal (explicit error log, § criteria #10).
static func decide(is_release: bool, has_playtest_feature: bool, has_playtest_arg: bool) -> Dictionary:
	if is_release and not has_playtest_feature:
		return {
			"start": false,
			"guard_triggered": true,
			"reason": (
				"release build (template_release) without export feature "
				+ "'playtest' — refusing to start (anti-prod-instrumented "
				+ "guard, see ticket #10). A `--playtest` on the command "
				+ "line is not enough on a release export: the feature "
				+ "must be set on the export preset."
			),
		}

	if not (has_playtest_feature or has_playtest_arg):
		return {
			"start": false,
			"guard_triggered": false,
			"reason": "dormant: neither export feature 'playtest' nor argument --playtest",
		}

	return {"start": true, "guard_triggered": false, "reason": ""}
