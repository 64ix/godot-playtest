# addons/playtest

The Bridge: a dormant GDScript autoload that exposes the live game over TCP
loopback JSON-lines, compliant with the protocol
[docs/protocol/DRAFT-v0.md](../../docs/protocol/DRAFT-v0.md).

Ticket #8 laid down the "read" half: transport, `hello`, `query`,
selectors, typed errors. Ticket #9 adds the "action" half:
`act.press`, `act.input`, `act.invoke`, `wait_for` (asynchronous), `time.scale`,
`time.frames`, `screenshot`, with the headless degradation matrix (§6).
Ticket #10 adds the export guard
(section [Security](#security--export-guard) below). Ticket #11
adds the **in-process projection** (`PlaytestCase` + `runner.gd`/
`runner.tscn`, section [Frozen tests](#frozen-tests-playtestcase--runner-ticket-11)
below): frozen tests live under `res://playtests/`, replayed without
network or AI. Ticket #37 adds `time.step_until`, a deterministic
frame-budgeted sibling of `wait_for` (section
[`time.step_until`](#implementation-decision-timestep_until-ticket-37)
below) on the network projection; ticket #38 mirrors it onto `PlaytestCase`
as `time_step_until`, so a Frozen test uses the same primitive (§1.5 "two
projections, one API").

## Installation

1. Get `addons/playtest/` into the target project, either way:
   - **Godot Asset Library** (AssetLib tab in the editor, search "Playtest")
     once listed — see [docs/RELEASE.md](../../docs/RELEASE.md) for
     submission status;
   - **Manual**: copy `addons/playtest/` into the target project.
2. Enable the Bridge — two equivalent ways:
   - **Editor**: Project Settings > Plugins > enable "Playtest" (adds
     the `TestBridge` autoload automatically, removes it if disabled);
   - **Manual**: Project Settings > Autoload > add
     `res://addons/playtest/bridge.gd` under the name `TestBridge`.

License: MIT ([`LICENSE`](../../LICENSE) at the repo root). `plugin.cfg`'s
`version` and the npm package's `version` (`mcp-server/package.json`) are
independent — see [docs/RELEASE.md](../../docs/RELEASE.md) for why the
protocol version (`hello`'s `protocol` field) is the actual compatibility
anchor between the two.

## Runtime activation

The Bridge stays **dormant** (no socket opened) unless one of the following
conditions is true:

- the build embeds the `playtest` export feature (Export > Presets >
  Features);
- the game is launched with `--playtest` as a user argument, after `--`:
  `godot --path . -- --playtest`.

On a **release export**, these two conditions alone are not enough: see
[Security](#security--export-guard).

## Port options

- `--bridge-port=<N>`: fixed port (default `4242`).
- `--bridge-port=0` + `--bridge-port-file=<path>`: random port chosen by
  the OS, written to the given file — useful for parallelizing CI runs without
  port collisions (godot-e2e pattern).

## Code layout

| File | Role |
|---|---|
| `bridge.gd` | Autoload: lifecycle (dormant/active), `_process` loop, transport ↔ dispatch wiring |
| `transport.gd` | TCP loopback JSON-lines: accepts connections, splits lines, sends responses. Knows nothing about the protocol. |
| `dispatch.gd` | One verb (`cmd`) → one response. Contains the protocol semantics (§4 of the draft). |
| `selectors.gd` | test-id / group / NodePath resolution (§3). Pure functions over the scene tree. |
| `state.gd` | Node description conforming to the `_test_state()` contract (§5). |
| `variant_json.gd` | Variant → JSON mapping, see [ANNEX-variant-json.md](../../docs/protocol/ANNEX-variant-json.md). |
| `errors.gd` | Constructors for typed error responses (`not_found`, `ambiguous`, ...). |
| `activation_policy.gd` | Pure function: decides whether the Bridge starts (release build, feature, `--playtest` arg). Anti-instrumented-prod guard, see security below. |
| `export_guard_check.gd` | CI script: inspects `export_presets.cfg`, fails if a preset embeds the Bridge without being authorized to. |
| `playtestcase.gd` | In-process projection of the verbs (§1.5, §7): base class `PlaytestCase` inherited by each frozen test — `query`/`query_one`, `press`, `invoke`, asynchronous `wait_for`, `assert_now_*`/`assert_eventually_*`, `attach_instance` (spec #66). |
| `playtest_client.gd` | `PlaytestClient` (spec #66): the second-client handle `attach_instance` returns — a hand-rolled TCP JSON-lines client mirroring `mcp-server/src/bridge-client.ts`. See [Multi-client frozen tests](#multi-client-frozen-tests-spec-66) below. |
| `instance_name.gd` | Instance-name validation shared by `attach_instance` (spec #66) — mirrors `mcp-server/src/instance-name.ts`. |
| `runner.gd` / `runner.tscn` | Headless runner: discovers scripts under `--suite=<dir>`, or the single `.gd` file it names, runs each `test_*()` sequentially, report + exit code. Resets `Engine.time_scale` to 1.0 and sends a best-effort `quit` to every attached instance once, at the very end of the run (spec #66). |

## Security — export guard

**AltTester lesson: never ship an instrumented prod build by
accident.** The Bridge protects itself at two independent levels:

1. **Runtime** (`activation_policy.gd`, applied by `bridge.gd` at
   `_ready()`): on a **release** export (`OS.has_feature("template_release")`),
   the Bridge refuses to start and logs an explicit error
   (`push_error`) **unless** the `playtest` export feature is present.
   On a release build, the `--playtest` argument alone is **never** enough —
   the feature must have been set on the preset at export time
   (Project > Export > preset > Features), not slipped in on the command line
   when launching the binary.
2. **CI / export configuration** (`export_guard_check.gd`): a static check
   that inspects `export_presets.cfg` and fails if a preset **without** the
   `playtest` feature would still embed the `TestBridge` autoload (neither
   the feature nor an `exclude_filter` excluding `addons/playtest/*`). Run
   with:

   ```sh
   godot --headless --path . --script res://addons/playtest/export_guard_check.gd -- --project=<project_path>
   ```

   Exit `0` = all "prod" presets exclude the Bridge (feature or explicit
   exclusion). Exit `1` = at least one prod export was accidentally
   instrumented. Associated test suite:
   [`tests/export_guard/`](../../tests/export_guard) (fixtures
   `prod_instrumented` → fails, `prod_legit_feature` /
   `prod_legit_excluded` → pass), wired into CI
   ([`.github/workflows/export-guard.yml`](../../.github/workflows/export-guard.yml)).

## Implementation decision: `query` and single-target selectors

§3 of the protocol reserves strict mode (`ambiguous` error if a selector
resolves to several nodes) for **actions**. For `query`, this ticket adopts
the following rule, consistent with the selector table (test-id and
NodePath designate a single node; group designates a set):

- `test_id` and `path` target a single node: 0 results → `not_found`
  (with suggestions for `test_id` via Levenshtein distance over known
  test-ids); `test_id` duplicated by a configuration error → 2+
  results → `ambiguous` (with candidates). `path` cannot be
  ambiguous (a `NodePath` resolves to at most one node).
- `group` and the absence of a selector always return a list (possibly
  empty), never failing: `query` remains the equivalent of an accessibility
  snapshot, not an assertion.

## Implementation decisions: action verbs (ticket #9)

- **`act.press`** requires the resolved node to be a `Control` exposing a
  `pressed` signal (Button, CheckBox, CheckButton…) and emits it directly
  (`emit_signal`) — never hit-testing, so it's actionable in `--headless`.
  A node that isn't a `Control`, or that doesn't have this signal, returns
  `bad_request`: `act.press` doesn't guess a fallback action.
- **`act.invoke`** returns `not_found` (not a new error code) when
  the requested method doesn't exist on the resolved node: the selector did
  designate a node, but it can't honor the request.
- **`wait_for`** is queued (`Dispatch.handle` returns `null`)
  and re-evaluated every frame by `Dispatch.poll()`, called from
  `Bridge._process`. An `ambiguous` selector fails immediately (nothing to
  wait for); a `not_found` selector keeps waiting (the node may
  appear later) until it expires as `timeout`. `time.frames` (`n > 0`)
  uses the same queue (`"frames"` mode, never a deadline: the frame
  count necessarily elapses).
- **`wait_for` mode `method`** (parameterized domain query, §4):
  `method`+`args` are called again every frame on the resolved node until
  the return value (Variant→JSON mapping) equals `equals`. The method MUST be
  a pure read; a missing method is an immediate `bad_request` (same
  rule as a missing signal: it won't resolve itself with time). Mode
  priority order when several keys are present: `signal` >
  `property` > `method` (identical in both projections).
- **C# state contract** (`state.gd`, §5): the Bridge tries
  `_test_state` (GDScript canonical) then `_TestState` — the name under which
  Godot exposes a C# method. Without this second lookup, no C# node could
  publish its domain. Witness: `fixtures/witness_game/pascal_witness.gd`.
- **`act.input`/`screenshot`**: the headless refusal (`no_display`/
  `no_renderer`) is returned *before* any engine call — calling
  `get_texture()` or processing a positional click without a renderer/display
  produces an engine `ERROR` rather than a clean refusal (a pitfall documented
  by spike #5). `hello` only announces the `"windowed"` capability when
  `DisplayServer.get_name() != "headless"`.

## Implementation decision: `time.step_until` (ticket #37)

Surface decision (new verb vs. a `wait_for` budget option) and its rationale
live in [ADR-0007](../../docs/adr/0007-time-step-until-as-a-new-verb.md);
protocol shape in
[docs/protocol/DRAFT-v0.md §4](../../docs/protocol/DRAFT-v0.md#4-verbs-v0).
Implementation notes specific to `dispatch.gd`:

- **Same queue, new `"kind"`**: `_step_until` appends a `"step_until"` entry
  to the same `_pending` array as `wait_for`/`time.frames`; `poll()` gains an
  `elif entry["kind"] == "step_until"` branch. The peer-liveness purge
  (issue #21) runs *before* that branch, so a dead peer is purged exactly
  like any other pending kind, without any extra code — extended coverage in
  `tests/conformance/transport_liveness_test.gd` and
  `tests/conformance/scenario.py::check_step_until_peer_disconnect` all the
  same, mirroring the existing `wait_for` guard tests.
- **Frame counting, not a per-poll tick**: `start_frame` snapshots
  `Engine.get_process_frames()` at registration; `_poll_step_until` computes
  `elapsed = Engine.get_process_frames() - start_frame` on every
  `poll()` call. Since `bridge.gd _process()` calls `poll()` exactly once per
  idle frame, `elapsed` tracks real engine frames one-to-one — no separate
  counter to keep in sync, and no dependency on how many times `poll()`
  happens to run.
- **`signal` is rejected, not silently ignored**: `_step_until` returns
  `bad_request` immediately if the request carries `signal` (out of scope by
  design, see ADR-0007) — the same "won't resolve itself" logic already
  applied to a missing signal/method in `wait_for`, just decided ahead of
  time here instead of discovered mid-wait.
- **`frames` is spliced onto the existing `timeout` error shape**, not a new
  field on `errors.gd`'s `timeout()` helper itself: `errors.gd` builds the
  base `{"id", "ok": false, "error": "timeout", "detail"}` shape (unchanged,
  additive-only per its own doc comment), and `_poll_step_until` adds
  `"frames"` on the returned dict — the same pattern `not_found`/`ambiguous`
  already use for their own verb-specific extras (`suggestions`/
  `candidates`), just applied per-call instead of via a dedicated
  constructor parameter, since `frames` is specific to this one verb.

## Frozen tests: `PlaytestCase` + runner (ticket #11)

Two projections, one API (§1.5): `dispatch.gd` serves the network
projection, `playtestcase.gd` the in-process projection, with **the same
selector resolution** — `PlaytestSelectors.resolve_strict()` (added to
`selectors.gd` by this ticket) factors out strict mode (test-id > group >
NodePath, `ambiguous`/`not_found` + suggestions) between the two;
`dispatch.gd _resolve_selector` was rewritten to delegate to this function
rather than duplicating the logic.

A hand-written frozen test:

```gdscript
extends PlaytestCase

func test_score_button_increments() -> void:
    await start_game("res://fixtures/witness_game/main.tscn")
    var label := query_one({"test_id": "score_label"})
    await assert_now_eq(label.text, "0")
    press({"test_id": "score_button"})
    # Canonical form (§7 "retry-until-timeout"): re-resolves the selector
    # and re-reads the property until success or timeout, instead of
    # comparing an already-captured value.
    await assert_eventually_property({"test_id": "score_label"}, "text", "1")
```

Replayed with:

```sh
godot --headless --path <project> res://addons/playtest/runner.tscn -- --suite=res://playtests/
```

### Network verb ⇄ in-process method mapping

Two projections, one API (§1.5): each protocol verb has a direct
equivalent in `PlaytestCase`, with the same semantics (selectors, strict
mode, headless degradation) — only the result encoding differs (JSON
response vs. `failures` report entry).

| Network verb (`dispatch.gd`) | In-process method (`playtestcase.gd`) |
|---|---|
| `query` | `query(selector = {})` |
| `act.press` | `press(selector)` |
| `act.invoke` | `invoke(selector, method, args = [])` |
| `wait_for` | `await wait_for(selector, opts = {})` — modes `property`/`signal`/`method` (§4) |
| `time.scale` | `time_scale(factor)` |
| `time.frames` | `await time_frames(n, physics = false)` |
| `time.step_until` | `await time_step_until(selector, opts = {})` — modes `property`/`method` (no `signal`, see [ADR-0007](../../docs/adr/0007-time-step-until-as-a-new-verb.md)); returns `{"node": Node, "frames": int}` or `{"node": null, "frames": int}` on timeout |
| `act.input` | `input(params)` (ticket #13 — see below) |
| *(no network equivalent — §7 "frozen tests" semantics)* | `await assert_now_eq/assert_now_true/assert_now_false/assert_now_null/assert_now_not_null(...)`, `await assert_eventually_eq/...(...)`, `await assert_now_property(...)` / `await assert_eventually_property(selector, property, expected, ...)` |
| `screenshot` | Out of scope for in-process (§1.5): never an oracle (state-first), nothing to replay deterministically. |

`input(params)` (added in ticket #13, so that `freeze_scenario` can replay
an `act.input` captured in the session trace) mirrors `dispatch.gd
_act_input`: `type: "action"|"key"` work everywhere (headless included);
`type: "click"` (positional) fails cleanly with `_aborted` if
`DisplayServer.get_name() == "headless"` — a frozen test that needs it must
carry `const PLAYTEST_WINDOWED := true` (see Freeze section below) so
the runner skips it in CI instead of letting it fail.

### Implementation decisions

- **`PlaytestCase` extends `Node`** (not `RefCounted`): `wait_for()` needs
  `get_tree().process_frame` to re-evaluate its condition every frame without
  ever blocking (§1.3) — this requires being in the tree.
- **`start_game()` mounts the scene under `get_tree().root`** (ADR-0006), not
  under the `PlaytestCase` — the same place the network projection's
  `dispatch.gd` resolves selectors from (`Dispatch.new(get_tree().root)` in
  `bridge.gd`), so a frozen replay sees the tree shape a live scenario would,
  including absolute `/root/...` paths used by the game's own scripts. A
  direct `add_child()` on the root fails during the runner's own `_ready()`
  ("Parent node is busy setting up children"); the deferred form
  (`add_child.call_deferred`) is required and yields `/root/<SceneRootName>`.
  **Frame-timing contract**: `start_game()` returns after exactly one idle
  frame — `_ready()` has run for the whole mounted subtree, but no
  `_process()` call has happened yet on any of its nodes. A one-shot
  assertion taken right after `start_game()` therefore observes state as of
  `_ready()`, not one `_process()` tick later; a value that only becomes
  correct within that first `_process()` call needs the retry-until-timeout
  form (`assert_eventually_property`/`wait_for`), not a one-shot comparison.
  The addon owns teardown of what it mounted: freeing the `PlaytestCase` (the
  runner's existing "remove, then free" sequence) detaches and frees the game
  too, so a second `start_game()` in the same file remounts at the same clean
  path instead of colliding on the scene's node name.
- **`query_one`/`press`/`invoke`/`wait_for` fail immediately**, never
  via a silent timeout: selector resolution (via `resolve_strict`) is
  synchronous and one-shot, not a waiting loop. Only `wait_for` has a
  loop with a deadline — and an `ambiguous`/`bad_request` selector fails there
  on the first evaluation (same rule as `dispatch.gd _poll_wait_for`);
  `not_found` keeps waiting (the node may appear later),
  until it expires as a "timeout" failure.
- **Failure = report entry, not an exception** (GDScript has no
  try/catch): each failure (`_record_failure`) embeds a full `query`
  dump of the current tree (§7: "a failure carries a query dump in the
  report"), and is also emitted via `push_error` to show up in the
  runner's raw logs.
- **`_aborted`: targeted early stop.** A selector resolution failure
  (`query_one`/`press`/`invoke`/`wait_for`) flips `_aborted = true`: subsequent
  calls to these primitives become no-ops, to avoid stacking cascading
  failures on a test that's already compromised (e.g. a broken selector
  before several assertions that all depend on it). `assert_now_*` **never**
  flips it and **never** consults it either — it always runs (constant cost,
  cannot hang: several independent failures are worth more than one).
  `assert_eventually_*` never flips it, but **does** consult it: its retry
  loop is skipped entirely once it is set (nothing to await from a getter
  referencing an already-broken selector, otherwise `timeout_ms` would be
  burned per assertion for nothing) — a stated rule (ADR-0006 "surviving
  asymmetry, now legitimate because it is named"), not an accident. Known
  limitation (accepted for this v0): if a test directly dereferences the
  `null` value returned by a failed `query_one` (instead of checking the
  return value), GDScript logs a secondary dereference error — the report
  already contains the rich diagnostic from the first failure, so the useful
  signal isn't lost, just noisier.
- **`assert_now_*`/`assert_eventually_*` (§7, ticket #11 remediation, split
  by ticket #35/ADR-0006).** Two families, named by the call site rather
  than inferred from the argument's type, each rejecting the other's
  argument kind as a reported test failure naming the correct alternative
  (never a silent no-op): `assert_now_*` takes an already-evaluated value
  (e.g. `label.text`), compared once, immediately — for checks that follow
  directly after `start_game()`, where there's nothing left to settle.
  `assert_eventually_*` takes a no-argument `Callable`, called again every
  frame until success or `timeout_ms` (default 2000ms) — the canonical form
  for a value that settles over time. `assert_eventually_property(selector,
  property, expected)` is the sugar recommended by the review for the
  selector+property case — it reuses `resolve_strict` and keeps its rich
  diagnostics (`not_found` + suggestions, `ambiguous` + candidates) rather
  than a silent `null` in case of a broken selector; `assert_now_property` is
  its one-shot sibling, with no `timeout_ms`. **Consequence of GDScript**: a
  function that contains `await` (even in a single branch) is a coroutine —
  the compiler requires `await` at *all* of its call sites, including the
  one-shot form which never actually suspends. Hence `await
  assert_now_eq(...)` everywhere, even on an immediate value like
  `label.text` right after `start_game()`.
- **`time_step_until` (§4, ticket #38 — the in-process mirror of ticket
  #37's `time.step_until`).** Same condition vocabulary as `wait_for` minus
  `signal` (a `signal` key is a reported failure, not silently ignored),
  budgeted primarily by `opts.max_frames` (default
  `PlaytestDispatch.DEFAULT_STEP_UNTIL_MAX_FRAMES`, 300) rather than
  `timeout_ms` — the deterministic axis ADR-0007 mandates: re-evaluated once
  per idle frame (`await get_tree().process_frame`), so
  `Engine.get_process_frames()` deltas track real frames 1:1, same as
  `dispatch.gd`'s "frame counting, not a per-poll tick" note above. Returns
  `{"node": Node, "frames": int}` on success or `{"node": null, "frames":
  int}` once the budget is exhausted — `frames` mirrors the network
  response's field, letting a test assert the resolution is
  frame-deterministic on either projection. Like `wait_for`, it contains an
  `await` in its loop, so it is a coroutine: every call site MUST `await`
  it, even when the condition already holds (`frames == 0`) — same compiler
  rule as `assert_now_*`/`assert_eventually_*` above: a missing `await`
  whose result is used is a load-time parse error, not a silent wrong
  result.
- **Runner (`runner.gd`)**: `--suite` (default `res://playtests/`) names
  either a directory — any `.gd` file under it, recursively, is considered a
  frozen test script (no inheritance-based filtering — a folder convention,
  like `res://playtests/` itself) — or a single `.gd` file, which is then the
  whole suite. Per-file invocation gives **one Godot process per scenario**,
  the only reset that clears autoload state wholesale, and is also how a
  suite is sharded across CI jobs. Any zero-argument method named `test_*`
  is run, sorted by name for a deterministic order. Each test runs in a
  disposable instance of its script, added to and removed from the runner's
  tree.
- **Exit code — never a green suite that ran nothing** (ticket #40).
  Non-zero if a test failed, **or** if a discovered script cannot be
  instantiated (a parse error is a named failure, not an invisible skip),
  **or** if `--suite` names a path that does not resolve — an absent
  directory, an absent file, or a file that isn't `.gd`. Zero if every test
  passed, including when an existing suite directory holds no `.gd` file at
  all: "nothing to run" is a legitimate state, "I could not resolve what you
  named" is not. That rule applies to the **default** `res://playtests/` as
  well as to an explicit `--suite`, so a project that installs the addon
  before writing its first test gets a red exit until the directory exists —
  deliberate, the dangerous direction being the silent green.
- **Test suite**:
  [`tests/runner/test_runner.py`](../../tests/runner/test_runner.py) checks
  the golden path (`res://playtests/` passes, exit 0), the "broken
  selector" scenario
  ([`tests/runner/fixtures/broken_selector/`](../../tests/runner/fixtures/broken_selector))
  which must fail with `not_found` + `suggestions` in the output — never
  a silent timeout — one scenario per branch of the exit-code contract above
  (single-file suite, unparseable script, absent path, absent default,
  non-`.gd` path, empty directory), and, added for ADR-0006, "root path"
  ([`tests/runner/fixtures/root_path/`](../../tests/runner/fixtures/root_path),
  a fixture whose own script resolves a node through an absolute
  `/root/...` path) and "two mounts"
  ([`tests/runner/fixtures/two_mounts/`](../../tests/runner/fixtures/two_mounts),
  two `test_*` methods in the same file each mounting at the same clean
  `/root/Main` path, no leftover from the first) and "self-freeing game"
  ([`tests/runner/fixtures/self_freeing_game/`](../../tests/runner/fixtures/self_freeing_game),
  a game that frees or detaches itself mid-test, whose teardown must stay
  quiet and leak-free). Wired into CI
  ([`.github/workflows/playtestcase-runner.yml`](../../.github/workflows/playtestcase-runner.yml)),
  which also replays the reference frozen test ×20 in headless mode (golden path CI).

### Known engine noise in `--headless` — the contract remains the exit code

A `--headless` boot of a third-party project can produce engine `ERROR`/
`WARNING` lines unrelated to the frozen tests' result — observed in
dogfooding on tps-demo (`dogfooding/FRICTIONS.md` #4): `ERROR: Parameter
"t" is null.` (dummy texture in headless rendering), a `WARNING` "Interpolated
Camera3D triggered from outside physics process" (documented as "possibly
benign" by the engine itself), and `ERROR: BUG: Unreferenced static
string` at the moment of the process's forced `kill()`. None of these cases
affected the test results (20/20 green in dogfooding): it's known third-party
noise in headless mode, not a failure signal.

**The runner's contract is only its exit code** (`0`/`1`, see
above): never grep `ERROR`/`WARNING` in the raw logs of a headless run
to decide a frozen test's verdict. A run can display this
noise and still be green; conversely, a run that fails for a completely different
reason doesn't need this noise to be detected — the exit code is enough.

## Freeze: frozen tests generated by `freeze_scenario` (ticket #13)

The MCP server (`mcp-server/src/freeze.ts`) generates frozen tests from
an agent's session trace — see [mcp-server/README.md § Freeze](../../mcp-server/README.md#freeze-ticket-13)
for the server-side detail. On the addon side, two additions in service of
this mechanism:

- **`input(params)`** on `PlaytestCase` (see mapping table above):
  the only primitive that was missing to replay in-process an `act.input`
  captured in the trace.
- **`runner.gd` skips `PLAYTEST_WINDOWED` scripts in `--headless`**: a
  frozen scenario that had to use `act.input` type `click` or `screenshot`
  (not CI-safe, matrix §6) carries `const PLAYTEST_WINDOWED := true` — the
  runner reads this constant via `script.get_script_constant_map()` and
  displays `SKIP (windowed-only, no display in --headless)` instead of
  letting the test fail on `no_display`. Such a test remains runnable as-is
  by launching the runner in **windowed** mode (without `--headless`).

## Multi-client frozen tests (spec #66)

Instance 0 stays `self`, in-process, exactly as everywhere above. Each
further instance is a **handle** returned once by `attach_instance("name")`
— a client of an already-running process the game's own harness launched
(the addon only attaches, never launches: ADR-0005, ADR-0008). Docs/adr/0008
carries the topology rationale; [docs/INSTRUMENTATION.md §8](../../docs/INSTRUMENTATION.md)
documents the harness contract (`PLAYTEST_ATTACH_PORTS`) game-agnostically.

```gdscript
extends PlaytestCase

func test_b_sees_what_a_did() -> void:
    await start_game("res://main.tscn")          # instance 0 = self, unchanged
    var b := await attach_instance("b")           # named handle, declared once

    press({"test_id": "ready_button"})
    await b.press({"test_id": "remote_button"})
    await b.assert_eventually_property({"test_id": "score"}, "text", "1")
```

- **Instance names**: `^[a-z][a-z0-9_]*$`, GDScript keywords and `self`
  rejected, `default` reserved — `attach_instance("default")` is rejected
  (instance 0 is always `self`, never a variable). Validated at the naming
  site (`instance_name.gd`) so Freeze can never emit a file that fails to
  parse.
- **`PlaytestClient`** (`playtest_client.gd`) exposes `press`/`input`/
  `invoke`/`query`/`query_one`/`wait_for`/`time_scale`/`time_frames`/
  `time_step_until`/`assert_now_property`/`assert_eventually_property` over
  a hand-rolled TCP JSON-lines client. Every one of these is a network
  round trip and therefore a GDScript coroutine — unlike `self`, a handle's
  `press`/`input`/`invoke` also need `await` at the call site (naming
  corollary, ADR-0008: same verb name, different strength of guarantee
  behind it). `query_one` returns the node's serialized description (§5),
  not a live `Node` reference — there is no in-process node to hand back
  for a remote instance (same for the `node` field of `time_step_until`'s
  `{"node", "frames"}` return value).
- **Failure semantics**: a broken selector or a lost connection on a handle
  stops only that handle's further calls in the same test (`PlaytestClient
  ._aborted`, scoped per handle) — `self` and every other instance keep
  going, and everything lands in the same aggregated report
  (`case.failures`), each handle failure prefixed with its instance name
  (`_record_handle_failure`). A dead/unreachable instance is always a named
  failure, never a silent skip; once an instance has failed, later
  `attach_instance` calls for that same name fail fast for the rest of the
  runner invocation instead of repeating the same doomed retry (`PlaytestClient`'s
  static bookkeeping — per-suite lifetime, §61).
- **Time**: `time_scale`/`time_frames`/`time_step_until` on a handle act on
  that instance's own process only. There is no synchronized cross-instance
  step, ever —
  the determinism ceiling this tool accepts; see the two named gotchas in
  docs/INSTRUMENTATION.md §8 (instance 0's `time_scale` also scales this
  runner, and an attached instance's state persists across `test_*` methods
  within the same suite invocation).
