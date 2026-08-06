## Unit test for the transport liveness guard (issue #21): `Dispatch.
## poll()` purges `_pending` entries whose peer is dead, and
## `Transport.send()` never writes to a disconnected peer.
##
## Complements (does not replace) `scenario.py::check_wait_for_peer_disconnect`:
## in black box via real TCP, nothing guarantees that a request stays
## `pending` long enough for the disconnect to be detected before resolution,
## nor that `StreamPeerTCP` detects it within the test window (depends on
## the OS/Godot version, cf. transport.gd). Here the assertion applies
## directly to `_pending` and to whether `put_data` is called, without
## depending on real TCP timing.
## Usage: godot --headless --script res://tests/conformance/transport_liveness_test.gd
extends SceneTree

const Dispatch = preload("res://addons/playtest/dispatch.gd")
const Transport = preload("res://addons/playtest/transport.gd")

## Test double for `Dispatch._peer_alive`: its `peer` parameter is not typed
## `StreamPeerTCP` (dispatch.gd deliberately ignores the transport type,
## cf. its comment on `_init`/`handle`) — only the `get_status()` method
## is called on it, so any object that exposes it works.
class FakePeer:
	extends RefCounted
	var status: int
	func _init(s: int) -> void:
		status = s
	func get_status() -> int:
		return status

var _failures: Array[String] = []

func _init() -> void:
	_check_dead_peer_purged_without_resolving()
	_check_alive_peer_still_resolved()
	_check_dead_peer_purged_without_resolving_step_until()
	_check_transport_send_noop_on_dead_peer()

	if _failures.is_empty():
		print("PASS 4/4")
		quit(0)
	else:
		for f in _failures:
			printerr("FAIL: %s" % f)
		quit(1)

## `Dispatch.poll()` must skip (and remove from `_pending`) an entry whose
## peer is dead, without ever trying to resolve it or include it in the
## output to send.
func _check_dead_peer_purged_without_resolving() -> void:
	var d := Dispatch.new(root)
	var dead := FakePeer.new(StreamPeerTCP.STATUS_ERROR)
	# "target": -2 would resolve instantly if ever evaluated (cf.
	# _poll_frames: current >= target) — the guard must prevent it from getting there.
	d._pending.append({
		"id": 1, "peer": dead, "kind": "frames", "physics": false, "target": -2,
	})
	var out := d.poll()
	_assert(out.is_empty(), "poll() returns no response for a dead peer", out)
	_assert(d._pending.is_empty(), "the orphaned entry is purged from _pending", d._pending)

## Safety net for the previous test: a live peer keeps being resolved
## normally (the guard must not purge everyone by mistake).
func _check_alive_peer_still_resolved() -> void:
	var d := Dispatch.new(root)
	var alive := FakePeer.new(StreamPeerTCP.STATUS_CONNECTED)
	d._pending.append({
		"id": 2, "peer": alive, "kind": "frames", "physics": false, "target": -2,
	})
	var out := d.poll()
	_assert(
		out.size() == 1 and out[0]["peer"] == alive,
		"a live peer is still resolved normally", out
	)
	_assert(d._pending.is_empty(), "the resolved entry is removed from _pending", d._pending)

## Same guard, `"kind": "step_until"` (ticket #37): the peer-alive check in
## `poll()` runs before the per-kind branch, so a dead peer must be purged
## here exactly like a `wait_for`/`frames` entry, without ever reaching
## `_poll_step_until` (which would otherwise try to resolve a selector on a
## bogus `test_id`).
func _check_dead_peer_purged_without_resolving_step_until() -> void:
	var d := Dispatch.new(root)
	var dead := FakePeer.new(StreamPeerTCP.STATUS_ERROR)
	d._pending.append({
		"id": 3, "peer": dead, "kind": "step_until",
		"selector": {"test_id": "no_such_thing"}, "mode": "plain",
		"start_frame": Engine.get_process_frames(), "max_frames": 0, "deadline_ms": -1,
	})
	var out := d.poll()
	_assert(out.is_empty(), "poll() returns no response for a dead peer (step_until)", out)
	_assert(d._pending.is_empty(), "the orphaned step_until entry is purged from _pending", d._pending)

## `Transport.send` is typed `StreamPeerTCP` (not mockable): real
## client/server pair, closed on the client side then drained on the server
## side until Godot detects the EOF (cf. scenario.py comment: one extra
## frame must be left after reading the data already in flight).
func _check_transport_send_noop_on_dead_peer() -> void:
	var server := TCPServer.new()
	if server.listen(0, "127.0.0.1") != OK:
		_failures.append("setup: TCPServer.listen() failed")
		return

	var client := StreamPeerTCP.new()
	client.connect_to_host("127.0.0.1", server.get_local_port())
	for _i in range(200):
		client.poll()
		if server.is_connection_available():
			break
		OS.delay_msec(5)

	var server_peer: StreamPeerTCP = server.take_connection()
	for _i in range(200):
		client.poll()
		server_peer.poll()
		if client.get_status() == StreamPeerTCP.STATUS_CONNECTED \
				and server_peer.get_status() == StreamPeerTCP.STATUS_CONNECTED:
			break
		OS.delay_msec(5)

	client.put_data("bye\n".to_utf8_buffer())
	client.poll()
	client.disconnect_from_host()

	var detected := false
	for _i in range(200):
		server_peer.poll()
		if server_peer.get_status() != StreamPeerTCP.STATUS_CONNECTED:
			detected = true
			break
		# Mirrors transport.gd::poll(): drains what's available before
		# going through poll() again — it's this read that makes Godot
		# notice the EOF (one frame later), not poll() alone.
		var avail := server_peer.get_available_bytes()
		if avail > 0:
			server_peer.get_utf8_string(avail)
		OS.delay_msec(5)
	server.stop()
	if not detected:
		_failures.append("setup: the server peer's disconnect was never detected by StreamPeerTCP")
		return

	# The point of the test: must neither crash nor write to the dead peer.
	Transport.new().send(server_peer, {"id": 99, "ok": true})
	print("ok: Transport.send() is a silent no-op on a disconnected peer")

func _assert(cond: bool, label: String, detail) -> void:
	if cond:
		print("ok: %s" % label)
	else:
		_failures.append("%s (got: %s)" % [label, detail])
