## Per-instance handle to an already-running client the game's own harness
## launched — the GDScript surface's second-client story (spec #66). Backed
## by a hand-rolled TCP JSON-lines client (the in-process mirror of
## `mcp-server/src/bridge-client.ts`; `transport.gd` only implements the
## server half of this protocol, so this class is the client half the addon
## was missing).
##
## Returned once by `PlaytestCase.attach_instance("name")` (see
## playtestcase.gd) — the instance is named where it is born and never
## repeated per verb:
##
##     var b := await attach_instance("b")
##     await b.press({"test_id": "ready_button"})
##     await b.assert_eventually_property({"test_id": "score"}, "text", "1")
##
## `self` stays instance 0, in-process, unchanged — this class only exists
## for instances 1..N (ADR-0008: the connection, not the process, is the
## unit of identity; instance 0's locality is worth more than topology
## symmetry). Naming corollary (ADR-0008): the same verb name means two
## legitimately different strengths of guarantee depending on the call site
## — `press` on `self` emits the signal synchronously, in-process; `press`
## on a handle is a network round trip and therefore a GDScript coroutine
## (`await` is required at every call site here, `input`/`invoke` included —
## unlike `self`, which only needs it for `wait_for`/`time_frames`/the
## asserts).
class_name PlaytestClient
extends RefCounted

const InstanceName = preload("res://addons/playtest/instance_name.gd")

## Env var the harness sets to point at a directory of per-instance
## port-files (filename = instance name, same format `--bridge-port-file`
## writes) — the attach contract (spec #66 §53). The addon never launches
## or relaunches what it reads here; that stays the harness's job
## (ADR-0005/ADR-0008).
const ATTACH_PORTS_ENV := "PLAYTEST_ATTACH_PORTS"

## Bookkeeping shared by every handle created in this runner invocation —
## `static`, so it survives across the disposable `PlaytestCase` instance
## created per `test_*` method (cf. runner.gd): the connection's owning
## PROCESS is launched once by the harness for the whole suite (per-suite
## lifetime, spec #66 §61), so a name attached in one test and again in a
## later one reaches the very same process (state persists across tests —
## a named gotcha, see docs/adr/0008).
##
## - `_dead_instances`: names that already failed to connect, or were found
##   unreachable mid-test — a later test naming them again fails FAST
##   (§61 "named 'instance unavailable'") instead of repeating the same
##   doomed retry/timeout.
## - `_all_handles`: every handle ever created here, so the runner can send
##   a best-effort `quit` to each at the very end of the whole invocation
##   (§53 "the addon sends best-effort quit to what it connected, once, at
##   invocation end").
static var _dead_instances := {}
static var _all_handles: Array = []

var _name: String
var _owner: PlaytestCase
var _peer: StreamPeerTCP = null
var _buffer := ""
var _next_id := 0

## Set by a failed verb/selector call (mirrors `PlaytestCase._aborted`, but
## scoped to THIS handle only): a broken selector or a lost connection stops
## further calls on this same handle, while `self` and every other handle
## keep going — one aggregated report (spec #66 §11).
var _aborted := false

func _init(name: String, owner: PlaytestCase) -> void:
	_name = name
	_owner = owner

## Best-effort `quit` to every attached instance this runner invocation ever
## connected to (spec #66 §53) — never a `kill`: the addon only attached, it
## never launched these processes (ADR-0005/ADR-0008), so it has no
## supervision authority over them; their own harness owns that. Meant to be
## called once, by runner.gd, at the very end of the whole suite invocation.
static func quit_all_attached() -> void:
	for handle in _all_handles:
		var h: PlaytestClient = handle
		if h._peer != null and h._peer.get_status() == StreamPeerTCP.STATUS_CONNECTED:
			h._next_id += 1
			h._peer.put_data((JSON.stringify({"id": h._next_id, "cmd": "quit"}) + "\n").to_utf8_buffer())
	_all_handles.clear()

