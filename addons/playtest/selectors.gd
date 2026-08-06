## Selector resolution for the godot-playtest protocol (docs/protocol/DRAFT-v0.md §3).
##
## Three levels, from most stable to most fragile: test-id > group > NodePath.
## This module only knows the scene tree; the dispatch decides how to turn
## an ambiguous or empty resolution into a typed error (errors.gd).
class_name PlaytestSelectors
extends RefCounted

## All nodes carrying the "test_id" meta, across the whole tree.
static func all_test_id_nodes(root: Node) -> Array:
	var out := []
	var stack: Array = [root]
	while not stack.is_empty():
		var n: Node = stack.pop_back()
		if n.has_meta("test_id"):
			out.append(n)
		for child in n.get_children():
			stack.append(child)
	return out

## All nodes carrying `test_id == value` (normally 0 or 1; >1 = "ambiguous"
## error left to the dispatch to handle).
static func find_by_test_id(root: Node, value: String) -> Array:
	var out := []
	for n in all_test_id_nodes(root):
		if String(n.get_meta("test_id")) == value:
			out.append(n)
	return out

static func nodes_in_group(root: Node, group: String) -> Array:
	return root.get_tree().get_nodes_in_group(group) if root.is_inside_tree() else []

## NodePath resolution. Protocol paths are expressed from "/root/...",
## whereas `root` passed here is already the SceneTree's root node.
static func find_by_path(root: Node, path: String) -> Node:
	var p := path
	if p.begins_with("/root/"):
		p = p.substr(6)
	elif p == "/root":
		p = "."
	if p.is_empty():
		return root
	return root.get_node_or_null(NodePath(p))

## Strict resolution of a selector (test_id/group/path) to **one** node —
## shared between the protocol's two projections (§1.5 "two projections,
## one API"): the network projection (dispatch.gd `_resolve_selector`, for
## `act.*`/`wait_for`) and the in-process projection (playtestcase.gd, for
## frozen tests). Unlike `query`, a `group` matching several nodes is an
## "ambiguous" error (§3, strict mode) — an action always targets *one*
## node, never "the first one found".
##
## Returns `{"node": Node}` on success, or on failure a generic error
## (encoding-independent):
##   `{"error": "not_found", "detail": String, "suggestions": Array}` (test_id not found),
##   `{"error": "not_found", "detail": String}` (empty group / path not found),
##   `{"error": "ambiguous", "detail": String, "candidates": Array}`,
##   `{"error": "bad_request", "detail": String}` (missing selector).
## Each projection translates this generic result into its own encoding
## (JSON response for dispatch.gd, test failure with dump for playtestcase.gd).
static func resolve_strict(root: Node, selector: Dictionary) -> Dictionary:
	if selector.has("test_id"):
		var test_id: String = String(selector["test_id"])
		var matches: Array = find_by_test_id(root, test_id)
		if matches.is_empty():
			var suggestions := closest_test_ids(root, test_id)
			return {
				"error": "not_found",
				"detail": "no node with test_id '%s'" % test_id,
				"suggestions": suggestions,
			}
		if matches.size() > 1:
			var candidates := []
			for n in matches:
				candidates.append({"path": str(n.get_path()), "test_id": test_id})
			return {
				"error": "ambiguous",
				"detail": "test_id '%s' matches %d nodes" % [test_id, matches.size()],
				"candidates": candidates,
			}
		return {"node": matches[0]}

	if selector.has("group"):
		var group: String = String(selector["group"])
		var nodes: Array = nodes_in_group(root, group)
		if nodes.is_empty():
			return {"error": "not_found", "detail": "group '%s' has no nodes" % group}
		if nodes.size() > 1:
			var candidates := []
			for n in nodes:
				candidates.append({"path": str(n.get_path())})
			return {
				"error": "ambiguous",
				"detail": "group '%s' matches %d nodes" % [group, nodes.size()],
				"candidates": candidates,
			}
		return {"node": nodes[0]}

	if selector.has("path"):
		var node := find_by_path(root, String(selector["path"]))
		if node == null:
			return {"error": "not_found", "detail": "no node at path '%s'" % selector["path"]}
		return {"node": node}

	return {"error": "bad_request", "detail": "missing selector (test_id, group or path)"}

## Similarity floor (issue #33): a candidate only qualifies as a suggestion
## when its Levenshtein distance to the query is within this ratio of the
## query's length, so a confidently-wrong "did you mean X?" never appears
## for a query that shares almost nothing with the closest known test-id.
## `SUGGESTION_DISTANCE_FLOOR` keeps the ratio from rounding down to 0 on
## very short ids (e.g. a 2-character query), so a genuine single-character
## typo still qualifies regardless of id length.
const SUGGESTION_DISTANCE_RATIO := 0.4
const SUGGESTION_DISTANCE_FLOOR := 1

## The `limit` known test-ids closest to `value` (Levenshtein distance),
## to populate `suggestions` on a "not_found" error. Candidates whose
## distance exceeds the similarity floor above are dropped entirely — an
## empty array is returned rather than filler when nothing is close enough.
static func closest_test_ids(root: Node, value: String, limit: int = 3) -> Array:
	var threshold: int = max(
		SUGGESTION_DISTANCE_FLOOR, int(SUGGESTION_DISTANCE_RATIO * value.length())
	)
	var known := []
	for n in all_test_id_nodes(root):
		var candidate := String(n.get_meta("test_id"))
		var distance := _levenshtein(value, candidate)
		if distance <= threshold:
			known.append([distance, candidate])
	known.sort_custom(func(a, b): return a[0] < b[0])
	var out := []
	for i in range(min(limit, known.size())):
		out.append(known[i][1])
	return out

static func _levenshtein(a: String, b: String) -> int:
	var la := a.length()
	var lb := b.length()
	if la == 0:
		return lb
	if lb == 0:
		return la
	var prev := []
	for j in range(lb + 1):
		prev.append(j)
	for i in range(1, la + 1):
		var cur := [i]
		for j in range(1, lb + 1):
			var cost := 0 if a[i - 1] == b[j - 1] else 1
			cur.append(min(min(cur[j - 1] + 1, prev[j] + 1), prev[j - 1] + cost))
		prev = cur
	return prev[lb]
