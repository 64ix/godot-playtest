# godot-playtest protocol — draft v0

> Status: draft (resolves ticket #6). This document specifies the protocol as an
> **open standard**, independent of the addon and MCP server implementations.
> Versioning: the protocol carries a number (`protocol: 0`); every evolution is
> **additive** — a verb or field never changes meaning, it's added or deprecated.

## 1. Principles

1. **State-first**: the unit of exchange is the game's state (nodes, properties, signals,
   domain), not the pixel. The screenshot exists but is never an oracle.
2. **Semantic by default**: actions target nodes by selector
   (`press` on a test-id), not screen coordinates. Positional is an explicit
   fallback, unavailable in headless.
3. **Never blocking**: the Bridge lives in the game's main loop. Every wait
   (`wait_for`) is asynchronous on the Bridge side, re-evaluated every frame with a deadline.
   Responses may arrive out of order → every request carries a mandatory correlation
   `id`.
4. **Dormant by default**: the Bridge only listens if the build embeds the `playtest`
   export feature **or** if the game is launched with `--playtest` (user args, after
   `--`). Without opt-in: zero socket, zero overhead, zero attack surface.
5. **Two projections, one API**: the same verb surface exists as a
   **network projection** (JSON-lines over TCP loopback — for the agent via the MCP
   server) and as an **in-process projection** (GDScript API — for frozen tests, which
   run without network or AI). The protocol specifies the verbs; the projections
   are merely encodings of them.

## 2. Transport (network projection)

- **TCP loopback** (`127.0.0.1`), **JSON-lines**: one request = one JSON object + `\n`.
  Chosen over WebSocket/binary: debuggable with telnet, no dependencies, sufficient
  (spikes #4/#5: median RTT ~8 ms, quantized to the frame — the Bridge pumps in
  `_process`).
- **Port**: `--bridge-port=N`; `N=0` = random port written to the file given by
  `--bridge-port-file=<path>` (CI parallelism, godot-e2e pattern).
- **Handshake**: first request `hello` → the Bridge replies
  `{protocol: 0, engine: "4.6.3", state_contract: 0, capabilities: [...]}`.
  A client MUST check `protocol` before issuing any command.
- Request: `{"id": <int>, "cmd": "<verb>", ...params}`.
  Response: `{"id": <int>, "ok": true, ...} | {"id": <int>, "ok": false, "error": "<code>", "detail": "..."}`.

## 3. Selectors

Three levels, from most stable to most fragile — a frozen scenario MUST use the
highest level available:

| Level | Form | Stability |
|---|---|---|
| 1. **test-id** | `{"test_id": "score_button"}` — `test_id` meta set on the node (`set_meta`) | survives scene refactors |
| 2. **group** | `{"group": "actors"}` | survives renames, may match N nodes |
| 3. **NodePath** | `{"path": "/root/Main/Player"}` | fragile, reserved for exploration |

- **Strict mode**: a selector used in an *action* that resolves to several
  nodes is an **explicit error** (`error: "ambiguous"`, with the list of
  candidates) — never "the first one found". `query`, on the other hand, can
  return N nodes.
