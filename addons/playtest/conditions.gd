## Shared Condition descriptor (spec #9, ticket #10): the seam that turns a
## wait spec into the human-readable Condition that timeout messages name —
## CONTEXT.md glossary: "Timeout messages and heartbeat lines name the
## Condition, never just the Selector." Consumed by both projections of the
## wait verbs (dispatch.gd over the wire, playtestcase.gd in-process), and by
## the heartbeat work (ticket #11) which will name the same Condition.
class_name PlaytestConditions
extends RefCounted

## The keys that make up a Condition, in a stable order for JSON output: the
## Selector keys first, then the mode and comparison keys in their natural
## reading order (`property`, `equals` — or `signal`, or `method`, `args`,
## `equals`) — never the wait bookkeeping (cmd/id/timeout_ms/max_frames),
## which callers may well have merged into the same Dictionary (the network
## projection passes the whole request).
const CONDITION_KEYS := ["test_id", "group", "path", "property", "signal", "method", "args", "equals"]

## The Condition as a JSON-safe Dictionary: `spec`'s selector + mode keys,
## values through the Variant→JSON mapping (the same representation the wire
## uses). `spec` may carry extra keys (timeout_ms, max_frames...) — filtered
## out here.
static func condition_dict(spec: Dictionary) -> Dictionary:
	var out := {}
	for key in CONDITION_KEYS:
		if spec.has(key):
			out[key] = PlaytestVariantJson.to_json(spec[key])
	return out

## The `condition: <json>; <mode suffix>` tail appended to timeout messages —
## existing message text stays the prefix, appended so substring parsers
## keep working. `last_value`/`last_error` are what the poll loop last
## observed, carried out of the loop (never re-read at the deadline):
## property mode reports the last value, method mode the last return value,
## signal mode states the signal never fired, and a selector that never
## resolved reports the last error (`last_error` wins — there is no value to
## report). A plain-mode timeout only ever occurs with `last_error` set (the
## selector never resolved), so the bare `condition:` tail is unreachable in
## practice.
static func timeout_tail(spec: Dictionary, mode: String, last_value: Variant, last_error: Dictionary) -> String:
	var tail := "condition: %s" % condition_json(spec)
	if last_error.has("error"):
		return tail + "; last error: %s %s" % [last_error["error"], last_error["detail"]]
	match mode:
		"property":
			return tail + "; last value: %s" % JSON.stringify(last_value)
		"method":
			return tail + "; last return value: %s" % JSON.stringify(last_value)
		"signal":
			return tail + "; signal never fired"
	return tail

## `{"test_id":"...","property":"...",...}` — the Condition rendered as a
## JSON string with the keys in `CONDITION_KEYS` order. Public since spec #9
## ticket #11: the heartbeat lines and the timeout tails both name the
## Condition through this one canonical string. Built key by key rather than
## via `JSON.stringify` of the whole Dictionary: Godot's Dictionary iteration
## order is hash-table order, not insertion order, so a whole-dict stringify
## would emit the keys in an engine-internal order that is not stable across
## versions — while this form is pinned verbatim by the conformance suite.
static func condition_json(spec: Dictionary) -> String:
	var parts := []
	for key in CONDITION_KEYS:
		if spec.has(key):
			parts.append('"%s":%s' % [key, JSON.stringify(PlaytestVariantJson.to_json(spec[key]))])
	return "{%s}" % ",".join(parts)
