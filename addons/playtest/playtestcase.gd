## PlaytestCase: in-process projection of the protocol verbs
## (docs/protocol/DRAFT-v0.md §1.5, §7 — ticket #11).
##
## A hand-written frozen test extends this class and lives in
## `res://playtests/`, replayed by the addon's runner (`runner.gd`) with no
## network and no AI:
##
##     extends PlaytestCase
##
##     func test_score_button_increments() -> void:
##         await start_game("res://main.tscn")
##         var label := query_one({"test_id": "score_label"})
##         await assert_now_eq(label.text, "0")
##         press({"test_id": "score_button"})
##         # Recommended canonical form (§7 "retry-until-timeout"): re-resolves
##         # the selector and re-reads the property until it succeeds or times out.
##         await assert_eventually_property({"test_id": "score_label"}, "text", "1")
##
## Same selectors as the network projection (dispatch.gd): test-id > group >
## NodePath, strict mode (`ambiguous`), asynchronous `wait_for`, rich
## diagnostics (`not_found` + suggestions) — but NOT identical semantics
## everywhere it matters (ADR-0006): `assert_now_*` runs even after a
## selector failure, while `assert_eventually_*` is skipped once one has
## occurred (see the `_aborted` note below) — a stated rule, not an
## accident. Selector resolution itself is shared via
## `PlaytestSelectors.resolve_strict` (see selectors.gd) — only the
## encoding of the result differs: here, a resolution failure becomes a
## report entry (`failures`), not a JSON response.
class_name PlaytestCase
extends Node

const Selectors = preload("res://addons/playtest/selectors.gd")
const State = preload("res://addons/playtest/state.gd")

## Root node of the game scene started by `start_game()` — serves as the
## selector resolution root (§3), like `get_tree().root` on the dispatch.gd
## side (network projection). As long as no scene has been started, the
## resolution root falls back to `get_tree().root` (useful to test against an
## already-present scene, e.g. the runner itself under test).
var _game_root: Node = null

## Report of the last executed test method: a list of
## `{"message": String, "detail": Dictionary, "query_dump": Array}` — §7:
## "a failure carries a full query dump in the report". The runner reads
## this array after each `test_*` then clears it for the next one.
var failures: Array = []

## Set to `true` as soon as a selector (query_one/press/invoke/wait_for) has
## failed to resolve: subsequent calls to these same primitives become
## no-ops rather than stacking cascading failures on an already-compromised
## test. Implementation decision: see
## addons/playtest/README.md "PlaytestCase: failures and early stop".
##
## `assert_now_*`/`assert_eventually_*` (ADR-0006 "surviving asymmetry, now
## legitimate because it is named") deliberately disagree on this flag:
## `assert_now_*` runs even after it is set (constant cost, cannot hang —
## several independent failures are worth more than one); `assert_eventually_*`
## skips its retry loop entirely once it is set (nothing to await from a
## getter referencing an already-broken selector, otherwise `timeout_ms`
## would be burned per assertion for nothing).
var _aborted := false

func _resolution_root() -> Node:
	if _game_root != null:
		return _game_root
	return get_tree().root

## Resets the report state before running a `test_*` method — called by the
## runner, not by the test itself.
func _reset_report() -> void:
	failures = []
	_aborted = false

## Instantiates and starts the game scene under test, mounting it as a direct
## child of `get_tree().root` — where the live projection's dispatch.gd
## resolves selectors from (see bridge.gd `Dispatch.new(get_tree().root)`),
## so a frozen replay sees the same tree shape as the live scenario it was
## frozen from (ADR-0006). A direct `add_child()` on the root fails here
## ("Parent node is busy setting up children") because the runner is still
## inside its own `_ready()`; the deferred form works and yields `/root/Main`.
## It costs no idle frame over the previous mount — both forms await exactly
## one process frame here, so a one-shot assertion right after `start_game()`
## reads the same state as before (see "Frame-timing contract" in
## addons/playtest/README.md for what that state is).
func start_game(scene_path: String) -> Node:
	var packed: PackedScene = load(scene_path)
	_game_root = packed.instantiate()
	get_tree().root.add_child.call_deferred(_game_root)
	await get_tree().process_frame
	return _game_root

