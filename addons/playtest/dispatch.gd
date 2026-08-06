## Dispatch of the godot-playtest protocol verbs (docs/protocol/DRAFT-v0.md §4).
##
## v0 (ticket #8): `hello` and `query` — the "read" half of the protocol.
## Ticket #9: the action verbs (`act.*`, `wait_for`, `time.*`, `screenshot`)
## join the same `match`, with the headless degradation matrix (§6).
## Ticket #20: `quit`, a lifecycle verb — clean shutdown of the driven process,
## instead of an external `kill`/`SIGKILL` (noisy: OS-side crash notification,
## cluttered exit logs).
class_name PlaytestDispatch
extends RefCounted

const PROTOCOL_VERSION := 0
const STATE_CONTRACT_VERSION := 0

## Default frame budget for `time.step_until` (ticket #37) when the request
## omits `max_frames` — ~5s at the common 60 FPS idle rate, the same order of
## magnitude as `wait_for`'s default `timeout_ms` (5000).
const DEFAULT_STEP_UNTIL_MAX_FRAMES := 300

var _root: Node

## Asynchronous requests in flight (`wait_for`, `time.frames`): each entry is
## a Dictionary re-evaluated every frame by `poll()` (§1 "never blocking")
## until resolution or deadline. `peer` travels along so the Bridge knows
## where to send the response, produced out-of-order relative to the
## synchronous requests handled in the meantime (§1, correlation by `id`).
var _pending: Array = []

func _init(root: Node) -> void:
	_root = root

## `req`: already-parsed JSON Dictionary. `peer`: originating StreamPeerTCP,
## required by asynchronous verbs so `poll()` knows where to answer later.
## Returns either a JSON-serializable Dictionary (immediate response, same
## correlation `id` as the request), or `null`: the request is queued and its
## response will be produced by a future call to `poll()`.
func handle(req: Dictionary, peer = null) -> Variant:
	var id = req.get("id")
	# `JSON.parse_string` always returns numbers as TYPE_FLOAT (a limitation of
	# Godot's JSON class): without this recast, `id` would be re-emitted as
	# "1.0" instead of "1", violating the `{"id": <int>, ...}` contract in §2
	# of the protocol.
	if typeof(id) == TYPE_FLOAT:
		id = int(id)
	if not req.has("cmd") or typeof(req["cmd"]) != TYPE_STRING:
		return PlaytestErrors.bad_request(id, "missing or invalid 'cmd'")
	var cmd: String = req["cmd"]
	match cmd:
		"hello":
			return _hello(id)
		"query":
			return _query(id, req)
		"act.press":
			return _act_press(id, req)
		"act.input":
			return _act_input(id, req)
		"act.invoke":
			return _act_invoke(id, req)
		"wait_for":
			return _wait_for(id, req, peer)
		"time.scale":
			return _time_scale(id, req)
		"time.frames":
			return _time_frames(id, req, peer)
		"time.step_until":
			return _step_until(id, req, peer)
		"screenshot":
			return _screenshot(id)
		"quit":
			return _quit(id, req)
		_:
			return PlaytestErrors.unknown_cmd(id, cmd)

## To be called once per frame by the Bridge. Re-evaluates each pending
## request; returns the ones now resolved as
## `[{"peer": ..., "response": ...}, ...]`, to be sent as-is to the transport.
##
## Liveness guard (issue #21): a `peer` whose socket was closed by the client
## while its request was in flight (`wait_for`, `time.frames`) is purged here,
## before any re-evaluation — no point keeping on resolving a condition
## (selector, deadline) for a client that will never read the response, and
## `transport.send` would get a dead peer anyway.
func poll() -> Array:
	var out := []
	var remaining := []
	for entry in _pending:
		if not _peer_alive(entry["peer"]):
			continue
		var result: Variant = null
		if entry["kind"] == "wait_for":
			result = _poll_wait_for(entry)
		elif entry["kind"] == "step_until":
			result = _poll_step_until(entry)
		else:
			result = _poll_frames(entry)
		if result == null:
			remaining.append(entry)
		else:
			out.append({"peer": entry["peer"], "response": result})
	_pending = remaining
	return out

