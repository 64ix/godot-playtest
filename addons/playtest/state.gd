## Node state description, conforming to the `_test_state()` contract
## (docs/protocol/DRAFT-v0.md §5, `state_contract: 0`).
class_name PlaytestState
extends RefCounted

static func describe(node: Node) -> Dictionary:
	var d := {
		"name": node.name,
		"class": node.get_class(),
		"path": str(node.get_path()),
		"groups": node.get_groups(),
	}
	if node.has_meta("test_id"):
		d["test_id"] = node.get_meta("test_id")
	if node is CanvasItem:
		d["visible"] = node.visible
	if node is Control:
		d["rect"] = [node.global_position.x, node.global_position.y, node.size.x, node.size.y]
	if node is Node2D:
		d["position"] = [node.global_position.x, node.global_position.y]
	elif node is Node3D:
		d["position"] = [node.global_position.x, node.global_position.y, node.global_position.z]
	if node.has_method("get_text"):
		d["text"] = PlaytestVariantJson.to_json(node.get("text"))
	# Domain contract (§5): `_test_state()` in GDScript, `_TestState()` in
	# C# — Godot exposes C# methods under their PascalCase name, so without
	# this second lookup no C# node could publish its domain. If both
	# exist, the canonical snake_case name wins.
	if node.has_method("_test_state"):
		d["state"] = PlaytestVariantJson.to_json(node.call("_test_state"))
	elif node.has_method("_TestState"):
		d["state"] = PlaytestVariantJson.to_json(node.call("_TestState"))
	return d
