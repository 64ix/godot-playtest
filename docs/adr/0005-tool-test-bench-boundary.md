# Tool / game boundary: general behavior belongs in the tool

Dogfooding frictions may become tool features only when they can be expressed
without game-specific vocabulary or orchestration.

A friction has three possible destinations, in order:

1. **Tool feature** — a general verb, option, lookup, or diagnostic with no
   game semantics. Examples include PascalCase `_TestState` lookup, the `env`
   option of `launch_game`, and the `method` mode of `wait_for`.
2. **Documented convention** — a pattern by which a game exposes domain state
   without the tool guessing it, such as threshold booleans, aim telemetry, or
   domain-time controls.
3. **Game repository** — backend provisioning, process orchestration,
   game-specific debug seams, fixtures, and domain rules.

This boundary prevents the protocol from absorbing one game's architecture.
If an issue cannot describe the need without naming game concepts, it is not
ready to become a tool feature.

## Considered options

- **Case-by-case judgment** — rejected because small game-specific options
  accumulate without a visible boundary.
- **Reject all dogfooding-derived features** — rejected because real projects
  expose useful general requirements.
- **General writeup criterion (chosen)** — cheap to apply and reviewable from
  the issue or specification itself.