## `peer` is a `StreamPeerTCP` (typed `Variant` here to avoid coupling
## dispatch.gd to this transport type, cf. `_init`/`handle`) already
## `.poll()`-ed this frame by `transport.gd` before the Bridge calls
## `Dispatch.poll()`: its status therefore reflects the current connection
## state.
func _peer_alive(peer) -> bool:
	if peer == null:
		return false
	var st: int = peer.get_status()
	return st != StreamPeerTCP.STATUS_ERROR and st != StreamPeerTCP.STATUS_NONE

func _hello(id) -> Dictionary:
	var capabilities := []
	# Positional click (`act.input` type "click") only exists windowed (§6):
	# the capability is only announced when it is actually actionable, never
	# in `--headless`.
	if DisplayServer.get_name() != "headless":
		capabilities.append("windowed")
	return {
		"id": id, "ok": true,
		"protocol": PROTOCOL_VERSION,
		"state_contract": STATE_CONTRACT_VERSION,
		"engine": Engine.get_version_info().get("string", ""),
		"capabilities": capabilities,
	}

## Selector priority: test-id > group > NodePath > (none = all test-ids).
## test-id and NodePath target a single node (possible "not_found"/"ambiguous"
## errors); group and "no selector" return a list, possibly empty, and never
## fail — implementation decision: `query` remains the equivalent of an
## accessibility snapshot, only a selector that claims to designate a precise
## node can fail.
func _query(id, req: Dictionary) -> Dictionary:
	if req.has("test_id"):
		var test_id: String = String(req["test_id"])
		var matches: Array = PlaytestSelectors.find_by_test_id(_root, test_id)
		if matches.is_empty():
			var suggestions := PlaytestSelectors.closest_test_ids(_root, test_id)
			return PlaytestErrors.not_found(id, "no node with test_id '%s'" % test_id, suggestions)
		if matches.size() > 1:
			var candidates := []
			for n in matches:
				candidates.append({"path": str(n.get_path()), "test_id": test_id})
			return PlaytestErrors.ambiguous(
				id, "test_id '%s' matches %d nodes" % [test_id, matches.size()], candidates)
		return {"id": id, "ok": true, "nodes": [PlaytestState.describe(matches[0])]}

	if req.has("group"):
		var nodes: Array = PlaytestSelectors.nodes_in_group(_root, String(req["group"]))
		return {"id": id, "ok": true, "nodes": _describe_all(nodes)}

	if req.has("path"):
		var node := PlaytestSelectors.find_by_path(_root, String(req["path"]))
		if node == null:
			return PlaytestErrors.not_found(id, "no node at path '%s'" % req["path"])
		return {"id": id, "ok": true, "nodes": [PlaytestState.describe(node)]}

	# No selector: all nodes carrying a test_id.
	return {"id": id, "ok": true, "nodes": _describe_all(PlaytestSelectors.all_test_id_nodes(_root))}

func _describe_all(nodes: Array) -> Array:
	var out := []
	for n in nodes:
		out.append(PlaytestState.describe(n))
	return out

## Strict resolution of a selector (test_id/group/path) for the action verbs
## and `wait_for` (§3, strict mode): delegates to `PlaytestSelectors.
## resolve_strict`, shared with the in-process projection (playtestcase.gd,
## ticket #11, §1.5 "two projections, one API"), then translates the generic
## result into a typed JSON response (errors.gd).
## Returns `{"node": Node}` or `{"error": Dictionary}` (error response ready
## to be returned as-is).
func _resolve_selector(id, req: Dictionary) -> Dictionary:
	var res := PlaytestSelectors.resolve_strict(_root, req)
	if res.has("node"):
		return res
	match res["error"]:
		"not_found":
			return {"error": PlaytestErrors.not_found(id, res["detail"], res.get("suggestions", []))}
		"ambiguous":
			return {"error": PlaytestErrors.ambiguous(id, res["detail"], res.get("candidates", []))}
		_:
			return {"error": PlaytestErrors.bad_request(id, res["detail"])}

