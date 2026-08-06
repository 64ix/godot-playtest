## TestBridge: dormant/active autoload of the godot-playtest protocol.
##
## Dormant by default (docs/protocol/DRAFT-v0.md §1.4): only listens if the
## build embeds the "playtest" export feature or if the game is launched with
## `--playtest` (user args, after `--`). Without opt-in: zero socket.
##
## Export guard (ticket #10, AltTester lesson): on a release export
## (`template_release`), `--playtest` alone is not enough — the export
## feature must be set on the preset. Decision delegated to
## `PlaytestActivationPolicy` (pure function, tested in isolation). See also
## `export_guard_check.gd`: a static check runnable in CI that fails if an
## export preset without the `playtest` feature still embeds the autoload.
extends Node

const Transport = preload("res://addons/playtest/transport.gd")
const Dispatch = preload("res://addons/playtest/dispatch.gd")
const ActivationPolicy = preload("res://addons/playtest/activation_policy.gd")

var _transport: Transport
var _dispatch: Dispatch
var _active := false

func _ready() -> void:
	var user_args := OS.get_cmdline_user_args()
	var decision := ActivationPolicy.decide(
		OS.has_feature("template_release"),
		OS.has_feature("playtest"),
		user_args.has("--playtest")
	)
	if not decision["start"]:
		if decision["guard_triggered"]:
			push_error("[playtest] bridge : %s" % decision["reason"])
		set_process(false)
		return

	var port := 4242
	var port_file := ""
	for a in user_args:
		if a.begins_with("--bridge-port="):
			port = int(a.get_slice("=", 1))
		elif a.begins_with("--bridge-port-file="):
			port_file = a.get_slice("=", 1)

	_transport = Transport.new()
	var result := _transport.listen(port, port_file)
	if not result["ok"]:
		push_error("[playtest] bridge: listen failed port=%d (%s)" % [port, result["error"]])
		set_process(false)
		return

	_dispatch = Dispatch.new(get_tree().root)
	_active = true
	print("[playtest] bridge active on 127.0.0.1:%d" % result["port"])

func _process(_delta: float) -> void:
	if not _active:
		return
	for entry in _transport.poll():
		var peer: StreamPeerTCP = entry["peer"]
		var line: String = entry["line"]
		var parsed = JSON.parse_string(line)
		if typeof(parsed) != TYPE_DICTIONARY:
			_transport.send(peer, PlaytestErrors.bad_json(null))
			continue
		# `null` = asynchronous request (wait_for, time.frames) queued: its
		# response will arrive via `_dispatch.poll()` below, potentially
		# after that of a synchronous request received later (§1: responses
		# are out of order, correlated by `id`).
		var resp = _dispatch.handle(parsed, peer)
		if resp != null:
			_transport.send(peer, resp)
	for completed in _dispatch.poll():
		_transport.send(completed["peer"], completed["response"])

func _exit_tree() -> void:
	if _transport:
		_transport.stop()