## Connects this handle: validates the name, reads
## `$PLAYTEST_ATTACH_PORTS/<name>`, polls it (existing retry discipline,
## mirrors `mcp-server/src/launch.ts` `waitForPortFile`), connects the
## socket. Returns `true` on success. On any failure, records a named
## failure on the owning case's aggregated report and marks the instance
## unavailable for the rest of this runner invocation (§61) — never an
## uncaught exception, never a silent skip.
func _connect(port_file_timeout_ms: int = 30000, connect_timeout_ms: int = 10000) -> bool:
	var reason := InstanceName.validate(_name)
	if not reason.is_empty():
		_fail("attach_instance(\"%s\"): %s" % [_name, reason])
		return false
	if _dead_instances.has(_name):
		_fail("attach_instance(\"%s\"): instance unavailable (already failed earlier in this run)" % _name)
		return false

	var dir := OS.get_environment(ATTACH_PORTS_ENV)
	if dir.is_empty():
		_fail(("attach_instance(\"%s\"): %s is not set — the game's own harness must launch " %
			[_name, ATTACH_PORTS_ENV]) + "this instance and point the addon at its port-file directory")
		return false

	var port_file: String = dir.path_join(_name)
	var deadline_ms := Time.get_ticks_msec() + port_file_timeout_ms
	var port := -1
	while port <= 0:
		if FileAccess.file_exists(port_file):
			var f := FileAccess.open(port_file, FileAccess.READ)
			var content := f.get_as_text().strip_edges()
			f.close()
			if content.is_valid_int():
				port = int(content)
		if port <= 0:
			if PlaytestCase._suite_expired:
				# Suite budget exceeded while this attach hung (ADR-0009):
				# silent abort — the runner's expiry line is the report, and
				# this handle stops being usable (the suite is over).
				_aborted = true
				return false
			if Time.get_ticks_msec() >= deadline_ms:
				_fail("attach_instance(\"%s\"): timed out after %dms waiting for port-file '%s'" %
					[_name, port_file_timeout_ms, port_file])
				return false
			await _owner.get_tree().create_timer(0.1).timeout

	_peer = StreamPeerTCP.new()
	_peer.connect_to_host("127.0.0.1", port)
	var conn_deadline := Time.get_ticks_msec() + connect_timeout_ms
	while _peer.get_status() != StreamPeerTCP.STATUS_CONNECTED:
		_peer.poll()
		if _peer.get_status() == StreamPeerTCP.STATUS_ERROR:
			_fail("attach_instance(\"%s\"): connection error to 127.0.0.1:%d" % [_name, port])
			return false
		if PlaytestCase._suite_expired:
			_aborted = true
			return false
		if Time.get_ticks_msec() >= conn_deadline:
			_fail("attach_instance(\"%s\"): timed out connecting to 127.0.0.1:%d" % [_name, port])
			return false
		await _owner.get_tree().process_frame
	_peer.set_no_delay(true)
	_all_handles.append(self)
	return true

## Sends `cmd`+`params` and waits for its correlated response — the
## in-process mirror of `mcp-server/src/bridge-client.ts` `send()`. A dead
## peer, a connection error, or a client-side timeout are all the SAME
## "unavailable" failure tier here: never an uncaught exception, always a
## Dictionary the caller can inspect
## (`{"ok": false, "error": "instance_unavailable", "detail": ...}`).
func _call(cmd: String, params: Dictionary = {}, timeout_ms: int = 10000) -> Dictionary:
	if _aborted or _dead_instances.has(_name):
		return {"ok": false, "error": "instance_unavailable", "detail": "instance '%s' is unavailable" % _name}
	if _peer == null or _peer.get_status() != StreamPeerTCP.STATUS_CONNECTED:
		_fail("connection to instance '%s' is no longer open" % _name)
		return {"ok": false, "error": "instance_unavailable", "detail": "instance '%s' is unavailable" % _name}

	_next_id += 1
	var req := params.duplicate()
	req["id"] = _next_id
	req["cmd"] = cmd
	_peer.put_data((JSON.stringify(req) + "\n").to_utf8_buffer())

	var deadline_ms := Time.get_ticks_msec() + timeout_ms
	while true:
		_peer.poll()
		var status: int = _peer.get_status()
		if status != StreamPeerTCP.STATUS_CONNECTED:
			_fail("connection to instance '%s' closed while waiting for '%s'" % [_name, cmd])
			return {"ok": false, "error": "instance_unavailable", "detail": "instance '%s' is unavailable" % _name}
		var avail: int = _peer.get_available_bytes()
		if avail > 0:
			_buffer += _peer.get_utf8_string(avail)
		var idx: int = _buffer.find("\n")
		if idx != -1:
			var line: String = _buffer.substr(0, idx)
			_buffer = _buffer.substr(idx + 1)
			var parsed = JSON.parse_string(line)
			if typeof(parsed) == TYPE_DICTIONARY:
				return parsed
			return {"ok": false, "error": "bad_json", "detail": "non-JSON line from instance '%s'" % _name}
		if Time.get_ticks_msec() >= deadline_ms:
			_fail("instance '%s' did not answer '%s' within %dms" % [_name, cmd, timeout_ms])
			return {"ok": false, "error": "instance_unavailable", "detail": "instance '%s' timed out" % _name}
		if PlaytestCase._suite_expired:
			# Suite budget exceeded while this round trip hung (ADR-0009):
			# silent abort — the runner's expiry line is the report, and
			# this handle stops being usable (the suite is over). The
			# instance_unavailable tier makes the caller's verb recording
			# skip its own failure entry, keeping the output expiry-only.
			_aborted = true
			return {"ok": false, "error": "instance_unavailable", "detail": "suite budget expired"}
		await _owner.get_tree().process_frame
	return {} # dead trailing return: GDScript rejects a coroutine whose every
	# exit path is a `return` inside `while true` (research/proto-two-client-topology).