## Semantic activation of a Control via the signal route (§4): never any
## hit-testing, so it works in `--headless` (spike #5 lesson). The only
## required contract is a "pressed" signal (Button, CheckBox, CheckButton…);
## a node that doesn't expose one — or that isn't a Control — is a
## "bad_request": `act.press` never guesses a fallback action.
func _act_press(id, req: Dictionary) -> Dictionary:
	var res := _resolve_selector(id, req)
	if res.has("error"):
		return res["error"]
	var node: Node = res["node"]
	if not (node is Control):
		return PlaytestErrors.bad_request(id, "act.press target must be a Control")
	if not node.has_signal("pressed"):
		return PlaytestErrors.bad_request(id, "node has no 'pressed' signal")
	node.emit_signal("pressed")
	return {"id": id, "ok": true}

## Low-level injection (§4). `action`/`key` work everywhere (headless
## included); `click` (positional) requires the `windowed` capability and
## refuses cleanly (`no_display`) before any engine call in headless — the
## engine call itself would produce an ERROR instead of a clean refusal
## (spike #5).
func _act_input(id, req: Dictionary) -> Dictionary:
	if not req.has("type") or typeof(req["type"]) != TYPE_STRING:
		return PlaytestErrors.bad_request(id, "missing or invalid 'type'")
	var t: String = req["type"]
	match t:
		"action":
			if not req.has("action"):
				return PlaytestErrors.bad_request(id, "missing 'action'")
			var action_name: String = String(req["action"])
			var pressed: bool = bool(req.get("pressed", true))
			if pressed:
				Input.action_press(action_name, float(req.get("strength", 1.0)))
			else:
				Input.action_release(action_name)
			return {"id": id, "ok": true}
		"key":
			if not req.has("keycode"):
				return PlaytestErrors.bad_request(id, "missing 'keycode'")
			var ev := InputEventKey.new()
			ev.keycode = int(req["keycode"])
			ev.pressed = bool(req.get("pressed", true))
			Input.parse_input_event(ev)
			return {"id": id, "ok": true}
		"click":
			if DisplayServer.get_name() == "headless":
				return PlaytestErrors.no_display(
					id, "act.input type 'click' requires the 'windowed' capability (no display)")
			if not req.has("position"):
				return PlaytestErrors.bad_request(id, "missing 'position'")
			var pos: Array = req["position"]
			var ev2 := InputEventMouseButton.new()
			ev2.position = Vector2(float(pos[0]), float(pos[1]))
			ev2.button_index = int(req.get("button", MOUSE_BUTTON_LEFT))
			ev2.pressed = bool(req.get("pressed", true))
			Input.parse_input_event(ev2)
			return {"id": id, "ok": true}
		_:
			return PlaytestErrors.bad_request(id, "unknown act.input type '%s'" % t)

## Reflection, the deliberate escape hatch (§4): calls `method` on the
## resolved node with `args`, returns the value via the frozen Variant→JSON
## mapping (variant_json.gd). A missing method is a "not_found" — the
## selector did resolve a node, but the node can't honor the request.
func _act_invoke(id, req: Dictionary) -> Dictionary:
	var res := _resolve_selector(id, req)
	if res.has("error"):
		return res["error"]
	var node: Node = res["node"]
	if not req.has("method") or typeof(req["method"]) != TYPE_STRING:
		return PlaytestErrors.bad_request(id, "missing 'method'")
	var method: String = req["method"]
	if not node.has_method(method):
		return PlaytestErrors.not_found(id, "node '%s' has no method '%s'" % [str(node.get_path()), method])
	var args: Array = req.get("args", [])
	var result: Variant = node.callv(method, args)
	return {"id": id, "ok": true, "value": PlaytestVariantJson.to_json(result)}

