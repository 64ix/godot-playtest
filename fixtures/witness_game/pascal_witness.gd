extends Node
## Witness for the C# state contract convention (docs/protocol/DRAFT-v0.md
## §5): Godot exposes C# methods under their PascalCase name, so a C# node
## defines `_TestState()` and never `_test_state()`. This GDScript script
## deliberately defines `_TestState()` alone to verify that the Bridge
## (state.gd) tries both names — same contract, same return shape.

var readiness := "pascal_ready"


func _TestState() -> Dictionary:
	return {"readiness": readiness}
