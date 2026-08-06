## Export guard (ticket #10): static check runnable in CI.
##
## Inspects `export_presets.cfg` and fails (exit 1) if an export preset
## bundles the Bridge autoload (`TestBridge` → `addons/playtest/bridge.gd`,
## declared in `project.godot`) without explicitly carrying the `playtest`
## export feature, nor excluding the addon from the export via
## `exclude_filter`. Complements (defense in depth) the runtime startup
## refusal in `activation_policy.gd`: this check targets the export
## configuration itself, before even launching a binary.
##
## Usage:
##   godot --headless --script res://addons/playtest/export_guard_check.gd -- --project=<path>
## `--project` defaults to the current directory (`.`).
## Exit 0: all "prod" presets exclude the Bridge. Exit 1: at least one preset
## bundles the Bridge without being authorized to.
extends SceneTree

const AUTOLOAD_SCRIPT_HINT := "addons/playtest/bridge.gd"
const PLAYTEST_FEATURE := "playtest"

func _init() -> void:
	var project_path := _arg_value("--project", ".")
	quit(_run(project_path))

func _arg_value(name: String, default_value: String) -> String:
	for a in OS.get_cmdline_user_args():
		if a.begins_with(name + "="):
			return a.get_slice("=", 1)
	return default_value

func _run(project_path: String) -> int:
	var project_godot_path := project_path.path_join("project.godot")
	var export_presets_path := project_path.path_join("export_presets.cfg")

	if not FileAccess.file_exists(project_godot_path):
		printerr("[export-guard] project.godot not found: %s" % project_godot_path)
		return 1
	if not FileAccess.file_exists(export_presets_path):
		printerr("[export-guard] export_presets.cfg not found: %s" % export_presets_path)
		return 1

	if not _autoload_references_bridge(project_godot_path):
		print("[export-guard] TestBridge absent from project.godot autoloads — nothing to guard, OK.")
		return 0

	var presets := ConfigFile.new()
	var err := presets.load(export_presets_path)
	if err != OK:
		printerr("[export-guard] failed to read export_presets.cfg (code %d)" % err)
		return 1

	var failures: Array[String] = []
	var checked := 0

	for section in presets.get_sections():
		var parts := section.split(".")
		if parts.size() != 2 or parts[0] != "preset":
			continue  # ignore "preset.N.options" and any other section

		var preset_name: String = presets.get_value(section, "name", section)
		var custom_features: String = presets.get_value(section, "custom_features", "")
		var exclude_filter: String = presets.get_value(section, "exclude_filter", "")
		checked += 1

		if _has_feature(custom_features, PLAYTEST_FEATURE):
			print("[export-guard] preset '%s': feature '%s' present — instrumented, OK." % [preset_name, PLAYTEST_FEATURE])
			continue
		if _excludes_bridge(exclude_filter):
			print("[export-guard] preset '%s': addon excluded (exclude_filter) — not instrumented, OK." % preset_name)
			continue

		failures.append(
			"preset '%s' bundles the Bridge (%s) without feature '%s' nor exclusion (exclude_filter)"
			% [preset_name, AUTOLOAD_SCRIPT_HINT, PLAYTEST_FEATURE]
		)

	if checked == 0:
		print("[export-guard] no preset in export_presets.cfg — nothing to check.")
		return 0

	if failures.is_empty():
		print("[export-guard] OK — %d preset(s) checked, no instrumented prod export." % checked)
		return 0

	printerr("[export-guard] FAILED — instrumented prod export detected:")
	for f in failures:
		printerr("  - %s" % f)
	return 1

func _autoload_references_bridge(project_godot_path: String) -> bool:
	var cfg := ConfigFile.new()
	if cfg.load(project_godot_path) != OK:
		return false
	if not cfg.has_section("autoload"):
		return false
	for key in cfg.get_section_keys("autoload"):
		var value: String = cfg.get_value("autoload", key, "")
		if AUTOLOAD_SCRIPT_HINT in value:
			return true
	return false

func _has_feature(custom_features: String, feature: String) -> bool:
	for f in custom_features.split(","):
		if f.strip_edges() == feature:
			return true
	return false

func _excludes_bridge(exclude_filter: String) -> bool:
	if exclude_filter.is_empty():
		return false
	for pattern in exclude_filter.split(","):
		var p := pattern.strip_edges()
		if p.begins_with("res://"):
			p = p.substr(len("res://"))
		if "addons/playtest" in p:
			return true
	return false
