#!/usr/bin/env python3
"""Conformance suite for the godot-playtest protocol (docs/protocol/DRAFT-v0.md).

Launches the fixture (fixtures/witness_game) with --playtest and runs a
scenario per verb/error case: hello, query (including the state contract via
the C# `_TestState` convention), selectors, act.press, act.invoke, wait_for
(property/signal/method/timeout, out-of-order and simultaneous, peer
disconnect during a pending — issue #21),
time.scale/time.frames/time.step_until (ticket #37, deterministic
advance-until-condition, frame budget, peer disconnect), screenshot — with
the headless degradation matrix
(DRAFT-v0.md §6). Ends with a clean process shutdown via the `quit` verb
(ticket #20) — never a `kill` on the nominal run (SIGKILL remains the
safety net, never SIGTERM, see `shutdown_clean`). A separate process also checks
`--bridge-port=0` + `--bridge-port-file` (issue #21). The purged `_pending`
entry / `Transport.send` no-op on a dead peer, checked independently of real
TCP timing, lives in `transport_liveness_test.gd` (same directory).

By default the game runs `--headless` (CI mode, ×20 in
.github/workflows/bridge-conformance.yml): `act.input` type "click" and
`screenshot` MUST fail there cleanly (no_display / no_renderer).

Local windowed pass (documented, not run in CI):
    python3 tests/conformance/scenario.py <godot_bin> . 4242 --windowed
In windowed mode, these two verbs MUST instead succeed, and `hello` announces
the "windowed" capability — this script automatically switches the
corresponding assertions based on the mode.

Exit 0 = green suite. Usage: scenario.py <godot_bin> <project_dir> [port] [--windowed]
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time

GODOT, PROJECT = sys.argv[1], sys.argv[2]
rest = sys.argv[3:]
WINDOWED = "--windowed" in rest
rest = [a for a in rest if a != "--windowed"]
PORT = int(rest[0]) if rest else 4242

# State shared between checks (the fixture's score persists across the
# whole Godot process, launched only once for the entire suite).
_ctx = {"score": 0}


class Bridge:
    def __init__(self, port):
        deadline = time.time() + 30
        while True:
            try:
                self.sock = socket.create_connection(("127.0.0.1", port), timeout=2)
                break
            except OSError:
                if time.time() > deadline:
                    raise
                time.sleep(0.1)
        self.sock.settimeout(15)
        self.buf = b""
        self.next_id = 0
        self._pending = {}  # id -> line already read but not yet consumed

    def send(self, **req):
        """Sends a request without waiting for the response. Returns its `id`."""
        self.next_id += 1
        req["id"] = self.next_id
        self.sock.sendall((json.dumps(req) + "\n").encode())
        return req["id"]

    def _read_line(self) -> bytes:
        while b"\n" not in self.buf:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise ConnectionError("closed")
            self.buf += chunk
        line, self.buf = self.buf.split(b"\n", 1)
        return line

    def recv(self, expected_id: int) -> dict:
        """Reads until it gets the `expected_id` response, setting aside any
        response that arrives before it (§1: out-of-order responses,
        correlated by `id` — a wait_for sent before a fast command typically
        sees that command's response arrive first)."""
        if expected_id in self._pending:
            return self._pending.pop(expected_id)
        while True:
            line = self._read_line()
            resp = json.loads(line)
            if resp.get("id") == expected_id:
                # The contract (§2) requires `id: <int>` on the wire, not
                # `1.0` (JSON.parse_string returns all numbers as float on
                # the Godot side — an easy regression if dispatch forgets to
                # recast).
                assert b'"id":%d' % expected_id in line, f"id serialized as float: {line}"
                return resp
            self._pending[resp["id"]] = resp

    def call(self, **req) -> dict:
        return self.recv(self.send(**req))


def check_hello(b):
    r = b.call(cmd="hello")
    assert r["ok"], r
    assert r["protocol"] == 0, r
    assert r["state_contract"] == 0, r
    assert isinstance(r["engine"], str) and r["engine"], r
    expected_caps = ["windowed"] if WINDOWED else []
    assert r["capabilities"] == expected_caps, r


def check_query_all(b):
    r = b.call(cmd="query")
    assert r["ok"], r
    ids = sorted(n["test_id"] for n in r["nodes"])
    # dup_demo appears twice (ambiguity fixture, cf. main.gd)
    expected = sorted(
        ["game", "player", "score_button", "score_label", "pascal_witness",
         "dup_demo", "dup_demo"]
    )
    assert ids == expected, ids


def check_query_test_id(b):
    r = b.call(cmd="query", test_id="score_label")
    assert r["ok"], r
    assert len(r["nodes"]) == 1, r
    node = r["nodes"][0]
    assert node["text"] == "0", node
    assert node["class"] == "Label", node
    assert node["path"] == "/root/Main/ScoreLabel", node


def check_query_state_contract(b):
    r = b.call(cmd="query", test_id="game")
    assert r["ok"], r
    state = r["nodes"][0]["state"]
    assert state["score"] == 0, state
    # Vector2 passed through the appendix's Variant->JSON mapping.
    assert state["player_position"] == {"$gd": "Vector2", "v": [50, 200]}, state


def check_query_state_contract_pascal(b):
    """C# convention (§5): a node that only defines `_TestState()`
    (PascalCase, the name under which Godot exposes a C# method) publishes
    its domain exactly like a GDScript node with `_test_state()`."""
    r = b.call(cmd="query", test_id="pascal_witness")
    assert r["ok"], r
    state = r["nodes"][0]["state"]
    assert state == {"readiness": "pascal_ready"}, state


def check_query_group(b):
    r = b.call(cmd="query", group="ui")
    assert r["ok"], r
    ids = sorted(n["test_id"] for n in r["nodes"])
    assert ids == ["score_button", "score_label"], ids


def check_query_group_empty(b):
    r = b.call(cmd="query", group="no_such_group")
    assert r["ok"], r
    assert r["nodes"] == [], r


def check_query_path(b):
    r = b.call(cmd="query", path="/root/Main/Player")
    assert r["ok"], r
    assert r["nodes"][0]["test_id"] == "player", r


def check_query_not_found(b):
    r = b.call(cmd="query", test_id="score_buttn")
    assert not r["ok"], r
    assert r["error"] == "not_found", r
    assert "score_button" in r["suggestions"], r


def check_query_path_not_found(b):
    r = b.call(cmd="query", path="/root/Main/NoSuchNode")
    assert not r["ok"], r
    assert r["error"] == "not_found", r


def check_query_ambiguous(b):
    r = b.call(cmd="query", test_id="dup_demo")
    assert not r["ok"], r
    assert r["error"] == "ambiguous", r
    assert len(r["candidates"]) == 2, r


def check_unknown_cmd(b):
    r = b.call(cmd="not_a_real_verb")
    assert not r["ok"], r
    assert r["error"] == "unknown_cmd", r


# ---------------------------------------------------------------------------
# act.press
# ---------------------------------------------------------------------------

def check_act_press(b):
    r = b.call(cmd="act.press", test_id="score_button")
    assert r["ok"], r
    _ctx["score"] += 1
    q = b.call(cmd="query", test_id="score_label")
    assert q["nodes"][0]["text"] == str(_ctx["score"]), q


def check_act_press_ambiguous(b):
    r = b.call(cmd="act.press", test_id="dup_demo")
    assert not r["ok"], r
    assert r["error"] == "ambiguous", r


def check_act_press_not_found(b):
    r = b.call(cmd="act.press", test_id="no_such_button")
    assert not r["ok"], r
    assert r["error"] == "not_found", r


def check_act_press_not_control(b):
    r = b.call(cmd="act.press", test_id="game")  # Node2D, not a Control
    assert not r["ok"], r
    assert r["error"] == "bad_request", r


# ---------------------------------------------------------------------------
# act.invoke
# ---------------------------------------------------------------------------

def check_act_invoke_echo(b):
    r = b.call(cmd="act.invoke", test_id="game", method="echo", args=[42])
    assert r["ok"], r
    assert r["value"] == 42, r


def check_act_invoke_vector(b):
    r = b.call(cmd="act.invoke", test_id="game", method="get_player_position", args=[])
    assert r["ok"], r
    assert r["value"]["$gd"] == "Vector2", r
    assert len(r["value"]["v"]) == 2, r


def check_act_invoke_method_not_found(b):
    r = b.call(cmd="act.invoke", test_id="game", method="no_such_method", args=[])
    assert not r["ok"], r
    assert r["error"] == "not_found", r


# ---------------------------------------------------------------------------
# act.input
# ---------------------------------------------------------------------------

def _player_x(b):
    # `player` is a ColorRect (Control): its global position travels through
    # `rect` (§5), not `position` (reserved for Node2D/Node3D).
    q = b.call(cmd="query", test_id="player")
    return q["nodes"][0]["rect"][0]


def check_act_input_action_move(b):
    x0 = _player_x(b)
    r = b.call(cmd="act.input", type="action", action="move_right", pressed=True)
    assert r["ok"], r
    frames = b.call(cmd="time.frames", n=10, physics=False)
    assert frames["ok"], frames
    r2 = b.call(cmd="act.input", type="action", action="move_right", pressed=False)
    assert r2["ok"], r2
    assert _player_x(b) > x0, (x0, _player_x(b))


def check_act_input_key_move(b):
    x0 = _player_x(b)
    # KEY_D == 68 (InputMap "move_right" is bound to the D key, cf. main.gd).
    r = b.call(cmd="act.input", type="key", keycode=68, pressed=True)
    assert r["ok"], r
    frames = b.call(cmd="time.frames", n=10, physics=False)
    assert frames["ok"], frames
    r2 = b.call(cmd="act.input", type="key", keycode=68, pressed=False)
    assert r2["ok"], r2
    assert _player_x(b) > x0, (x0, _player_x(b))


def check_act_input_click(b):
    r = b.call(cmd="act.input", type="click", position=[10, 10])
    if WINDOWED:
        assert r["ok"], r
    else:
        assert not r["ok"], r
        assert r["error"] == "no_display", r


def check_act_input_bad_type(b):
    r = b.call(cmd="act.input", type="not_a_type")
    assert not r["ok"], r
    assert r["error"] == "bad_request", r


# ---------------------------------------------------------------------------
# time.scale / time.frames
# ---------------------------------------------------------------------------

def check_time_scale(b):
    r = b.call(cmd="time.scale", factor=2.0)
    assert r["ok"], r
    reset = b.call(cmd="time.scale", factor=1.0)
    assert reset["ok"], reset


def check_time_frames_physics(b):
    r = b.call(cmd="time.frames", n=5, physics=True)
    assert r["ok"], r


def check_time_frames_zero(b):
    r = b.call(cmd="time.frames", n=0)
    assert r["ok"], r


# ---------------------------------------------------------------------------
# wait_for
# ---------------------------------------------------------------------------

def check_wait_for_property_out_of_order(b):
    """Sends wait_for before the act.press that satisfies it: the act.press
    response (synchronous, fast) typically arrives before the wait_for's
    (asynchronous) — a direct exercise of out-of-order `id` correlation."""
    target = str(_ctx["score"] + 1)
    wait_id = b.send(cmd="wait_for", test_id="score_label", property="text", equals=target, timeout_ms=3000)
    press_id = b.send(cmd="act.press", test_id="score_button")

    press_resp = b.recv(press_id)
    assert press_resp["ok"], press_resp
    _ctx["score"] += 1

    wait_resp = b.recv(wait_id)
    assert wait_resp["ok"], wait_resp
    assert wait_resp["node"]["text"] == target, wait_resp


def check_wait_for_multiple_simultaneous(b):
    """Two wait_for in flight at the same time, resolved by two successive presses."""
    target_a = str(_ctx["score"] + 1)
    target_b = str(_ctx["score"] + 2)
    id_a = b.send(cmd="wait_for", test_id="score_label", property="text", equals=target_a, timeout_ms=3000)
    id_b = b.send(cmd="wait_for", test_id="score_label", property="text", equals=target_b, timeout_ms=3000)

    press1 = b.call(cmd="act.press", test_id="score_button")
    assert press1["ok"], press1
    _ctx["score"] += 1
    resp_a = b.recv(id_a)
    assert resp_a["ok"], resp_a
    assert resp_a["node"]["text"] == target_a, resp_a

    press2 = b.call(cmd="act.press", test_id="score_button")
    assert press2["ok"], press2
    _ctx["score"] += 1
    resp_b = b.recv(id_b)
    assert resp_b["ok"], resp_b
    assert resp_b["node"]["text"] == target_b, resp_b


def check_wait_for_signal(b):
    wait_id = b.send(cmd="wait_for", test_id="score_button", signal="pressed", timeout_ms=3000)
    press = b.call(cmd="act.press", test_id="score_button")
    assert press["ok"], press
    _ctx["score"] += 1
    resp = b.recv(wait_id)
    assert resp["ok"], resp


def check_wait_for_plain(b):
    r = b.call(cmd="wait_for", test_id="player", timeout_ms=1000)
    assert r["ok"], r
    assert r["node"]["test_id"] == "player", r


def check_wait_for_ambiguous(b):
    r = b.call(cmd="wait_for", test_id="dup_demo", timeout_ms=300)
    assert not r["ok"], r
    assert r["error"] == "ambiguous", r


def check_wait_for_timeout_not_found(b):
    r = b.call(cmd="wait_for", test_id="no_such_thing_ever", timeout_ms=300)
    assert not r["ok"], r
    assert r["error"] == "timeout", r


def check_wait_for_timeout_property_never_true(b):
    r = b.call(cmd="wait_for", test_id="score_label", property="text", equals="never_this_value", timeout_ms=300)
    assert not r["ok"], r
    assert r["error"] == "timeout", r


def check_wait_for_missing_selector(b):
    r = b.call(cmd="wait_for", timeout_ms=300)
    assert not r["ok"], r
    assert r["error"] == "bad_request", r


def check_wait_for_method_out_of_order(b):
    """"method" mode (§4, parameterized domain query): sends the wait_for
    before the act.press that satisfies it — `score_at_least(args)` is
    called again every frame until it returns `equals`."""
    target = _ctx["score"] + 1
    wait_id = b.send(cmd="wait_for", test_id="game", method="score_at_least",
                     args=[target], equals=True, timeout_ms=3000)
    press_id = b.send(cmd="act.press", test_id="score_button")

    press_resp = b.recv(press_id)
    assert press_resp["ok"], press_resp
    _ctx["score"] += 1

    wait_resp = b.recv(wait_id)
    assert wait_resp["ok"], wait_resp
    assert wait_resp["node"]["test_id"] == "game", wait_resp


def check_wait_for_method_timeout(b):
    r = b.call(cmd="wait_for", test_id="game", method="score_at_least",
               args=[9999], equals=True, timeout_ms=300)
    assert not r["ok"], r
    assert r["error"] == "timeout", r


def check_wait_for_method_not_found(b):
    """A missing method will never resolve over time: immediate `bad_request`
    failure (same rule as a missing signal), never a silent timeout."""
    r = b.call(cmd="wait_for", test_id="game", method="no_such_method",
               args=[], equals=True, timeout_ms=3000)
    assert not r["ok"], r
    assert r["error"] == "bad_request", r


# ---------------------------------------------------------------------------
# time.step_until (ticket #37): deterministic advance-until-condition,
# frame-budgeted sibling of wait_for — same condition vocabulary minus
# `signal` (docs/adr/0007-time-step-until-as-a-new-verb.md).
# ---------------------------------------------------------------------------

def check_step_until_plain(b):
    """Presence mode, condition already true at registration: resolves on
    the very first `Dispatch.poll()` (same frame), `frames == 0`."""
    r = b.call(cmd="time.step_until", test_id="player", max_frames=30)
    assert r["ok"], r
    assert r["node"]["test_id"] == "player", r
    assert r["frames"] == 0, r


def check_step_until_property_out_of_order(b):
    """Sends time.step_until before the act.press that satisfies it — same
    out-of-order correlation exercise as wait_for's, but frame-budgeted."""
    target = str(_ctx["score"] + 1)
    step_id = b.send(cmd="time.step_until", test_id="score_label",
                      property="text", equals=target, max_frames=180)
    press_id = b.send(cmd="act.press", test_id="score_button")

    press_resp = b.recv(press_id)
    assert press_resp["ok"], press_resp
    _ctx["score"] += 1

    step_resp = b.recv(step_id)
    assert step_resp["ok"], step_resp
    assert step_resp["node"]["text"] == target, step_resp
    assert isinstance(step_resp["frames"], int) and step_resp["frames"] >= 0, step_resp


def check_step_until_method_out_of_order(b):
    """"method" mode (§4): `score_at_least(args)` re-called every step until
    it returns `equals` — same domain-query vocabulary as wait_for."""
    target = _ctx["score"] + 1
    step_id = b.send(cmd="time.step_until", test_id="game", method="score_at_least",
                      args=[target], equals=True, max_frames=180)
    press_id = b.send(cmd="act.press", test_id="score_button")

    press_resp = b.recv(press_id)
    assert press_resp["ok"], press_resp
    _ctx["score"] += 1

    step_resp = b.recv(step_id)
    assert step_resp["ok"], step_resp
    assert step_resp["node"]["test_id"] == "game", step_resp


def check_step_until_signal_rejected(b):
    """`signal` is deliberately out of scope for time.step_until (a one-shot
    event doesn't fit a frame budget) — immediate `bad_request`, never a
    silent timeout."""
    r = b.call(cmd="time.step_until", test_id="score_button", signal="pressed", max_frames=30)
    assert not r["ok"], r
    assert r["error"] == "bad_request", r


def check_step_until_missing_selector(b):
    r = b.call(cmd="time.step_until", max_frames=30)
    assert not r["ok"], r
    assert r["error"] == "bad_request", r


def check_step_until_ambiguous(b):
    r = b.call(cmd="time.step_until", test_id="dup_demo", max_frames=30)
    assert not r["ok"], r
    assert r["error"] == "ambiguous", r


def check_step_until_method_not_found(b):
    r = b.call(cmd="time.step_until", test_id="game", method="no_such_method",
               args=[], equals=True, max_frames=30)
    assert not r["ok"], r
    assert r["error"] == "bad_request", r


def check_step_until_timeout_property_never_true(b):
    """Budget exhaustion resolves as `timeout` (same error code as wait_for,
    §4/errors.gd) after exactly `max_frames` engine frames — the response
    carries `frames`, which a caller can check to prove the resolution is
    frame-bounded, not wall-clock-bounded."""
    r = b.call(cmd="time.step_until", test_id="score_label",
               property="text", equals="never_this_value", max_frames=5)
    assert not r["ok"], r
    assert r["error"] == "timeout", r
    assert r["frames"] == 5, r


def check_step_until_determinism(b):
    """The frame budget is exhausted after exactly `max_frames` engine frames
    on every run, independent of real elapsed wall-clock time — unlike
    wait_for's `timeout_ms` (necessarily wall-clock-variable), this must be
    bit-for-bit identical across repeated calls (extra guardrail #5)."""
    frames_seen = []
    for _ in range(5):
        r = b.call(cmd="time.step_until", test_id="score_label",
                    property="text", equals="never_this_value", max_frames=7)
        assert not r["ok"], r
        assert r["error"] == "timeout", r
        frames_seen.append(r["frames"])
    assert frames_seen == [7] * 5, frames_seen


def check_step_until_resolves_after_n_frames(b):
    """Extra guardrail #5 for the *resolving* path, not just the timeout
    path above: `check_step_until_property_out_of_order` resolves via a
    second network message (`act.press`) whose exact arrival frame this
    suite doesn't control, so it only asserts `frames >= 0`, never a pinned
    value. `true_after_n_frames` flips purely from the fixture's own
    per-frame state with no second message involved, so the resolving path
    itself must also be bit-for-bit reproducible across runs."""
    frames_seen = []
    for _ in range(5):
        r = b.call(cmd="time.step_until", test_id="game",
                    method="true_after_n_frames", args=[6], equals=True, max_frames=30)
        assert r["ok"], r
        frames_seen.append(r["frames"])
    assert frames_seen == [6] * 5, frames_seen


# ---------------------------------------------------------------------------
# transport robustness: peer disconnected during a pending wait_for (#21)
# ---------------------------------------------------------------------------

def check_wait_for_peer_disconnect(b):
    """A second client sends a `wait_for` whose condition never becomes true
    (`score_label.text` will never equal `__never__`, `timeout_ms` far
    beyond the test's window), then closes its socket without ever reading
    a response.

    A "plain" `wait_for` on a selector already satisfied (`test_id="player"`,
    tried initially) resolves as early as the very first `Dispatch.poll()`
    following its registration — before a real `StreamPeerTCP` could even
    notice the OS-side closure (verified empirically: detection only
    happens at the poll() *following* the one that read the request, cf.
    transport.gd) — which would never exercise the liveness guard (issue
    #21). Here the entry must stay `pending` for the whole test window,
    giving `transport.gd` time to detect the disconnect before `dispatch.gd`
    tries again to resolve it.

    The black-box suite can only prove "no crash": the timing of TCP
    closure detection by `StreamPeerTCP` is not guaranteed across
    platforms/Godot versions (cf. comments in transport.gd/dispatch.gd).
    The direct assertion on `_pending` and on `Transport.send`'s no-op
    lives in `transport_liveness_test.gd`, independent of that timing."""
    dead = socket.create_connection(("127.0.0.1", PORT), timeout=5)
    dead.sendall((json.dumps({
        "id": 1, "cmd": "wait_for", "test_id": "score_label",
        "property": "text", "equals": "__never__", "timeout_ms": 60000,
    }) + "\n").encode())
    dead.close()

    # Let several frames elapse: the orphaned pending entry must be purged
    # (or its response silently swallowed) without ever crashing the process.
    for _ in range(5):
        r = b.call(cmd="time.frames", n=3)
        assert r["ok"], r

    # Indirect proof of non-regression: the main connection still responds
    # normally (if the process had crashed, this would raise).
    r = b.call(cmd="hello")
    assert r["ok"], r


def check_step_until_peer_disconnect(b):
    """Same liveness guard as `check_wait_for_peer_disconnect` (issue #21),
    exercised for a `time.step_until` pending entry (ticket #37, extra
    guardrail #6): a never-true condition with a large `max_frames` budget,
    dropped by its peer before ever reading the response."""
    dead = socket.create_connection(("127.0.0.1", PORT), timeout=5)
    dead.sendall((json.dumps({
        "id": 1, "cmd": "time.step_until", "test_id": "score_label",
        "property": "text", "equals": "__never__", "max_frames": 100000,
    }) + "\n").encode())
    dead.close()

    for _ in range(5):
        r = b.call(cmd="time.frames", n=3)
        assert r["ok"], r

    r = b.call(cmd="hello")
    assert r["ok"], r


# ---------------------------------------------------------------------------
# screenshot
# ---------------------------------------------------------------------------

def check_screenshot(b):
    r = b.call(cmd="screenshot")
    if WINDOWED:
        assert r["ok"], r
        assert isinstance(r["image_base64"], str) and r["image_base64"], r
    else:
        assert not r["ok"], r
        assert r["error"] == "no_renderer", r


# ---------------------------------------------------------------------------
# quit (ticket #20) — lifecycle verb, not in CHECKS: it terminates the
# process, so it's only exercised once at the very end of the run (see main()).
# ---------------------------------------------------------------------------

def shutdown_clean(proc: subprocess.Popen, b: "Bridge", grace_s: float = 10.0) -> int:
    """Clean shutdown of the driven process (ticket #20): the `quit` verb
    (the game responds then calls `get_tree().quit()`, DRAFT-v0.md §4) lets
    the process exit on its own (exit code 0) — never a direct `kill` on the
    nominal run (macOS crash notification + polluted end-of-run logs,
    dogfooding/FRICTIONS.md #4). If the grace period expires, escalates
    straight to SIGKILL — never SIGTERM: the .NET runtime of Godot mono
    builds intercepts it and aborts (SIGABRT), i.e. the very macOS crash
    popup this ladder exists to avoid, while SIGKILL leaves no crash
    report."""
    try:
        r = b.call(cmd="quit")
        assert r["ok"], r
    except Exception:
        pass  # the Bridge may have already closed the connection — fall back to SIGKILL
    try:
        return proc.wait(timeout=grace_s)
    except subprocess.TimeoutExpired:
        proc.kill()  # last resort
        return proc.wait(timeout=5)


# ---------------------------------------------------------------------------
# port-file: `--bridge-port=0` + `--bridge-port-file` (issue #21)
# ---------------------------------------------------------------------------

def check_port_file() -> float:
    """`--bridge-port=0` delegates port selection to the OS; `transport.gd
    listen()` writes it to `--bridge-port-file` (godot-e2e-style CI
    parallelism, DRAFT-v0.md §2). Until now only checked by hand + on the TS
    client side — never in black box on the repo side (issue #21).

    Dedicated Godot process (dynamic port, so not shareable with `PORT`,
    fixed, used by the rest of the suite): launches, waits for the file to
    appear and fill in, reads the port, then performs a full handshake on
    it. Returns the boot time for the final summary."""
    t0 = time.perf_counter()
    tmp_dir = tempfile.mkdtemp(prefix="playtest-port-file-")
    port_file = os.path.join(tmp_dir, "bridge-port.txt")
    args = [GODOT, "--path", PROJECT]
    if not WINDOWED:
        args.append("--headless")
    args += ["--", "--playtest", "--bridge-port=0", f"--bridge-port-file={port_file}"]
    proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    try:
        deadline = time.time() + 30
        content = ""
        while not content:
            if os.path.exists(port_file):
                with open(port_file) as f:
                    content = f.read().strip()
            if not content:
                if time.time() > deadline:
                    raise TimeoutError("bridge-port-file never appeared or stayed empty")
                time.sleep(0.05)
        port = int(content)
        assert port > 0, content

        b = Bridge(port)
        r = b.call(cmd="hello")
        assert r["ok"], r
        b.call(cmd="query")

        code = shutdown_clean(proc, b)
        assert code == 0, f"expected exit 0 after clean 'quit', got {code}"
        return time.perf_counter() - t0
    except BaseException:
        if proc.poll() is None:
            proc.kill()
        out = proc.stdout.read().decode(errors="replace")[-2000:]
        print("---godot output (port-file)---\n" + out, file=sys.stderr)
        raise
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


CHECKS = [
    check_hello,
    check_query_all,
    check_query_test_id,
    check_query_state_contract,
    check_query_state_contract_pascal,
    check_query_group,
    check_query_group_empty,
    check_query_path,
    check_query_not_found,
    check_query_path_not_found,
    check_query_ambiguous,
    check_unknown_cmd,
    check_act_press,
    check_act_press_ambiguous,
    check_act_press_not_found,
    check_act_press_not_control,
    check_act_invoke_echo,
    check_act_invoke_vector,
    check_act_invoke_method_not_found,
    check_act_input_action_move,
    check_act_input_key_move,
    check_act_input_click,
    check_act_input_bad_type,
    check_time_scale,
    check_time_frames_physics,
    check_time_frames_zero,
    check_wait_for_property_out_of_order,
    check_wait_for_multiple_simultaneous,
    check_wait_for_signal,
    check_wait_for_plain,
    check_wait_for_ambiguous,
    check_wait_for_timeout_not_found,
    check_wait_for_timeout_property_never_true,
    check_wait_for_missing_selector,
    check_wait_for_method_out_of_order,
    check_wait_for_method_timeout,
    check_wait_for_method_not_found,
    check_wait_for_peer_disconnect,
    check_step_until_plain,
    check_step_until_property_out_of_order,
    check_step_until_method_out_of_order,
    check_step_until_signal_rejected,
    check_step_until_missing_selector,
    check_step_until_ambiguous,
    check_step_until_method_not_found,
    check_step_until_timeout_property_never_true,
    check_step_until_determinism,
    check_step_until_resolves_after_n_frames,
    check_step_until_peer_disconnect,
    check_screenshot,
]


def main():
    t0 = time.perf_counter()
    args = [GODOT, "--path", PROJECT]
    if not WINDOWED:
        args.append("--headless")
    args += ["--", "--playtest", f"--bridge-port={PORT}"]
    proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    try:
        b = Bridge(PORT)
        t_boot = time.perf_counter() - t0

        for check in CHECKS:
            check(b)

        code = shutdown_clean(proc, b)
        assert code == 0, f"expected exit 0 after clean 'quit', got {code}"

        port_file_boot_s = check_port_file()

        total = time.perf_counter() - t0
        print(json.dumps({
            "ok": True, "windowed": WINDOWED, "boot_s": round(t_boot, 2),
            "total_s": round(total, 2), "checks": len(CHECKS) + 1,  # + quit
            "port_file_boot_s": round(port_file_boot_s, 2),
        }))
    except BaseException:
        if proc.poll() is None:
            proc.kill()
        out = proc.stdout.read().decode(errors="replace")[-2000:]
        print("---godot output---\n" + out, file=sys.stderr)
        raise


if __name__ == "__main__":
    main()
