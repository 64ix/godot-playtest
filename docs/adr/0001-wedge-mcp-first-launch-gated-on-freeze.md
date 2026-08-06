# Wedge v0: MCP first, public launch gated on `freeze`

Three launch wedges were possible: lead with the MCP server ("your agent plays your game", hot demand — godot-mcp 4.6k ★), lead with the CI GitHub Action ("your Godot CI that finally works", gaping but cold pain, and our least-proven technical risk), or launch everything at once. Decision: **build and tell the story MCP first; the CI GitHub Action comes in phase 2**.

But the **public launch** (post Show HN / r/godot, flipping the repo to public with noise) does not happen the moment the first MCP server works: it waits until **`freeze` is demonstrable** — the full demo shows the agent playing *and* the frozen test replaying without AI. Reason: an MCP-only launch tells the same story as existing general-purpose MCP servers; the locked-in positioning (market study 2026-07-12) makes durable tests the differentiating artifact, and we only launch once. Accepted cost: a few weeks of launch time forgone.

## Considered Options

- **MCP-only at launch, freeze as fast-follow** — earlier momentum, but an undifferentiated launch message against godot-mcp, and no second press cycle.
- **CI first** — zero competition, but cold demand and a launch resting on the most uncertain spike (headless rendering, #5).
- **Big-bang MCP + freeze + CI Action** — complete message but slow launch and diluted promise.