## Registers a pending `wait_for` (§1, §4): never blocking, re-evaluated by
## `poll()` every frame until the condition is met or the deadline is
## reached. An "ambiguous" or missing selector is an immediate error (nothing
## to wait for); "not_found" keeps waiting — the node may appear later
## (dynamic spawn) — until it expires as "timeout".
func _wait_for(id, req: Dictionary, peer) -> Variant:
	if not (req.has("test_id") or req.has("group") or req.has("path")):
		return PlaytestErrors.bad_request(id, "wait_for requires a selector")
	var timeout_ms: int = int(req.get("timeout_ms", 5000))
	var entry := {
		"id": id, "peer": peer, "kind": "wait_for",
		"selector": req,
		"deadline_ms": Time.get_ticks_msec() + timeout_ms,
		"timeout_ms": timeout_ms,
		"connected": false, "fired": false,
	}
	if req.has("signal"):
		entry["mode"] = "signal"
		entry["signal"] = String(req["signal"])
	elif req.has("property"):
		entry["mode"] = "property"
		entry["property"] = String(req["property"])
		entry["equals"] = req.get("equals")
	elif req.has("method"):
		# Parameterized domain query (§4): re-calls `method(args)` on the
		# resolved node every frame until the return value equals `equals` —
		# the same reflection escape hatch as `act.invoke`, but while waiting.
		# The method MUST be a pure read: it is called every frame.
		entry["mode"] = "method"
		entry["method"] = String(req["method"])
		entry["args"] = req.get("args", [])
		entry["equals"] = req.get("equals")
	else:
		entry["mode"] = "plain"
	_pending.append(entry)
	return null

## Shared by `_poll_wait_for` and `_poll_step_until`: resolves `entry`'s
## selector and evaluates its condition (`plain`/`property`/`method`/
## `signal` mode — `signal` is only ever set on a `wait_for` entry, `_step_until`
## never registers it). Returns `{"error": Dictionary}` for an immediate
## failure (ambiguous/bad_request selector, or a missing method/signal — none
## of which resolve themselves with more time or more steps), `{"node": Node}`
## once the condition is met, or `{}` while it isn't yet (including a
## "not_found" selector, which may still resolve later).
##
## Side effects on `entry` (spec #9, ticket #10): the last observation is
## carried out of the poll loop so a timeout can name it — `last_value` in
## property/method mode, `last_error` while the selector stays unresolved
## (cleared again once it resolves, so the two never conflict). No re-read at
## the deadline.
func _check_condition(entry: Dictionary) -> Dictionary:
	var sel_res := _resolve_selector(entry["id"], entry["selector"])
	if sel_res.has("error"):
		var err: Dictionary = sel_res["error"]
		if err["error"] == PlaytestErrors.AMBIGUOUS or err["error"] == PlaytestErrors.BAD_REQUEST:
			return {"error": err}
		entry["last_error"] = {"error": err["error"], "detail": err["detail"]}
		return {}
	var node: Node = sel_res["node"]
	entry["last_error"] = {}
	match entry["mode"]:
		"plain":
			return {"node": node}
		"property":
			var actual = PlaytestVariantJson.to_json(node.get(entry["property"]))
			entry["last_value"] = actual
			if actual == entry["equals"]:
				return {"node": node}
		"method":
			if not node.has_method(entry["method"]):
				return {"error": PlaytestErrors.bad_request(
					entry["id"], "node has no method '%s'" % entry["method"])}
			var value = PlaytestVariantJson.to_json(node.callv(entry["method"], entry["args"]))
			entry["last_value"] = value
			if value == entry["equals"]:
				return {"node": node}
		"signal":
			if not entry["connected"]:
				if not node.has_signal(entry["signal"]):
					return {"error": PlaytestErrors.bad_request(
						entry["id"], "node has no signal '%s'" % entry["signal"])}
				var entry_ref := entry
				node.connect(entry["signal"], func(): entry_ref["fired"] = true, CONNECT_ONE_SHOT)
				entry["connected"] = true
			if entry["fired"]:
				return {"node": node}
	return {}