## The game is now mounted under `get_tree().root`, a sibling of this case
## rather than its child, so freeing the case no longer cascades to it
## (ADR-0006: "the addon owns the teardown of what it mounted"). The runner's
## existing "remove the case, free it" sequence triggers this like any other
## exit-tree notification — no paired change needed on the runner side.
## `remove_child` first, then `queue_free`: a bare `queue_free()` only
## schedules deletion for later, so the node would still be sitting under
## `get_tree().root` (occupying its name, e.g. "Main") when the next
## `test_*` method's `start_game()` mounts there — forcing Godot to
## auto-rename the new instance and reintroducing the very fidelity gap
## this ticket fixes. Detaching synchronously here closes that window.
##
## The `parent` guard is load-bearing, because the addon owns the teardown but
## not the game: a game that transitions scene or returns to a menu detaches
## itself mid-test, and teardown must stay quiet about that rather than raise
## a script error over the test's own report — it still owns the freeing.
## A game that freed *itself* needs no extra guard: Godot compares a freed
## reference equal to `null`, so the check below already covers it (verified on
## 4.6.3; `tests/runner/fixtures/self_freeing_game/` pins both halves).
func _exit_tree() -> void:
	if _game_root != null:
		var parent := _game_root.get_parent()
		if parent != null:
			parent.remove_child(_game_root)
		_game_root.queue_free()
		_game_root = null

## Attaches to a named, already-running client the game's own harness
## launched (spec #66) — the GDScript surface's second-client story.
## `self` stays instance 0, in-process, unchanged; every further instance is
## a `PlaytestClient` handle returned once here, exposing the per-instance
## verb surface over a hand-rolled TCP JSON-lines client (see
## playtest_client.gd). The addon never launches or relaunches this
## process (ADR-0005/ADR-0008): reads `$PLAYTEST_ATTACH_PORTS/<name>` (same
## port-file format `--bridge-port-file` writes), polls it with the same
## retry discipline as `launch_game`, connects.
##
## A dead/unreachable instance is a NAMED FAILURE on this case's aggregated
## report, never a silent skip and never an uncaught exception: this always
## returns a handle (never `null`), whose further calls become no-ops once
## the attach itself failed — same "targeted early stop" spirit as
## `_aborted` above, but scoped to this one handle so `self` and every
## other instance keep going (spec #66 §11).
func attach_instance(name: String, port_file_timeout_ms: int = 30000, connect_timeout_ms: int = 10000) -> PlaytestClient:
	var handle := PlaytestClient.new(name, self)
	await handle._connect(port_file_timeout_ms, connect_timeout_ms)
	return handle

## In-process equivalent of `query` (§4): with no selector, all nodes with a
## test_id; with `group`/`path`, the matching list — never a failure, `query`
## stays a snapshot, not an assertion (same decision as dispatch.gd `_query`).
func query(selector: Dictionary = {}) -> Array:
	var root := _resolution_root()
	if selector.has("test_id"):
		return Selectors.find_by_test_id(root, String(selector["test_id"]))
	if selector.has("group"):
		return Selectors.nodes_in_group(root, String(selector["group"]))
	if selector.has("path"):
		var node := Selectors.find_by_path(root, String(selector["path"]))
		return [node] if node != null else []
	return Selectors.all_test_id_nodes(root)

## Strict resolution (§3, single node): the primitive used by
## `press`/`invoke`/`wait_for`, and also directly exposed to frozen tests. A
## failure (selector not found or ambiguous) is recorded in the report with
## rich diagnostics (`not_found` + suggestions, or `ambiguous` + candidates)
## — never a silent timeout (ticket #11 criterion).
func query_one(selector: Dictionary) -> Node:
	if _aborted:
		return null
	var res := Selectors.resolve_strict(_resolution_root(), selector)
	if res.has("error"):
		_record_selector_failure("query_one(%s)" % [selector], res)
		return null
	return res["node"]

