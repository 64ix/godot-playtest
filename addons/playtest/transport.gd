## JSON-lines loopback TCP transport (docs/protocol/DRAFT-v0.md §2).
##
## Knows nothing about the protocol: encodes/decodes JSON lines over sockets.
## The Bridge (bridge.gd) hands it already-dispatched Dictionaries to send.
class_name PlaytestTransport
extends RefCounted

var _server: TCPServer
var _peers: Array = []
var _buffers := {}

## Starts listening. `port == 0` delegates port selection to the OS; the
## actually bound port is then returned in the result (and written to
## `port_file` if provided, for CI parallelism godot-e2e style).
func listen(port: int, port_file: String = "") -> Dictionary:
	_server = TCPServer.new()
	var err := _server.listen(port, "127.0.0.1")
	if err != OK:
		return {"ok": false, "error": err}
	var actual_port := _server.get_local_port()
	if not port_file.is_empty():
		var f := FileAccess.open(port_file, FileAccess.WRITE)
		if f == null:
			return {"ok": false, "error": "cannot write bridge-port-file '%s'" % port_file}
		f.store_string(str(actual_port))
		f.close()
	return {"ok": true, "port": actual_port}

## To be called every frame. Returns the complete lines received since the
## last call, as [{"peer": StreamPeerTCP, "line": String}, ...].
func poll() -> Array:
	var incoming := []
	if _server == null:
		return incoming
	if _server.is_connection_available():
		var p: StreamPeerTCP = _server.take_connection()
		p.set_no_delay(true)
		_peers.append(p)
		_buffers[p] = ""
	for p in _peers.duplicate():
		p.poll()
		var st: int = p.get_status()
		if st == StreamPeerTCP.STATUS_ERROR or st == StreamPeerTCP.STATUS_NONE:
			_peers.erase(p)
			_buffers.erase(p)
			continue
		var avail: int = p.get_available_bytes()
		if avail > 0:
			_buffers[p] += p.get_utf8_string(avail)
			while "\n" in _buffers[p]:
				var idx: int = _buffers[p].find("\n")
				var line: String = _buffers[p].substr(0, idx)
				_buffers[p] = _buffers[p].substr(idx + 1)
				incoming.append({"peer": p, "line": line})
	return incoming

## Writes `obj` to `peer`. `wait_for`/`time.frames` (dispatch.gd) capture a
## `peer` at registration time and retrieve it potentially several seconds
## later via `poll()`: if the client closed the socket in the meantime,
## `put_data` on a dead `StreamPeerTCP` is documented to fail silently on
## some platforms but this is not guaranteed across Godot versions
## (issue #21) — the status guard below makes the no-op explicit rather
## than relying on this unspecified behavior.
func send(peer: StreamPeerTCP, obj: Dictionary) -> void:
	if peer == null or peer.get_status() != StreamPeerTCP.STATUS_CONNECTED:
		return
	peer.put_data((JSON.stringify(obj) + "\n").to_utf8_buffer())

func stop() -> void:
	if _server:
		_server.stop()
	_peers.clear()
	_buffers.clear()