func _poll_wait_for(entry: Dictionary) -> Variant:
	var res := _check_condition(entry)
	if res.has("error"):
		return res["error"]
	if res.has("node"):
		return {"id": entry["id"], "ok": true, "node": PlaytestState.describe(res["node"])}
	if Time.get_ticks_msec() >= entry["deadline_ms"]:
		return PlaytestErrors.timeout(
			entry["id"],
			"wait_for timed out after %dms — %s" % [
				entry["timeout_ms"],
				PlaytestConditions.timeout_tail(entry["selector"], entry["mode"],
					entry.get("last_value"), entry.get("last_error", {})),
			])
	return null

## Registers a pending `time.step_until` (ticket #37, §4): deterministic
## sibling of `wait_for` — reuses the same non-blocking pending/poll queue
## (`_pending`/`poll()`) and the same condition vocabulary minus `signal`
## (a one-shot event doesn't fit a budget expressed in frames rather than "did
## it fire between two evaluations" — see
## docs/adr/0007-time-step-until-as-a-new-verb.md): plain presence,
## `property`+`equals`, or the parameterized `method`+`args`+`equals` domain
## query (identical semantics to `_wait_for`'s corresponding modes). The
## budget is primarily `max_frames` (the deterministic axis, re-evaluated on
## every `Dispatch.poll()` — i.e. once per idle frame, cf. `bridge.gd
## _process`); the optional `timeout_ms` is a wall-clock **safety net only**,
## never the intended way to bound a deterministic scenario.
func _step_until(id, req: Dictionary, peer) -> Variant:
	if not (req.has("test_id") or req.has("group") or req.has("path")):
		return PlaytestErrors.bad_request(id, "time.step_until requires a selector")
	if req.has("signal"):
		return PlaytestErrors.bad_request(
			id, "time.step_until does not support 'signal' mode — use wait_for to wait on a one-shot signal")
	if req.has("max_frames") and int(req["max_frames"]) < 0:
		return PlaytestErrors.bad_request(id, "time.step_until requires max_frames >= 0")
	var entry := {
		"id": id, "peer": peer, "kind": "step_until",
		"selector": req,
		"start_frame": Engine.get_process_frames(),
		"max_frames": int(req.get("max_frames", DEFAULT_STEP_UNTIL_MAX_FRAMES)),
		"deadline_ms": (Time.get_ticks_msec() + int(req["timeout_ms"])) if req.has("timeout_ms") else -1,
	}
	if req.has("property"):
		entry["mode"] = "property"
		entry["property"] = String(req["property"])
		entry["equals"] = req.get("equals")
	elif req.has("method"):
		entry["mode"] = "method"
		entry["method"] = String(req["method"])
		entry["args"] = req.get("args", [])
		entry["equals"] = req.get("equals")
	else:
		entry["mode"] = "plain"
	_pending.append(entry)
	return null