## Semantic activation (§4, cf. dispatch.gd `_act_press`): the resolved node
## must be a `Control` exposing a `pressed` signal — emitted directly, never
## hit-testing, so it's actionable in `--headless`.
func press(selector: Dictionary) -> void:
	if _aborted:
		return
	var node := query_one(selector)
	if node == null:
		return
	if not (node is Control) or not node.has_signal("pressed"):
		_record_failure("press(%s): node is not a pressable Control" % [selector])
		_aborted = true
		return
	node.emit_signal("pressed")

## Low-level injection (§4, cf. dispatch.gd `_act_input`), mirroring the
## network projection — used by frozen tests generated via `freeze_scenario`
## (ticket #13) when the trace contains `act.input`.
## `type: "action"|"key"` work everywhere (headless included); `type: "click"`
## (positional) requires a real display and is reserved for scripts marked
## `PLAYTEST_WINDOWED` (see runner.gd) — in headless, a clean failure rather
## than hit-testing dying silently.
func input(params: Dictionary) -> void:
	if _aborted:
		return
	var t: String = String(params.get("type", ""))
	match t:
		"action":
			var action_name: String = String(params.get("action", ""))
			var pressed: bool = bool(params.get("pressed", true))
			if pressed:
				Input.action_press(action_name, float(params.get("strength", 1.0)))
			else:
				Input.action_release(action_name)
		"key":
			var ev := InputEventKey.new()
			ev.keycode = int(params.get("keycode", 0))
			ev.pressed = bool(params.get("pressed", true))
			Input.parse_input_event(ev)
		"click":
			if DisplayServer.get_name() == "headless":
				_record_failure("input(%s): type 'click' requires a display (windowed-only)" % [params])
				_aborted = true
				return
			var pos: Array = params.get("position", [0, 0])
			var ev2 := InputEventMouseButton.new()
			ev2.position = Vector2(float(pos[0]), float(pos[1]))
			ev2.button_index = int(params.get("button", MOUSE_BUTTON_LEFT))
			ev2.pressed = bool(params.get("pressed", true))
			Input.parse_input_event(ev2)
		_:
			_record_failure("input(%s): unknown type '%s'" % [params, t])
			_aborted = true

## Reflection (§4, cf. dispatch.gd `_act_invoke`): a method missing on the
## resolved node is a "not_found"-like failure — the selector did resolve a
## node, but it can't honor the request.
func invoke(selector: Dictionary, method: String, args: Array = []) -> Variant:
	if _aborted:
		return null
	var node := query_one(selector)
	if node == null:
		return null
	if not node.has_method(method):
		_record_failure("invoke(%s, %s): no such method" % [selector, method])
		_aborted = true
		return null
	return node.callv(method, args)

## Shared by `wait_for` and `time_step_until`: resolves `selector` and
## evaluates its condition (`plain`/`property`/`method`/`signal` mode —
## `signal` is only ever passed by `wait_for`, `time_step_until` rejects it
## upfront). `verb` names the caller in recorded failure messages (mirrors
## `dispatch.gd _check_condition`'s split, but records failures directly since
## each in-process call is itself the failure site). `state` persists
## `signal` mode's connection bookkeeping (`connected`/`fired`) across calls —
## a `Dictionary`, passed by reference, since a plain local would reset every
## loop iteration. Returns `{"failed": true}` for an immediate, already-recorded
## failure (ambiguous/bad_request selector, or a missing method/signal — none
## of which resolve themselves with more time or more steps), `{"node": Node}`
## once the condition is met, or `{}` while it isn't yet (including a
## "not_found" selector, which may still resolve later).
func _check_condition(selector: Dictionary, mode: String, opts: Dictionary, verb: String, state: Dictionary) -> Dictionary:
	var res := Selectors.resolve_strict(_resolution_root(), selector)
	if res.has("error"):
		if res["error"] == "ambiguous" or res["error"] == "bad_request":
			_record_selector_failure("%s(%s)" % [verb, selector], res)
			return {"failed": true}
		return {}
	var node: Node = res["node"]
	match mode:
		"plain":
			return {"node": node}
		"property":
			var actual = node.get(String(opts["property"]))
			if actual == opts.get("equals"):
				return {"node": node}
		"method":
			# Parameterized domain query (§4), mirroring
			# `dispatch.gd _check_condition` mode "method": a missing method
			# won't resolve over time/more steps — immediate failure, same as
			# a missing signal. The method MUST be a pure read (re-called
			# every frame/step).
			var method_name: String = String(opts["method"])
			if not node.has_method(method_name):
				_record_failure("%s(%s): node has no method '%s'" % [verb, selector, method_name])
				_aborted = true
				return {"failed": true}
			var value = node.callv(method_name, opts.get("args", []))
			if value == opts.get("equals"):
				return {"node": node}
		"signal":
			if not state.get("connected", false):
				var signal_name: String = String(opts["signal"])
				if not node.has_signal(signal_name):
					_record_failure("%s(%s): node has no signal '%s'" % [verb, selector, signal_name])
					_aborted = true
					return {"failed": true}
				node.connect(signal_name, func(): state["fired"] = true, CONNECT_ONE_SHOT)
				state["connected"] = true
			if state.get("fired", false):
				return {"node": node}
	return {}

