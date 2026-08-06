# Protocol v0: JSON-lines over loopback TCP, semantic verbs, opt-in state contract

The protocol (draft: `docs/protocol/DRAFT-v0.md`) settles three structural choices.

**JSON-lines transport over loopback TCP**, against WebSocket and against a
binary protocol: debuggable without tooling, zero dependency on the GDScript addon side, and
sufficient — spikes #4/#5 measure a median RTT of ~8 ms, quantized to the frame by the pump
in `_process`, well below QA needs. PlayGodot paid dearly for a mid-course
protocol migration; we freeze JSON-lines from v0 and only evolve additively.
Non-negotiable corollaries: a correlation `id` on every request (async
`wait_for` calls answer out of order) and the Bridge is never blocking.

**Semantic by default, positional as a fallback**: actions target three-tier selectors
(test-id > group > NodePath, strict mode on actions), and
activating a Control goes through `act.press` (signal route), not an x/y click.
Rationale: mouse hit-testing is dead in `--headless` (spike #5) — a protocol whose
central verb was the positional click would break the CI promise; and absolute
scene paths are the #1 documented fragility point in AltTester and godot-e2e
(#3). Positional click remains available via the `windowed` capability.

**Opt-in, versioned `_test_state()` state contract** rather than an imposed
role taxonomy: Godot has no ARIA, each game has its own semantics. The Bridge provides the
generic part (identity, geometry, visibility); the game exposes its domain by defining
`_test_state() -> Dictionary` on the nodes that want it. No prior-art tool has
a stable state convention — this is the differentiator that makes frozen tests
durable, and it is versioned (`state_contract`) to survive future changes.

Deferred to implementation: the frozen test runner (dedicated scene vs gdUnit4) and the
full canonical Variant→JSON mapping (appendix to be frozen before v1).
