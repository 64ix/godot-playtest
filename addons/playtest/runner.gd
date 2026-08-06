## Headless runner for frozen tests (docs/protocol/DRAFT-v0.md §7, ticket #11).
##
## Launch (the runner replaces the main scene, it does not need to be set as
## `run/main_scene`):
##
##     godot --headless --path <project> res://addons/playtest/runner.tscn -- --suite=res://playtests/
##
## `--suite` (default `res://playtests/`) names either a directory — every
## `.gd` script under it, recursively — or a single `.gd` file, which is then
## the whole suite (one Godot process per scenario, the only reset that clears
## autoload state wholesale; also how a suite is sharded across CI jobs).
## Runs each `test_*()` method of each script sequentially and prints a
## readable report.
##
## Exit code — standard CI contract (§7: "the CI runner replays"), and never
## a green suite that ran nothing (ticket #40):
##
## - nonzero if a test failed, or if a discovered script cannot be
##   instantiated (a parse error is a named failure, not an invisible skip),
##   or if `--suite` names a path that does not resolve — the default
##   `res://playtests/` included, since the rule is about resolving what was
##   named, not about who named it;
## - zero if every test passed, including when an existing suite directory
##   holds no `.gd` file at all.
extends Node

const PlaytestCaseScript = preload("res://addons/playtest/playtestcase.gd")

func _ready() -> void:
	var args := _parse_args(OS.get_cmdline_user_args())
	var suite_path: String = args.get("suite", "res://playtests/")

	var discovery := _discover(suite_path)
	if not discovery["error"].is_empty():
		print("[playtest-runner] %s" % discovery["error"])
		get_tree().quit(1)
		return

	var scripts: Array = discovery["scripts"]
	if scripts.is_empty():
		print("[playtest-runner] no frozen test found under %s" % suite_path)
		get_tree().quit(0)
		return

	print("[playtest-runner] %d test file(s) discovered under %s" % [scripts.size(), suite_path])

	var total := 0
	var failed := 0
	for script_path in scripts:
		var script: GDScript = load(script_path)
		if script == null or not script.can_instantiate():
			total += 1
			failed += 1
			print("→ %s" % script_path)
			print("  FAIL: script could not be instantiated (parse error?)")
			continue
		if _is_windowed_only(script) and DisplayServer.get_name() == "headless":
			print("→ %s : SKIP (windowed-only, no display in --headless — ticket #13)" % script_path)
			continue
		for method_name in _test_methods(script):
			total += 1
			# Reset before every test (spec #66): a prior test's time_scale()
			# on instance 0 must never leak into the next one — instances
			# 1..N are naturally immune (a separate OS process each), so this
			# only ever needs to touch this runner's own Engine singleton.
			Engine.time_scale = 1.0
			var case: PlaytestCase = script.new()
			add_child(case)
			case._reset_report()
			print("→ %s :: %s" % [script_path, method_name])
			var started_ms := Time.get_ticks_msec()
			await case.callv(method_name, [])
			var elapsed_s := (Time.get_ticks_msec() - started_ms) / 1000.0
			if case.failures.is_empty():
				print("  ok (%.1fs)" % elapsed_s)
			else:
				failed += 1
				print("  FAIL (%.1fs)" % elapsed_s)
				for f in case.failures:
					print("    - %s" % f["message"])
					if not f["query_dump"].is_empty():
						print("      query: %s" % JSON.stringify(f["query_dump"]))
			remove_child(case)
			case.queue_free()

	# Best-effort `quit` to every attached instance this whole invocation
	# ever connected to (spec #66 §53) — once, here, never per-test (a
	# handle's process is launched once by the harness for the life of the
	# whole suite, cf. attach_instance/PlaytestClient).
	PlaytestClient.quit_all_attached()

	print("")
	print("[playtest-runner] %d test(s), %d failure(s)" % [total, failed])
	get_tree().quit(1 if failed > 0 else 0)

func _parse_args(user_args: PackedStringArray) -> Dictionary:
	var out := {}
	for a in user_args:
		if a.begins_with("--suite="):
			out["suite"] = a.get_slice("=", 1)
	return out

## Resolves `--suite` to the scripts to run. Accepts a directory (recursive
## discovery via `_discover_dir`, sorted, as before) or a path to a single
## `.gd` file, which is then the whole suite (one Godot process per scenario
## — see the runner's doc comment above). Returns
## `{"scripts": Array, "error": String}`: `error` is non-empty when `path`
## could not be resolved at all (absent path, or a file that isn't `.gd`) —
## the caller must treat that as a non-zero exit. A directory that resolves
## but holds zero `.gd` files is NOT an error (`error == ""`, `scripts == []`)
## — a bare empty array couldn't express that difference, hence this
## Dictionary shape (ticket #40).
func _discover(path: String) -> Dictionary:
	if path.ends_with(".gd"):
		if not FileAccess.file_exists(path):
			return {"scripts": [], "error": "suite path does not exist: %s" % path}
		return {"scripts": [path], "error": ""}
	if DirAccess.open(path) == null:
		return {"scripts": [], "error": "suite path does not exist or is not a directory: %s" % path}
	return {"scripts": _discover_dir(path), "error": ""}

## Recursive discovery: every `.gd` file under `dir_path` is treated as a
## frozen test script (convention of `res://playtests/`), sorted by path
## for a deterministic execution order.
func _discover_dir(dir_path: String) -> Array:
	var out := []
	var dir := DirAccess.open(dir_path)
	if dir == null:
		return out
	dir.list_dir_begin()
	var entry_name := dir.get_next()
	while entry_name != "":
		if entry_name == "." or entry_name == "..":
			entry_name = dir.get_next()
			continue
		var full_path: String = dir_path.path_join(entry_name)
		if dir.current_is_dir():
			out.append_array(_discover_dir(full_path))
		elif entry_name.ends_with(".gd") and not entry_name.ends_with(".gd.uid"):
			out.append(full_path)
		entry_name = dir.get_next()
	dir.list_dir_end()
	out.sort()
	return out

## A frozen script generated by `freeze_scenario` (ticket #13) for a
## non-CI-safe scenario (screenshot, act.input type=click) carries the
## `PLAYTEST_WINDOWED := true` constant (see mcp-server/src/freeze.ts generateFrozenScript) —
## the runner skips it in `--headless` (no display) rather than letting it
## fail on a `no_display`/dead hit-testing.
func _is_windowed_only(script: GDScript) -> bool:
	var consts := script.get_script_constant_map()
	return bool(consts.get("PLAYTEST_WINDOWED", false))

## All `test_*` methods with no arguments declared on the script (a
## disposable instance serves as a reflection probe, freed immediately).
func _test_methods(script: GDScript) -> Array:
	var probe: Object = script.new()
	var names := []
	for m in probe.get_method_list():
		var method_name: String = m["name"]
		if method_name.begins_with("test_") and (m["args"] as Array).is_empty():
			names.append(method_name)
	if probe is Node:
		(probe as Node).queue_free()
	names.sort()
	return names