## Asynchronous `wait_for` (§4, §1.3): re-evaluates the condition every frame
## (`await get_tree().process_frame`) until resolution or `timeout_ms` —
## THE in-process anti-flake building block, never a blocking `await` on a
## sleep. Mirrors `dispatch.gd _poll_wait_for`: an "ambiguous" selector fails
## immediately (nothing to wait for); "not_found" keeps waiting (the node may
## appear later) until it expires as a "timeout" failure.
func wait_for(selector: Dictionary, opts: Dictionary = {}) -> Node:
	if _aborted:
		return null
	var timeout_ms: int = int(opts.get("timeout_ms", 5000))
	var deadline_ms := Time.get_ticks_msec() + timeout_ms
	var mode := "plain"
	if opts.has("signal"):
		mode = "signal"
	elif opts.has("property"):
		mode = "property"
	elif opts.has("method"):
		mode = "method"
	var state := {}

	while true:
		var res := _check_condition(selector, mode, opts, "wait_for", state)
		if res.has("failed"):
			return null
		if res.has("node"):
			return res["node"]
		if Time.get_ticks_msec() >= deadline_ms:
			_record_failure("wait_for(%s) timed out after %dms" % [selector, timeout_ms])
			_aborted = true
			return null
		await get_tree().process_frame
	return null