## In-process `query` (§4) over the wire: unlike `self.query()`, never fails
## on an ordinary `not_found` (a lone test_id absent) — a query stays a
## snapshot, not an assertion, same rule as `self`. Only the connectivity
## tier (`instance_unavailable`, already recorded once by `_call`) is a real
## failure here.
func query(selector: Dictionary = {}) -> Array:
	var resp := await _call("query", selector)
	if resp.get("ok") != true:
		return []
	return resp.get("nodes", [])

## Strict single-node resolution (§3) over the wire, reusing `wait_for` with
## `timeout_ms: 0` (no dedicated one-shot read on the wire — same trick
## `assert_now_property` already uses, ADR-0006 "no verb explosion").
## Unlike `self.query_one()`, which returns a live in-process `Node`
## reference, this returns the node's serialized description (§5 state
## contract) instead: there is no live `Node` to hand back for a remote
## instance — the honest consequence of this handle being a network client.
func query_one(selector: Dictionary) -> Variant:
	if _aborted:
		return null
	var req := selector.duplicate()
	req["timeout_ms"] = 0
	var resp := await _call("wait_for", req)
	if resp.get("ok") != true:
		_record_verb_failure("query_one(%s)" % [selector], resp)
		return null
	return resp.get("node")

## Semantic activation (§4) over the wire — mirrors `self.press()`.
func press(selector: Dictionary) -> void:
	if _aborted:
		return
	var resp := await _call("act.press", selector)
	if resp.get("ok") != true:
		_record_verb_failure("press(%s)" % [selector], resp)

## Low-level injection (§4) over the wire — mirrors `self.input()`.
func input(params: Dictionary) -> void:
	if _aborted:
		return
	var resp := await _call("act.input", params)
	if resp.get("ok") != true:
		_record_verb_failure("input(%s)" % [params], resp)

## Reflection (§4) over the wire — mirrors `self.invoke()`.
func invoke(selector: Dictionary, method: String, args: Array = []) -> Variant:
	if _aborted:
		return null
	var req := selector.duplicate()
	req["method"] = method
	req["args"] = args
	var resp := await _call("act.invoke", req)
	if resp.get("ok") != true:
		_record_verb_failure("invoke(%s, %s)" % [selector, method], resp)
		return null
	return resp.get("value")

## Asynchronous `wait_for` (§4) over the wire — mirrors `self.wait_for()`.
## `opts` may carry `property`/`equals`, `signal`, `method`/`args`/`equals`,
## and `timeout_ms` (default 5000ms), exactly like the network verb.
func wait_for(selector: Dictionary, opts: Dictionary = {}) -> Variant:
	if _aborted:
		return null
	var req := selector.duplicate()
	for k in opts:
		req[k] = opts[k]
	var timeout_ms: int = int(opts.get("timeout_ms", 5000))
	var resp := await _call("wait_for", req, timeout_ms + 2000)
	if resp.get("ok") != true:
		_record_verb_failure("wait_for(%s)" % [selector], resp)
		return null
	return resp.get("node")

## `time.scale` (§4) over the wire — mirrors `self.time_scale()`. Acts on
## THIS instance's own `Engine.time_scale` only (a separate OS process): no
## synchronized cross-instance step exists, ever (spec #66 §62 — the
## determinism ceiling this tool accepts).
func time_scale(factor: float) -> void:
	if _aborted:
		return
	var resp := await _call("time.scale", {"factor": factor})
	if resp.get("ok") != true:
		_record_verb_failure("time_scale(%s)" % [factor], resp)

## `time.frames` (§4) over the wire — mirrors `self.time_frames()`. Generous
## fixed client-side budget: unlike `wait_for`, the network verb itself
## carries no deadline (the frame count necessarily elapses), so this only
## guards against a genuinely unreachable instance, not a legitimate wait.
func time_frames(n: int, physics: bool = false) -> void:
	if _aborted:
		return
	var resp := await _call("time.frames", {"n": n, "physics": physics}, 30000)
	if resp.get("ok") != true:
		_record_verb_failure("time_frames(%d)" % [n], resp)

