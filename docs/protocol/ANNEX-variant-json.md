# Annex — Variant → JSON mapping

> Part of the protocol's versioned contract (docs/protocol/DRAFT-v0.md §4/§5).
> Every evolution is additive: a type once mapped never changes encoding.
> Reference implementation: `addons/playtest/variant_json.gd`.

The Bridge must serialize GDScript values (`Variant`) over a
JSON-lines connection. Three families:

## 1. Native JSON types — as-is

`bool`, `int`, `float`, `String` (and `StringName`, converted to `String`),
`Array`, `Dictionary` (keys converted to `String`), `null`. No wrapper.

## 2. Geometric/color types — wrapped `{"$gd": "<Type>", "v": [...]}`

| Godot type | `$gd` | `v` |
|---|---|---|
| `Vector2` | `"Vector2"` | `[x, y]` |
| `Vector2i` | `"Vector2i"` | `[x, y]` |
| `Vector3` | `"Vector3"` | `[x, y, z]` |
| `Vector3i` | `"Vector3i"` | `[x, y, z]` |
| `Color` | `"Color"` | `[r, g, b, a]` (0..1) |
| `Rect2` | `"Rect2"` | `[position.x, position.y, size.x, size.y]` |
| `Rect2i` | `"Rect2i"` | `[position.x, position.y, size.x, size.y]` |

Example: `Vector2(50, 200)` → `{"$gd": "Vector2", "v": [50, 200]}`.

## 3. Fallback — any other Variant

Any Variant not listed above (`Object`, `NodePath`, `Basis`, `Transform2D`,
`Transform3D`, `Plane`, `Quaternion`, `Signal`, `Callable`, `RID`, custom
resources, ...) is serialized via `var_to_str()` and wrapped:

```json
{"$gd": "str", "v": "<result of var_to_str(value)>"}
```

This is the accepted escape hatch (same spirit as `act.invoke`, §4): a client
loses structure but never loses the information, and can always
display/log the value.

### Special case: coroutine return value (`act.invoke`)

A method compiled as a coroutine by GDScript (it contains an `await`,
even in a single branch — whether annotated `@rpc(...)` or not) hasn't
finished executing by the time the direct call (`callv`, what `act.invoke`
does, outside the RPC registry) returns: the immediate value is not the
expected business result but a `GDScriptFunctionState`, the object
representing the suspended coroutine. This Variant falls into the fallback
above and is therefore serialized as `{"$gd": "str", "v": "Object(GDScriptFunctionState,...)"}`
(the exact detail of `v` depends on `var_to_str()` and the Godot version)
— never the method's final value. This isn't a bug in
`variant_json.gd`: it's the execution itself that hasn't finished.

**Never check the effect of an `act.invoke` on a coroutine via its
return value**: go through `assert_eventually_property`/`wait_for` (§4/§7) on
a domain property the coroutine eventually modifies, once it has
actually progressed. Encountered during dogfooding on
`red_robot.gd hit()` (`@rpc("call_local")`, `await get_tree().create_timer(...).timeout` in
the "death" branch) — see `dogfooding/FRICTIONS.md` #3.

## Where this mapping applies

- The `state` field of a node description (`_test_state()`, §5), recursively
  across the whole returned Dictionary.
- The `text` field of a node description, if it isn't already a `String`.
- The return value of `act.invoke` (`return`, from ticket #9 onward): an arbitrary
  method return value goes through this same mapping.

This mapping does **not** apply to the fixed structural fields of the
node description (`name`, `class`, `path`, `groups`, `visible`, `rect`,
`position`): these are native JSON arrays/scalars by construction
(coordinates already extracted as `float`).