## In-process `time.step_until` (§4, ticket #38 — the owed in-process mirror
## of the network verb added by ticket #37, ADR-0006's "a semantic added to
## one projection is added to both, under the same name": see
## docs/adr/0007-time-step-until-as-a-new-verb.md and its "Scope note").
## Deterministic sibling of `wait_for`: re-evaluates `opts` once per idle
## frame (`await get_tree().process_frame`) — mirroring `bridge.gd`'s
## one-`Dispatch.poll()`-per-idle-frame contract on the network side, so
## `Engine.get_process_frames()` deltas track real frames 1:1 here too (this
## is frame-COUNTED, not a frozen clock — see the README's "Frame counting,
## not a per-poll tick" note) — until the condition holds or the frame
## budget is exhausted. `opts` reuses `wait_for`'s condition vocabulary MINUS
## `signal` (plain presence, `property`+`equals`, `method`+`args`+`equals`):
## a `signal` key is a reported failure, exactly like `_step_until`'s network
## `bad_request` rejection, never silently ignored (a one-shot event doesn't
## fit a budget expressed in discrete frame steps — `wait_for` remains the
## way to wait on a signal). `opts.max_frames` (default
## `PlaytestDispatch.DEFAULT_STEP_UNTIL_MAX_FRAMES`, 300) is the deterministic
## budget; an optional `opts.timeout_ms` is a wall-clock safety net only,
## checked after the frame budget — never the primary bound (ADR-0007).
##
## Returns `{"node": Node, "frames": int}` on success (`frames`: engine
## frames elapsed since the call, mirroring the network response's `frames`
## field — what a test checks to confirm the resolution is
## frame-deterministic) or `{"node": null, "frames": int}` once the budget is
## exhausted or the selector/condition is unusable — always a reported
## failure (`failures`), never a silent timeout.
##
## THIS FUNCTION IS A COROUTINE (it contains an `await` in its re-evaluation
## loop), so every call site MUST `await` it — even when the condition
## already holds at the call (`frames == 0`), exactly like
## `assert_now_*`/`assert_eventually_*` (see their shared note below). This
## is not a silent trap in practice: GDScript's parser rejects a missing
## `await` on a coroutine call whose result is used ("... is a coroutine, so
## it must be called with await") — verified against Godot 4.6.3 — so a
## forgotten `await` here surfaces as a load-time parse error, caught the
## same way as the "unparseable script" runner scenario, not as a silent
## wrong result.
func time_step_until(selector: Dictionary, opts: Dictionary = {}) -> Dictionary:
	if _aborted:
		return {"node": null, "frames": 0}
	if opts.has("signal"):
		_record_failure("time_step_until(%s): 'signal' mode is not supported — use wait_for to wait on a one-shot signal" % [selector])
		_aborted = true
		return {"node": null, "frames": 0}
	var mode := "plain"
	if opts.has("property"):
		mode = "property"
	elif opts.has("method"):
		mode = "method"
	var max_frames: int = int(opts.get("max_frames", PlaytestDispatch.DEFAULT_STEP_UNTIL_MAX_FRAMES))
	var start_frame: int = Engine.get_process_frames()
	var deadline_ms := (Time.get_ticks_msec() + int(opts["timeout_ms"])) if opts.has("timeout_ms") else -1
	var state := {}

	while true:
		var elapsed: int = Engine.get_process_frames() - start_frame
		var res := _check_condition(selector, mode, opts, "time_step_until", state)
		if res.has("failed"):
			return {"node": null, "frames": elapsed}
		if res.has("node"):
			return {"node": res["node"], "frames": elapsed}
		if elapsed >= max_frames:
			_record_failure("time_step_until(%s) exhausted its frame budget (max_frames=%d) after %d frame(s)" % [selector, max_frames, elapsed])
			_aborted = true
			return {"node": null, "frames": elapsed}
		if deadline_ms >= 0 and Time.get_ticks_msec() >= deadline_ms:
			_record_failure("time_step_until(%s) exceeded its 'timeout_ms' safety ceiling after %d frame(s)" % [selector, elapsed])
			_aborted = true
			return {"node": null, "frames": elapsed}
		await get_tree().process_frame
	return {"node": null, "frames": 0}

## In-process `time.scale` (§4, §6 — network verb ⇄ in-process method
## mapping, see addons/playtest/README.md): fast-forward via
## `Engine.time_scale`, immediate effect but produces nothing as long as no
## frames elapse — exact mirror of `dispatch.gd _time_scale`.
func time_scale(factor: float) -> void:
	Engine.time_scale = factor

## In-process `time.frames` (§4, §6): waits for `n` frames (idle by
## default, or physics if `physics=true`) to have actually elapsed.
## Always resolved deterministically — no deadline, unlike
## `wait_for`/`assert_*`: the frame count necessarily elapses. Mirrors
## `dispatch.gd _time_frames`/`_poll_frames` (mode `"frames"` of the network
## wait queue).
func time_frames(n: int, physics: bool = false) -> void:
	if n <= 0:
		return
	var current: int = Engine.get_physics_frames() if physics else Engine.get_process_frames()
	var target: int = current + n
	while (Engine.get_physics_frames() if physics else Engine.get_process_frames()) < target:
		if physics:
			await get_tree().physics_frame
		else:
			await get_tree().process_frame

## Default timeout for `assert_eventually_*` (§7): applies only to the
## eventually family — `assert_now_*` never waits, so it has no `timeout_ms`
## to configure. Same order of magnitude as the `wait_for` default (5000ms),
## a bit shorter: an assertion targets a value that's generally already
## close to its target (not a long action wait), overridable via the
## `timeout_ms` parameter.
const DEFAULT_ASSERT_TIMEOUT_MS := 2000

