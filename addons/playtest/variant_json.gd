## Variant -> JSON mapping for the godot-playtest protocol.
##
## Frozen contract documented in docs/protocol/ANNEX-variant-json.md:
## - native JSON types (bool/int/float/String/Array/Dictionary/null): passed as-is.
## - Vector2(i)/Vector3(i)/Color/Rect2(i): encoded as {"$gd": "<Type>", "v": [...]}.
## - any other Variant: {"$gd": "str", "v": var_to_str(value)}.
##
## This annex is part of the versioned contract (`state_contract`): it
## describes how `_test_state()` and node properties travel over JSON.
class_name PlaytestVariantJson
extends RefCounted

static func to_json(value: Variant) -> Variant:
	match typeof(value):
		TYPE_NIL, TYPE_BOOL, TYPE_INT, TYPE_FLOAT, TYPE_STRING:
			return value
		TYPE_STRING_NAME:
			return String(value)
		TYPE_ARRAY:
			var out := []
			for v in (value as Array):
				out.append(to_json(v))
			return out
		TYPE_DICTIONARY:
			var out_dict := {}
			for k in (value as Dictionary).keys():
				out_dict[str(k)] = to_json((value as Dictionary)[k])
			return out_dict
		TYPE_VECTOR2:
			var v2: Vector2 = value
			return {"$gd": "Vector2", "v": [v2.x, v2.y]}
		TYPE_VECTOR2I:
			var v2i: Vector2i = value
			return {"$gd": "Vector2i", "v": [v2i.x, v2i.y]}
		TYPE_VECTOR3:
			var v3: Vector3 = value
			return {"$gd": "Vector3", "v": [v3.x, v3.y, v3.z]}
		TYPE_VECTOR3I:
			var v3i: Vector3i = value
			return {"$gd": "Vector3i", "v": [v3i.x, v3i.y, v3i.z]}
		TYPE_COLOR:
			var c: Color = value
			return {"$gd": "Color", "v": [c.r, c.g, c.b, c.a]}
		TYPE_RECT2:
			var r2: Rect2 = value
			return {"$gd": "Rect2", "v": [r2.position.x, r2.position.y, r2.size.x, r2.size.y]}
		TYPE_RECT2I:
			var r2i: Rect2i = value
			return {"$gd": "Rect2i", "v": [r2i.position.x, r2i.position.y, r2i.size.x, r2i.size.y]}
		_:
			return {"$gd": "str", "v": var_to_str(value)}