- **Rich diagnostics**: a selector that doesn't resolve returns
  `error: "not_found"` + the known test-ids plausibly close to the query
  (empty when none is close enough — never a filler suggestion; helps
  maintain frozen tests — pain point #1 documented across AltTester/godot-e2e).

## 4. Verbs (v0)

The core fits in **9 verbs** at v0. Everything else is an opt-in capability
(announced in `hello`), following the Playwright MCP model — no explosion
into 150 tools. Ticket #37 additively adds a 10th interaction verb,
`time.step_until` (below): still no capability gate — see its own note.

| Verb | Params | Return | Notes |
|---|---|---|---|
| `hello` | — | version, contract, capabilities | mandatory on opening |
| `query` | selector (optional: no selector = all nodes with a `test_id`) | list of node descriptions (§5) | the equivalent of an accessibility snapshot |
| `act.press` | selector | ok | **semantic** activation of a Control (routes signal/action, no hit-testing) — the only "click" that works in headless (#5) |
| `act.input` | `type: action\|key\|click`, params | ok | low-level injection (`Input.parse_input_event`). Positional `click` = `windowed` capability only |
| `act.invoke` | selector, `method`, `args[]` | serialized value | reflection, the accepted escape hatch |
| `wait_for` | selector [+ `property`/`equals` \| `signal` \| `method`/`args`/`equals`], `timeout_ms` | node description or `error: "timeout"` | asynchronous, THE anti-flake building block (never a sleep) |
| `time.scale` | `factor` | ok | fast-forward (`Engine.time_scale`) |
| `time.frames` | `n`, `physics: bool` | ok after n frames | fine-grained sync |
| `time.step_until` | selector [+ `property`/`equals` \| `method`/`args`/`equals`], `max_frames`, `timeout_ms` (optional) | node description + `frames` elapsed, or `error: "timeout"` | deterministic advance-until-condition, frame-budgeted (ticket #37) |
| `screenshot` | — | PNG base64 | **best effort, never an oracle**; in headless: `error: "no_renderer"` |

- **`wait_for` `method` mode — parameterized domain query**: when the
  expected state isn't the property of any single node (a large collection
  queried by key, a computed state), the selector designates the *manager*
  node and `method`+`args` the domain read, re-called every frame until
  its return value (Variant→JSON mapping) equals `equals` — the composition of
  `act.invoke` (reflection) and `wait_for` (waiting), with no new verb.
  Contract: the method MUST be a **pure read** (it is called every
  frame); a method absent from the resolved node is an immediate
  `bad_request` (like an absent signal — it won't resolve itself over time).
  The associated instrumentation pattern ("tag the manager, not the
  10,000 elements") is documented in
  [docs/INSTRUMENTATION.md](../INSTRUMENTATION.md).
- **`time.scale` is local to the process**: it only accelerates the driven
  game's engine. In a network or server-authoritative game, the time that
  matters lives elsewhere — `time.scale` is a silent lie there. The
  protocol's answer isn't one more verb: as with `_test_state()`, **the
  game exposes its own domain accelerator** (a debug method callable
  via `act.invoke`), see [docs/INSTRUMENTATION.md](../INSTRUMENTATION.md)
  § "Domain time".
- **`time.step_until`** (ticket #37, additive — see
  [ADR-0007](../adr/0007-time-step-until-as-a-new-verb.md) for the surface
  decision and the rejected alternatives): deterministically advances the
  game frame-by-frame, re-evaluating a condition between advances, until it
  holds or the budget is exhausted. Reuses `wait_for`'s condition vocabulary
  **minus `signal`** (a one-shot event doesn't fit a frame-stepped budget —
  out of scope by design): no selector-following params = plain node
  presence, `property`+`equals`, or the parameterized `method`+`args`+`equals`
  domain query (same pure-read contract as `wait_for`'s). The budget is
  primarily `max_frames` (the deterministic axis — default 300, ~5s at
  60 FPS); `timeout_ms` is an **optional wall-clock safety net only**, never
  the intended way to bound a scenario. Both a success and an `error:
  "timeout"` response carry `frames`: the number of engine frames elapsed
  between registration and resolution — reproducible run to run, unlike
  `wait_for`'s wall-clock `timeout_ms`, which is the whole point: a Frozen
  test replaying this primitive (#38/#39) resolves after the same number of
  frames every time, in CI or locally. Like `time.scale`/`time.frames`, it only
  advances the **local** engine clock — the same "domain accelerator" answer
  applies for network/server-authoritative games (previous bullet). Not
  gated behind a `hello` capability: as with the rest of `time.*`, it works
  unconditionally, headless included (ADR-0007). **Scope**: this ticket
  landed the network projection (`dispatch.gd`) only; per
  [ADR-0006](../adr/0006-in-process-network-projection-parity.md), the
  in-process mirror on `PlaytestCase` was ticket #38's job (blocked on #35);
  Trace/`freeze_scenario` replay support was ticket #39's job — both have
  now landed (see ADR-0007's scope note for the details).

Capabilities considered for v0, out of core scope: `seed` (deterministic RNG — requires
the game's cooperation), `logs` (capture `push_error`/`print`), `scene`
(load/reload), `record` (v3, recorder).

In addition to these 10 interaction verbs, an 11th verb covers the
process **lifecycle** rather than a game action:

| Verb | Params | Return | Notes |
|---|---|---|---|
| `quit` | `code` (optional, default `0`) | ok | clean shutdown (ticket #20): the Bridge replies, then calls `SceneTree.quit(code)` — the response is already on the socket before the process stops. Never replayed in a frozen test (a session verb, like `hello`) |

- **Why not an external `kill`/`SIGKILL` by default**: an abnormal exit
  triggers a "quit unexpectedly" notification on the OS side
  (macOS) and leaves engine error lines at the end of the log
  (`dogfooding/FRICTIONS.md` #4) — a noise signal that complicates
  reading CI logs. A harness driving the game (test scenario,
  MCP server, dogfooding) MUST call `quit` with a grace delay before any
  `kill`, which remains the last-resort safety net if the process doesn't
  exit within the given delay. That last resort MUST be SIGKILL, never
  SIGTERM: the .NET runtime of Godot mono builds intercepts SIGTERM and
  calls `exit()` from a secondary thread, crashing the engine's static
  destructors (SIGABRT → the very OS crash popup + report this rule
  exists to avoid), whereas SIGKILL bypasses handlers and leaves no
  crash report.

**Serialization**: native JSON for bool/int/float/String/Array/Dictionary;
`Vector2/3`, `Color`, etc. encoded as `{"$gd": "Vector2", "v": [x, y]}` — canonical
mapping fixed in [ANNEX-variant-json.md](ANNEX-variant-json.md) (ticket #8).

## 5. State contract `_test_state()` (versioned: `state_contract: 0`)

The node description returned by `query`/`wait_for`:

```json
{
  "test_id": "score_button",      // if meta present
  "name": "ScoreButton",
  "class": "Button",
  "path": "/root/Main/ScoreButton",
  "groups": ["ui"],
  "visible": true,                 // CanvasItem
  "rect": [280, 60, 56, 31],       // Control: global position + size
  "position": [50, 200],           // Node2D/Node3D: global position
  "text": "Score!",                // if the node exposes get_text()
  "state": { ... }                 // ← domain contract, see below
}
```

- **`state`**: if the node (or its script) defines `func _test_state() -> Dictionary`,
  the Bridge calls it and embeds the result as-is. This is the channel through which a
  game exposes its **domain** (HP, inventory, game phase) without the tool guessing.
  **C# convention**: Godot exposes C# methods under their real name — a C# node
  defines `Godot.Collections.Dictionary _TestState()` (PascalCase) and the Bridge
  tries both names, `_test_state` (canonical) then `_TestState`. Same contract,
  same return shape.
  A convention absent from all the tools autopsied (#3) — it's a differentiator, and
  it is **versioned**: the `hello`'s `state_contract` field increments if the
  generic shape changes.
- No dependency on `EditorInterface`: the whole contract is achievable with the
  runtime API (`SceneTree`, `Node`) — a survival condition in an exported build (#3, #4).
- The protocol does **not** impose a role taxonomy (no ARIA equivalent in
  Godot): semantics come from `test_id`, groups, and `_test_state()`.

## 6. Degradation matrix

| Verb | Windowed | `--headless` (CI) |
|---|---|---|
| `query`, `act.press`, `act.invoke`, `wait_for`, `time.*`, `quit` | ✅ | ✅ |
| `act.input` type `action`/`key` | ✅ | ✅ |
| `act.input` type `click` (positional) | ✅ | ❌ `error: "no_display"` (GUI hit-testing is dead — spike #5) |
| `screenshot` | ✅ | ❌ `error: "no_renderer"` |

A frozen test that only uses the right-hand column is **CI-safe by construction**;
the runner can verify this statically.

## 7. Frozen tests (in-process projection)

Per ADR-0002, a frozen test is a **GDScript script** living in the
dev's project (`res://playtests/`), executed by the addon's runner
(`godot --headless res://addons/playtest/runner.tscn -- --suite=res://playtests/`),
**in-process with the game** — no TCP, no AI. It consumes the same API as the
network verbs:

```gdscript
extends PlaytestCase

func test_score_button_increments() -> void:
    await start_game("res://main.tscn")
    var label := query_one({"test_id": "score_label"})
    await assert_now_eq(label.text, "0")
    press({"test_id": "score_button"})
    await wait_for({"test_id": "score_label", "property": "text", "equals": "1"})
```

- **`assert_now_*` vs `assert_eventually_*`** (ADR-0006): the call site
  names which semantics it means, never the argument's type — each rejects
  the other's argument kind as a recorded failure. `assert_now_*` takes an
  already-evaluated value and compares it once, immediately, with no wait
  (for a check that directly follows `start_game()` or another
  synchronization point, where there's nothing left to settle);
  `assert_eventually_*` takes a no-argument `Callable` and **retries until
  timeout** (web-first assertions) — the canonical form for a value that
  settles over time. Same rule for the selector+property sugar:
  `assert_now_property`/`assert_eventually_property`. A failure carries a
  full `query` dump in the report. `assert_now_*` still runs after a
  selector has already failed to resolve (constant cost, cannot hang);
  `assert_eventually_*` is skipped in that case (nothing to await from an
  already-broken selector).
- Lifecycle: the agent explores via MCP (network projection) → proposes a
  **plan readable in Markdown** (human checkpoint, Playwright test-agents pattern) →
  **freezes** the script by checking every selector against the live game → the
  CI runner replays it.
- The choice of runner (dedicated scene vs. gdUnit4 integration) remains open → to
  be decided at implementation time, out of scope for the protocol.

## 8. Guards

- The Bridge REFUSES to start if `OS.has_feature("release")` without the
  explicit `playtest` feature; the tooling provides a CI check that **fails the
  production build** if the Bridge autoload is present in a preset without the
  feature (AltTester lesson: manual separation without a guard ends up shipped).
- Loopback only in v0; no authentication — the protocol isn't designed
  to cross a machine boundary.

---

*Inputs: autopsy of existing protocols (#3), exported-bridge spike (#4), headless CI
spike (#5), product decisions (#2 / ADR-0001..0003). Structuring choices motivated
in ADR-0004.*