## `assert_now_*`/`assert_eventually_*` (ADR-0006 naming corollary): two
## families named by the call site, never inferred from the argument's type
## — each **rejects** the other's argument kind as a reported test failure
## (never a silent no-op or a bare `push_error`):
##
## - `assert_now_*` — `actual` is an already-evaluated value (e.g.
##   `label.text`): compared once, immediately, never waits. For checks that
##   directly follow `start_game()` or another synchronization point, where
##   there's nothing left to settle. Runs even after a selector failure
##   (`_aborted`, see the note above): constant cost, cannot hang, and
##   several independent failures are worth more than one.
## - `assert_eventually_*` — `actual` is a no-argument `Callable` (e.g.
##   `func(): return query_one({"test_id": "score_label"}).text`): called
##   again every frame until the comparison succeeds, or fails after
##   `timeout_ms` — the canonical form for a value that settles over time
##   (see also `assert_eventually_property`, sugar for the recommended
##   selector+property case). Skipped if a selector has already failed
##   (`_aborted`): nothing to await from a getter referencing an
##   already-broken selector, otherwise `timeout_ms` would be burned per
##   assertion for nothing.
##
## Both families route through a shared core (`_assert_now`/
## `_assert_eventually`) that contains an `await` (in the eventually core, on
## its retry branch): a function that contains `await` anywhere is a
## GDScript coroutine, and the compiler then requires `await` at **every**
## call site — including the `now` form, which never actually suspends —
## hence `await assert_now_eq(...)` everywhere, even on an immediate value.
func assert_now_eq(actual: Variant, expected: Variant, message: String = "") -> void:
	await _assert_now(actual,
		func(v): return v == expected,
		func(v): return "expected %s, got %s" % [expected, v],
		"assert_now_eq", "assert_eventually_eq", message)

func assert_eventually_eq(actual: Variant, expected: Variant, message: String = "", timeout_ms: int = DEFAULT_ASSERT_TIMEOUT_MS) -> void:
	await _assert_eventually(actual,
		func(v): return v == expected,
		func(v): return "expected %s, got %s" % [expected, v],
		"assert_eventually_eq", "assert_now_eq", message, timeout_ms)

func assert_now_true(actual: Variant, message: String = "") -> void:
	await _assert_now(actual,
		func(v): return bool(v),
		func(_v): return "expected true",
		"assert_now_true", "assert_eventually_true", message)

func assert_eventually_true(actual: Variant, message: String = "", timeout_ms: int = DEFAULT_ASSERT_TIMEOUT_MS) -> void:
	await _assert_eventually(actual,
		func(v): return bool(v),
		func(_v): return "expected true",
		"assert_eventually_true", "assert_now_true", message, timeout_ms)

func assert_now_false(actual: Variant, message: String = "") -> void:
	await _assert_now(actual,
		func(v): return not bool(v),
		func(_v): return "expected false",
		"assert_now_false", "assert_eventually_false", message)

func assert_eventually_false(actual: Variant, message: String = "", timeout_ms: int = DEFAULT_ASSERT_TIMEOUT_MS) -> void:
	await _assert_eventually(actual,
		func(v): return not bool(v),
		func(_v): return "expected false",
		"assert_eventually_false", "assert_now_false", message, timeout_ms)

func assert_now_null(actual: Variant, message: String = "") -> void:
	await _assert_now(actual,
		func(v): return v == null,
		func(v): return "expected null, got %s" % [v],
		"assert_now_null", "assert_eventually_null", message)

func assert_eventually_null(actual: Variant, message: String = "", timeout_ms: int = DEFAULT_ASSERT_TIMEOUT_MS) -> void:
	await _assert_eventually(actual,
		func(v): return v == null,
		func(v): return "expected null, got %s" % [v],
		"assert_eventually_null", "assert_now_null", message, timeout_ms)

func assert_now_not_null(actual: Variant, message: String = "") -> void:
	await _assert_now(actual,
		func(v): return v != null,
		func(_v): return "expected non-null value",
		"assert_now_not_null", "assert_eventually_not_null", message)

