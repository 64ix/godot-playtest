# `time.step_until`: a new verb, not a `wait_for` budget option

Ticket #37 needed a deterministic "advance the game until a condition holds,
bounded by a budget" primitive (spec #34). Two shapes were on the table: add
a `step`/`freeze` option + budget to the existing `wait_for` verb, or add a
new verb in the `time.*` family. Decision: **`time.step_until` is a new
verb**, sitting alongside `time.scale`/`time.frames`, additive to the
protocol (ADR-0004) — `wait_for` is untouched.

The deciding factor is that `wait_for` and this primitive resolve on two
fundamentally different clocks, and cramming both into one field produces
exactly the ambiguity ADR-0006 already diagnosed for `assert_*` (an
argument's shape silently switching semantics: a `Callable` retried, a value
compared once, both spelled identically). `wait_for`'s `timeout_ms` **is**
the deadline — the sole axis on which it resolves as `timeout`, wall-clock,
non-reproducible in exact duration across runs by construction (that's fine,
it isn't the point of `wait_for`). `time.step_until`'s deterministic axis is
`max_frames`; `timeout_ms` there is demoted to an optional **safety net
only**, never the intended way to bound a run. If both lived on `wait_for`,
the same field name (`timeout_ms`) would mean "the deadline" in one call and
"an escape hatch that should basically never fire" in another, distinguished
only by whether a `step`/`freeze` flag was also present — the call site would
no longer name which contract it means, it would have to be inferred from a
second parameter. Two verbs keep each contract single-purpose and honest.

`time.step_until` reuses `wait_for`'s condition vocabulary **minus
`signal`**: plain presence, `property`+`equals`, and the parameterized
`method`+`args`+`equals` domain query (identical semantics, same pure-read
contract). `signal` is deliberately out of scope — a one-shot event doesn't
compose naturally with a budget expressed in discrete frame steps rather
than in "did it fire between two evaluations"; `wait_for` remains the way to
wait on a signal, wall-clock-bounded as it already is. The response carries
`frames`: the number of engine frames (`Engine.get_process_frames()`)
elapsed between registration and resolution, whether success or `timeout`
(reusing the existing `timeout` error code, addons/playtest/errors.gd — not
a new one) — this is the field a caller checks to confirm the resolution is
frame-deterministic, never wall-clock-dependent, and it is what the added
tests assert stays identical across repeated runs of the same scenario
(extra guardrail #5, tests/conformance/scenario.py
`check_step_until_determinism`, mcp-server's fixture integration test).

Like `time.scale`/`time.frames`, `time.step_until` only advances the
**local** engine clock. In a network or server-authoritative game, the
domain time that matters lives elsewhere — the same caveat, the same
answer: the game exposes its own domain accelerator (docs/INSTRUMENTATION.md
§ "Domain time"), out of scope for this primitive.

`time.step_until` is **not** gated behind a `hello` capability. In this
protocol, capabilities announce environment-dependent availability
(`windowed` only outside `--headless`) — they are not a generic feature-flag
mechanism. `time.step_until` is headless-safe and unconditionally available,
exactly like `wait_for`/`time.scale`/`time.frames`; gating it behind a
capability would misuse the mechanism and force every client to check for it
before calling a verb that always works.

**Scope note (ADR-0006 obligation, recorded here and in
docs/protocol/DRAFT-v0.md §4):** this ticket landed the **network
projection** only (`dispatch.gd`). ADR-0006 requires that a semantic added
to one projection be added to both, under the same name. The in-process
mirror on `PlaytestCase` was ticket #38's job (blocked on #35, the
`assert_now_*`/`assert_eventually_*` rename). Trace/`freeze_scenario`
support — so an agent-driven `time.step_until` call is captured and
replayed by a generated frozen test — was ticket #39's job, now landed:
`time.step_until` is in `mcp-server/src/trace.ts`'s `REPLAYABLE_VERBS`, so
`session.call()` records it exactly like `wait_for`/`time.scale`/
`time.frames`, and the Freeze generator (`mcp-server/src/freeze.ts`) emits
it as a bare `await time_step_until(...)` statement (its `{"node",
"frames"}` return value, ticket #38, is discarded the same way `wait_for`'s
resolved node is). The interim stderr warning that stood in for this
between #37 and #39 (guarding against an agent calling `time.step_until`
then `freeze_scenario` and getting a frozen test that quietly omitted the
advance) has been removed along with it, having become a lie once the verb
became replayable.

## Considered Options

- **Extend `wait_for` with a `step`/`freeze` option + budget** — rejected:
  the verb-count principle favors this on paper, but it overloads
  `timeout_ms` with two mutually exclusive meanings selected by a second,
  easily-missed flag — precisely the failure mode ADR-0006 renamed
  `assert_*` to eliminate. It would also require special-casing `wait_for`'s
  already-tested resolution loop (wall-clock `deadline_ms`) for a
  fundamentally different one (a frame counter), risking a regression on a
  verb every existing scenario and frozen test already depends on.
- **Gate `time.step_until` behind a `hello` capability** (treating it like
  the "opt-in, considered for v0" capabilities `seed`/`logs`/`scene`/
  `record`) — rejected: capabilities in this protocol represent
  environment-dependent availability, not generic feature flags; unlike
  `windowed`, this primitive works unconditionally (headless included), so
  gating it would add client-side ceremony (a capability check before a verb
  that always succeeds) for zero actual variability.
- **New verb `time.step_until` in the `time.*` family (chosen)** — keeps
  `wait_for`'s contract untouched and gives the deterministic
  frame/wall-clock distinction its own single-purpose verb, at the cost of
  one more row in the verb table (additive, ADR-0004).
