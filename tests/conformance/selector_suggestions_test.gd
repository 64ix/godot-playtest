## Unit test for the suggestion similarity floor (issue #33):
## `PlaytestSelectors.closest_test_ids` must drop candidates whose edit
## distance to the query is too large relative to the query's length,
## instead of unconditionally returning the N nearest known test-ids.
##
## Pure function tested directly, without a live scene or TCP round-trip:
## `closest_test_ids` only walks a `Node` tree it is handed and returns an
## `Array` of strings.
## Usage: godot --headless --script res://tests/conformance/selector_suggestions_test.gd
extends SceneTree

const Selectors = preload("res://addons/playtest/selectors.gd")
const Dispatch = preload("res://addons/playtest/dispatch.gd")

var _failures: Array[String] = []

func _init() -> void:
	_check_close_typo_is_suggested()
	_check_far_candidate_is_excluded()
	_check_nothing_close_is_empty()
	_check_short_query_floor_rescues_single_typo()
	_check_count_cap_preserved()
	_check_network_and_in_process_paths_agree()

	if _failures.is_empty():
		print("PASS 6/6")
		quit(0)
	else:
		for f in _failures:
			printerr("FAIL: %s" % f)
		quit(1)

## Builds a detached `Node` tree (never added to the live scene tree —
## `all_test_id_nodes`/`resolve_strict` only need `get_children()`) with one
## child per given test-id.
func _make_tree(ids: Array) -> Node:
	var container := Node.new()
	for id in ids:
		var child := Node.new()
		child.set_meta("test_id", id)
		container.add_child(child)
	return container

## Criterion 3: a one-character typo ("score_buttn" vs "score_button", the
## exact case exercised by the runner/scenario/mcp-server suites) must still
## be suggested — the helpful case must not regress.
func _check_close_typo_is_suggested() -> void:
	var container := _make_tree(["score_button", "restart_button", "score_label"])
	var suggestions := Selectors.closest_test_ids(container, "score_buttn")
	_assert("score_button" in suggestions, "one-character typo is suggested", suggestions)
	container.free()

## Criterion 1: a candidate whose edit distance is large relative to the
## query length is excluded, even though it is the closest known id.
func _check_far_candidate_is_excluded() -> void:
	var container := _make_tree(["score_button"])
	var suggestions := Selectors.closest_test_ids(container, "totally_unrelated_widget")
	_assert(suggestions.is_empty(), "a far candidate (no shared structure) is excluded", suggestions)
	container.free()

## Criterion 2: when nothing is close enough, `suggestions` is empty rather
## than filler with the (formerly unconditional) N nearest ids.
func _check_nothing_close_is_empty() -> void:
	var container := _make_tree(["ab", "cd", "ef"])
	var suggestions := Selectors.closest_test_ids(container, "zzzzzzzzzz")
	_assert(suggestions.is_empty(), "no known id close enough -> empty, not filler", suggestions)
	container.free()

## Criterion 6: a plain 40%-of-length ratio floors to 0 on a 1-character
## query, which would silently disable suggestions for short ids; the floor
## of `SUGGESTION_DISTANCE_FLOOR` must rescue a genuine single-character typo.
func _check_short_query_floor_rescues_single_typo() -> void:
	var container := _make_tree(["ok", "xy"])
	var suggestions := Selectors.closest_test_ids(container, "o")
	_assert(
		suggestions == ["ok"],
		"short query typo still suggested thanks to the floor, unrelated id excluded",
		suggestions
	)
	container.free()

## Criterion 7: the existing count cap (`limit`, default 3) still applies
## once several candidates pass the similarity floor.
func _check_count_cap_preserved() -> void:
	var container := _make_tree(
		["score_button_1", "score_button_2", "score_button_3", "score_button_4"]
	)
	var suggestions := Selectors.closest_test_ids(container, "score_button_x")
	_assert(
		suggestions.size() == 3,
		"count cap (limit=3) is preserved even with more close candidates",
		suggestions
	)
	container.free()

## Criterion 4: the threshold must apply identically in the network
## projection and the in-process projection. Both projections' shared
## strict-resolution path (`resolve_strict`, used by dispatch.gd's
## `_resolve_selector` for the network side and by playtestcase.gd for the
## in-process side) and the network `query` verb's own call site
## (dispatch.gd::`_query`) all end up calling the same
## `closest_test_ids` — comparing these two call sites for the same
## tree/query is the cheapest honest evidence that neither diverges, without
## standing up a full in-process `PlaytestCase` or a real TCP round-trip.
func _check_network_and_in_process_paths_agree() -> void:
	var container := _make_tree(["score_button", "restart_button"])
	var strict := Selectors.resolve_strict(container, {"test_id": "score_buttn"})
	var dispatch := Dispatch.new(container)
	var queried: Dictionary = dispatch._query(1, {"test_id": "score_buttn"})
	_assert(
		strict["suggestions"] == queried["suggestions"],
		"resolve_strict (shared path) and dispatch._query (network query verb) agree",
		[strict["suggestions"], queried["suggestions"]]
	)
	container.free()

func _assert(cond: bool, label: String, detail) -> void:
	if cond:
		print("ok: %s" % label)
	else:
		_failures.append("%s (got: %s)" % [label, detail])