func assert_eventually_not_null(actual: Variant, message: String = "", timeout_ms: int = DEFAULT_ASSERT_TIMEOUT_MS) -> void:
	await _assert_eventually(actual,
		func(v): return v != null,
		func(_v): return "expected non-null value",
		"assert_eventually_not_null", "assert_now_not_null", message, timeout_ms)

## `assert_now_property`: the selector+property counterpart of
## `assert_now_*` (ADR-0006 — `assert_property` becomes
## `assert_eventually_property` on both projections and gains this `now`
## sibling). Resolves `selector` and reads `property` exactly once, right
## now, with no retry and no `timeout_ms` — the guarantee
## `assert_eventually_property` cannot provide: a value that is wrong now but
## becomes correct later must fail here. Reuses `resolve_strict`'s rich
## diagnostics (`not_found` + suggestions, `ambiguous` + candidates) rather
## than a silent `null`. Runs even after a selector failure (`_aborted`),
## like every other `assert_now_*`.
func assert_now_property(selector: Dictionary, property: String, expected: Variant, message: String = "") -> void:
	var res := Selectors.resolve_strict(_resolution_root(), selector)
	if res.has("error"):
		_record_failure(_assert_message("assert_now_property", message,
			"selector %s: [%s] %s" % [selector, res["error"], res["detail"]]))
		return
	var node: Node = res["node"]
	var actual = node.get(property)
	if actual != expected:
		_record_failure(_assert_message("assert_now_property", message,
			"expected %s.%s == %s, got %s" % [selector, property, expected, actual]))

## Sugar recommended by the ticket #11 review for the "selector+property"
## form (§7): equivalent to
## `assert_eventually_eq(func(): return query_one(selector).get(property), expected)`
## but with `resolve_strict`'s rich diagnostics (suggestions for "not_found",
## candidates for "ambiguous") instead of a plain silent `null`, and without
## ever aborting the selector (see the `_aborted` note: `assert_eventually_*`
## never flips `_aborted`, unlike `query_one`).
## An "ambiguous"/"bad_request" selector fails fast (nothing to wait for);
## "not_found" keeps retrying until `timeout_ms` (the node may appear later)
## — same rule as `wait_for`.
func assert_eventually_property(selector: Dictionary, property: String, expected: Variant, message: String = "", timeout_ms: int = DEFAULT_ASSERT_TIMEOUT_MS) -> void:
	if _aborted:
		return
	var deadline_ms := Time.get_ticks_msec() + timeout_ms
	while true:
		var res := Selectors.resolve_strict(_resolution_root(), selector)
		if res.has("error"):
			if res["error"] == "ambiguous" or res["error"] == "bad_request":
				_record_failure(_assert_message("assert_eventually_property", message,
					"selector %s: [%s] %s" % [selector, res["error"], res["detail"]]))
				return
			# "not_found": the node may still appear, keep waiting.
		else:
			var node: Node = res["node"]
			var actual = node.get(property)
			if actual == expected:
				return
			if Time.get_ticks_msec() >= deadline_ms:
				_record_failure(_assert_message("assert_eventually_property", message,
					"expected %s.%s == %s, got %s" % [selector, property, expected, actual]))
				return
			await get_tree().process_frame
			continue
		if Time.get_ticks_msec() >= deadline_ms:
			_record_failure(_assert_message("assert_eventually_property", message,
				"selector %s never resolved (last: [%s] %s)" % [selector, res["error"], res["detail"]]))
			return
		await get_tree().process_frame

## Core shared by `assert_now_eq`/`assert_now_true`/`assert_now_false`/
## `assert_now_null`/`assert_now_not_null`: `ok(value)` judges `actual`,
## `describe(value)` produces the failure message detail. `actual` MUST NOT
## be a `Callable` (ADR-0006 naming corollary: the call site names the
## semantics, the argument kind is enforced, never branched on) — passing
## one is a reported failure naming `alt_kind`, the `assert_eventually_*`
## counterpart, never a silent no-op.
func _assert_now(actual: Variant, ok: Callable, describe: Callable, own_kind: String, alt_kind: String, message: String) -> void:
	if actual is Callable:
		_record_failure(_assert_message(own_kind, message,
			"got a Callable, expected an already-evaluated value — use %s instead" % alt_kind))
		return
	if not ok.call(actual):
		_record_failure(_assert_message(own_kind, message, describe.call(actual)))