## `time.step_until` (§4, ticket #37) over the wire — mirrors
## `self.time_step_until()`. `opts` may carry `property`/`equals`,
## `method`/`args`/`equals`, `max_frames`, and `timeout_ms`, exactly like
## the network verb (`signal` stays rejected by the Bridge itself,
## ADR-0007). Steps THIS instance's own frames only — no synchronized
## cross-instance step, ever (spec #66 §62). Returns `{"node": ...,
## "frames": int}` like `self`, except `node` is the node's serialized
## description (§5), not a live `Node` — same honesty as `query_one`.
## Client-side budget: like `time_frames`, the verb's own frame budget is
## the real deadline, so the generous fixed budget only guards against a
## genuinely unreachable instance — unless the caller set the optional
## `timeout_ms` safety ceiling, which then bounds the wait like `wait_for`.
func time_step_until(selector: Dictionary, opts: Dictionary = {}) -> Dictionary:
	if _aborted:
		return {"node": null, "frames": 0}
	var req := selector.duplicate()
	for k in opts:
		req[k] = opts[k]
	var budget_ms: int = (int(opts["timeout_ms"]) + 2000) if opts.has("timeout_ms") else 30000
	var resp := await _call("time.step_until", req, budget_ms)
	if resp.get("ok") != true:
		_record_verb_failure("time_step_until(%s)" % [selector], resp)
		return {"node": null, "frames": int(resp.get("frames", 0))}
	return {"node": resp.get("node"), "frames": int(resp.get("frames", 0))}

## Short fixed budget for `assert_now_*` (spec #66 criterion): NOT the
## configurable eventual timeout — "now" over a socket means "as of when the
## remote answered", never a retry.
const NOW_BUDGET_MS := 2000

## `assert_now_property` (spec #66): resolve-and-compare EXACTLY ONCE — no
## retry, no polling — like `self.assert_now_property()`, but over a socket:
## a dead peer or dropped connection is its own named failure tier
## (`instance_unavailable`), surfaced here as a named ASSERTION failure,
## never an uncaught exception. Runs even if `_aborted` (mirrors `self`:
## constant cost, `_call`'s own short-circuit keeps it from hanging).
func assert_now_property(selector: Dictionary, property: String, expected: Variant, message: String = "") -> void:
	var req := selector.duplicate()
	req["property"] = property
	req["equals"] = expected
	req["timeout_ms"] = 0
	var resp := await _call("wait_for", req, NOW_BUDGET_MS)
	if resp.get("ok") != true:
		_record_assert_failure("assert_now_property", message, selector, property, expected, resp)

## `assert_eventually_property` (spec #66): retry-until-timeout over the
## wire, mirroring `self.assert_eventually_property()`. Skipped if `_aborted`
## (mirrors `self`: nothing to await from an already-broken selector or a
## known-dead connection).
func assert_eventually_property(selector: Dictionary, property: String, expected: Variant, message: String = "", timeout_ms: int = 2000) -> void:
	if _aborted:
		return
	var req := selector.duplicate()
	req["property"] = property
	req["equals"] = expected
	req["timeout_ms"] = timeout_ms
	var resp := await _call("wait_for", req, timeout_ms + 2000)
	if resp.get("ok") != true:
		_record_assert_failure("assert_eventually_property", message, selector, property, expected, resp)

## Marks this handle (and, for the rest of this runner invocation, the
## instance name it holds) unavailable, and records ONE named failure on the
## owning case's aggregated report — the single choke point every failure
## path above (`_connect`/`_call`) routes through.
func _fail(message: String) -> void:
	_aborted = true
	_dead_instances[_name] = true
	_owner._record_handle_failure(_name, message)

func _record_verb_failure(context: String, resp: Dictionary) -> void:
	# Already recorded once by `_fail` when the connection was found dead —
	# avoid a second, redundant entry for the very same event.
	if resp.get("error") == "instance_unavailable":
		return
	var message := "%s: [%s] %s" % [context, resp.get("error"), resp.get("detail")]
	if resp.has("suggestions") and not (resp["suggestions"] as Array).is_empty():
		message += " (suggestions: %s)" % [resp["suggestions"]]
	if resp.has("candidates") and not (resp["candidates"] as Array).is_empty():
		message += " (candidates: %s)" % [resp["candidates"]]
	_aborted = true
	_owner._record_handle_failure(_name, message)

func _record_assert_failure(kind: String, message: String, selector: Dictionary, property: String, expected: Variant, resp: Dictionary) -> void:
	var detail: String
	if resp.get("error") == "instance_unavailable":
		detail = "instance '%s' unavailable: %s" % [_name, resp.get("detail")]
	else:
		detail = "selector %s.%s: expected %s, got [%s] %s" % [selector, property, expected, resp.get("error"), resp.get("detail")]
	var full := ("%s: %s" % [kind, detail]) if message.is_empty() else ("%s (%s): %s" % [kind, message, detail])
	_owner._record_handle_failure(_name, full)
