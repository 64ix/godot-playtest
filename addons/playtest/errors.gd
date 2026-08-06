## Typed errors of the godot-playtest protocol (docs/protocol/DRAFT-v0.md §3).
##
## Each helper builds a `{"id", "ok": false, "error", ...}` response ready to
## be sent as-is by the transport. Error codes are part of the versioned
## contract: their meaning never changes (additive only).
class_name PlaytestErrors
extends RefCounted

const NOT_FOUND := "not_found"
const AMBIGUOUS := "ambiguous"
const BAD_JSON := "bad_json"
const BAD_REQUEST := "bad_request"
const UNKNOWN_CMD := "unknown_cmd"
const TIMEOUT := "timeout"
const NO_DISPLAY := "no_display"
const NO_RENDERER := "no_renderer"

## Selector that resolves to no node. `suggestions`: closest test-ids
## (helps maintain frozen tests, §3).
static func not_found(id, detail: String, suggestions: Array = []) -> Dictionary:
	return {
		"id": id, "ok": false, "error": NOT_FOUND,
		"detail": detail, "suggestions": suggestions,
	}

## Selector that resolves to several nodes in strict context (§3).
## `candidates`: minimal description (path + test_id) of each node found.
static func ambiguous(id, detail: String, candidates: Array = []) -> Dictionary:
	return {
		"id": id, "ok": false, "error": AMBIGUOUS,
		"detail": detail, "candidates": candidates,
	}

static func bad_json(id) -> Dictionary:
	return {"id": id, "ok": false, "error": BAD_JSON, "detail": "invalid JSON line"}

static func bad_request(id, detail: String) -> Dictionary:
	return {"id": id, "ok": false, "error": BAD_REQUEST, "detail": detail}

static func unknown_cmd(id, cmd: String) -> Dictionary:
	return {
		"id": id, "ok": false, "error": UNKNOWN_CMD,
		"detail": "unknown cmd '%s'" % cmd,
	}

## `wait_for` not resolved before its deadline (§4). Covers both a selector
## that never resolved and a condition (property/signal) never true.
static func timeout(id, detail: String) -> Dictionary:
	return {"id": id, "ok": false, "error": TIMEOUT, "detail": detail}

## `act.input` type "click" (positional) outside `windowed` capability (§6):
## GUI hit-testing is dead in `--headless`, refused early to avoid an engine
## ERROR (spike #5 lesson).
static func no_display(id, detail: String) -> Dictionary:
	return {"id": id, "ok": false, "error": NO_DISPLAY, "detail": detail}

## `screenshot` without a renderer (§6): refused early in `--headless`, never
## an engine ERROR (pitfall documented by spike #5).
static func no_renderer(id, detail: String) -> Dictionary:
	return {"id": id, "ok": false, "error": NO_RENDERER, "detail": detail}