## Retry-until-timeout core shared by `assert_eventually_eq`/
## `assert_eventually_true`/`assert_eventually_false`/`assert_eventually_null`/
## `assert_eventually_not_null`: `actual` MUST be a no-argument `Callable`
## (ADR-0006 naming corollary) — a plain value is a reported failure naming
## `alt_kind`, the `assert_now_*` counterpart. Otherwise, `actual` is called
## again every frame until `ok()` holds or `timeout_ms` expires. Skipped
## (silently, after the argument-kind check) if `_aborted` is already true,
## to avoid looping `timeout_ms` against a getter that references an
## already-known-broken selector.
func _assert_eventually(actual: Variant, ok: Callable, describe: Callable, own_kind: String, alt_kind: String, message: String, timeout_ms: int) -> void:
	if not (actual is Callable):
		_record_failure(_assert_message(own_kind, message,
			"got an already-evaluated value, expected a Callable — use %s instead" % alt_kind))
		return
	if _aborted:
		return
	var getter: Callable = actual
	var deadline_ms := Time.get_ticks_msec() + timeout_ms
	while true:
		var value = getter.call()
		if ok.call(value):
			return
		if Time.get_ticks_msec() >= deadline_ms:
			_record_failure(_assert_message(own_kind, message, describe.call(value)))
			return
		await get_tree().process_frame

func _assert_message(kind: String, message: String, detail: String) -> String:
	if message == "":
		return "%s: %s" % [kind, detail]
	return "%s (%s): %s" % [kind, message, detail]

## A selector resolution failure (query_one/press/invoke/wait_for) is the
## only case that flips `_aborted`: cf. the `_aborted` note above.
## The message always includes the rich diagnostic (`error`, `suggestions`
## for "not_found", `candidates` for "ambiguous") — never a silent timeout
## (ticket #11 criterion "broken selector test").
func _record_selector_failure(context: String, res: Dictionary) -> void:
	var message := "%s: [%s] %s" % [context, res.get("error"), res.get("detail")]
	if res.has("suggestions") and not (res["suggestions"] as Array).is_empty():
		message += " (suggestions: %s)" % [res["suggestions"]]
	if res.has("candidates") and not (res["candidates"] as Array).is_empty():
		message += " (candidates: %s)" % [res["candidates"]]
	_record_failure(message, res)
	_aborted = true

## Records a failure with a full `query` dump of the current tree (§7).
func _record_failure(message: String, detail: Dictionary = {}) -> void:
	failures.append({
		"message": message,
		"detail": detail,
		"query_dump": _dump_query(),
	})
	push_error("[playtest] %s" % message)

## A handle's (`PlaytestClient`, spec #66) failure joins THIS case's same
## aggregated report as any `self` failure — "one report" (spec #66 §11) —
## prefixed with the instance name so the same test-id on two clients never
## sends anyone to the wrong tree (§12). Deliberately never touches
## `_aborted`: a handle failure stops only that handle's further calls
## (`PlaytestClient._aborted`), never `self`'s. `query_dump` is `self`'s own
## tree, not the remote instance's — the remote Bridge's own `suggestions`/
## `candidates` (already folded into `message` by the caller) are the
## per-instance diagnostic here; dumping the remote tree too would need an
## extra round trip this case has no use for.
func _record_handle_failure(instance_name: String, message: String) -> void:
	failures.append({
		"message": "[%s] %s" % [instance_name, message],
		"detail": {},
		"query_dump": [],
	})
	push_error("[playtest] [%s] %s" % [instance_name, message])

func _dump_query() -> Array:
	var root := _resolution_root()
	if root == null:
		return []
	var out := []
	for n in Selectors.all_test_id_nodes(root):
		out.append(State.describe(n))
	return out