## Re-evaluated every frame like `_poll_wait_for`, with two divergences:
## frames elapsed since registration (`Engine.get_process_frames() -
## start_frame`, immune to wall-clock jitter — the whole point of ticket #37)
## is the primary budget; `deadline_ms` (`-1` = no ms ceiling was requested)
## is only a secondary safety net. Both a success and a `timeout` response
## carry `frames`: the number of engine frames elapsed at resolution — what a
## caller (or a test) checks to verify the resolution is frame-deterministic,
## never wall-clock-dependent.
func _poll_step_until(entry: Dictionary) -> Variant:
	var elapsed: int = Engine.get_process_frames() - entry["start_frame"]
	var res := _check_condition(entry)
	if res.has("error"):
		return res["error"]
	if res.has("node"):
		return {"id": entry["id"], "ok": true, "node": PlaytestState.describe(res["node"]), "frames": elapsed}
	if elapsed >= entry["max_frames"]:
		var budget_err := PlaytestErrors.timeout(
			entry["id"],
			"time.step_until exhausted its frame budget (max_frames=%d) after %d frame(s) — %s" % [
				entry["max_frames"], elapsed,
				PlaytestConditions.timeout_tail(entry["selector"], entry["mode"],
					entry.get("last_value"), entry.get("last_error", {})),
			])
		budget_err["frames"] = elapsed
		return budget_err
	if entry["deadline_ms"] >= 0 and Time.get_ticks_msec() >= entry["deadline_ms"]:
		var ceiling_err := PlaytestErrors.timeout(
			entry["id"],
			"time.step_until exceeded its 'timeout_ms' safety ceiling after %d frame(s) — %s" % [
				elapsed,
				PlaytestConditions.timeout_tail(entry["selector"], entry["mode"],
					entry.get("last_value"), entry.get("last_error", {})),
			])
		ceiling_err["frames"] = elapsed
		return ceiling_err
	return null

## Fast-forward (§4): acts directly on `Engine.time_scale`, immediate
## response (unlike `time.frames`, `time.scale` changes nothing until frames
## actually elapse).
func _time_scale(id, req: Dictionary) -> Dictionary:
	Engine.time_scale = float(req.get("factor", 1.0))
	return {"id": id, "ok": true}

## Fine-grained synchronization (§4): responds after `n` frames (idle or
## physics) have actually elapsed. Always resolves deterministically (no
## deadline: unlike `wait_for`, there is no game condition that might never
## become true).
func _time_frames(id, req: Dictionary, peer) -> Variant:
	var n: int = int(req.get("n", 0))
	var physics: bool = bool(req.get("physics", false))
	if n <= 0:
		return {"id": id, "ok": true}
	var current: int = Engine.get_physics_frames() if physics else Engine.get_process_frames()
	_pending.append({
		"id": id, "peer": peer, "kind": "frames",
		"physics": physics, "target": current + n,
	})
	return null

func _poll_frames(entry: Dictionary) -> Variant:
	var current: int = Engine.get_physics_frames() if entry["physics"] else Engine.get_process_frames()
	if current >= entry["target"]:
		return {"id": entry["id"], "ok": true}
	return null

## Best-effort, never an oracle (§1, §4): refuses cleanly in headless
## (`no_renderer`) before any engine call — calling `get_texture()` without a
## renderer would produce an ERROR instead of a clean refusal (spike #5).
func _screenshot(id) -> Dictionary:
	if DisplayServer.get_name() == "headless":
		return PlaytestErrors.no_renderer(id, "no renderer available in headless mode")
	var image: Image = _root.get_texture().get_image()
	var png: PackedByteArray = image.save_png_to_buffer()
	return {"id": id, "ok": true, "image_base64": Marshalls.raw_to_base64(png)}

## Clean shutdown of the driven process (ticket #20, §4): asks `SceneTree` to
## quit (exit code `code`, 0 by default — a requested shutdown is not a
## crash). `SceneTree.quit()` only terminates the process at the end of the
## current frame (the engine drains its loop before exiting): this response
## is already written to the socket by `bridge.gd` before the process stops,
## so the client observes a clean acknowledgement before the disconnect —
## never an external `kill`/`SIGKILL`, which is noisy (OS-side crash
## notification, cluttered exit logs, cf. dogfooding/FRICTIONS.md #4).
func _quit(id, req: Dictionary) -> Dictionary:
	var code: int = int(req.get("code", 0))
	_root.get_tree().quit(code)
	return {"id": id, "ok": true}
