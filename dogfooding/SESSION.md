# Dogfooding session: godot-playtest × TPS demo (issue #14)

Draft of the launch demo (ADR-0001/ADR-0003): an agent programmatically
drives, via the MCP server plugged into the Bridge, the instrumented TPS
demo (local clone `.dogfood/tps-demo`, see `setup-tps-demo.sh` /
`INSTRUMENTATION.md`) — headless, with no manual intervention — up to a
completed game objective, then freezes the trace into a replayable test.

**Reproduce**: `GODOT_BIN=<godot 4.6.3> TPS_DEMO_PATH=.dogfood/tps-demo
node <script driven by Session, same primitives as the MCP tools>` (the
script used for this session calls `mcp-server/dist/session.js` directly —
a real agent session through the MCP tools would follow the exact same
verb sequence, one per tool call). Session generated on 2026-07-12.

## Game objective

1. Launch the game headless (`launch_game`) — the TPS demo auto-hosts in
   `--headless` (`menu.gd`), the level loads in the background.
2. Wait for the player to appear in the level (`wait_for`).
3. **Move the player** more than 2 meters from its spawn point (`act.input`
   action type `move_forward` + `time.frames`), and verify it with a domain
   assertion (`has_moved`).
4. **Neutralize an enemy robot** (`enemy_Marker3D1`, 5 HP) via `act.invoke`
   on its `hit()` method, and verify by domain assertion that it is dead
   (`health == 0`, `dead == true`).
5. Freeze the trace (`freeze_scenario`) into an AI-free replayable test.

## Why `act.invoke` rather than the player's real shot?

The player's shot (`player.gd apply_input`) depends on a raycast from the
camera through the center of the screen (`crosshair.position`), and
therefore on the camera's exact orientation relative to the enemy —
reproducible in theory, but fragile to harden into a deterministic frozen
test without a dedicated calibration budget (see `FRICTIONS.md`, "3D /
aiming selectors"). `hit()` is a normal method of `red_robot.gd` (annotated
`@rpc` but directly callable): invoking it via `act.invoke` tests the
**domain** (a robot hit 5 times dies) without depending on aiming physics —
the assumed escape hatch documented in §4 of the protocol ("reflection").

## Full transcript (verbs + observations)

### launch_game
```json
{
  "command": "/Applications/Godot_mono.app/Contents/MacOS/Godot",
  "args": ["--path", ".dogfood/tps-demo", "--headless"]
}
```

### → connected
```json
{ "port": 63858, "pid": 33743 }
```

### hello
```json
{
  "capabilities": [],
  "engine": "4.6.3-stable (official)",
  "id": 1,
  "ok": true,
  "protocol": 0,
  "state_contract": 0
}
```
No `windowed` capability: confirms we are running with no display.

### wait_for player_1 (level loading)
```json
{
  "id": 2,
  "ok": true,
  "node": {
    "class": "CharacterBody3D",
    "path": "/root/main/Level/SpawnedNodes/1",
    "position": [64.818, -1.085, 74.764],
    "state": {
      "airborne_time": 100.05,
      "distance_from_spawn": 0.008,
      "has_moved": false,
      "position": { "$gd": "Vector3", "v": [64.818, -1.085, 74.764] }
    },
    "test_id": "player_1"
  }
}
```
Threaded loading (`ResourceLoader.load_threaded_request` + a timer on the
`menu.gd` side): `wait_for` waited without ever sleeping on the agent side.
Spawn position differs on every run (`player_spawn_points.shuffle()`, see
`FRICTIONS.md`) — hence `has_moved`, not an absolute position, as the
criterion.

### query enemy_Marker3D1 (initial state)
```json
{
  "id": 4, "ok": true,
  "nodes": [{
    "class": "CharacterBody3D",
    "path": "/root/main/Level/SpawnedNodes/RedRobot",
    "state": { "dead": false, "health": 5, "state": "IDLE" },
    "test_id": "enemy_Marker3D1"
  }]
}
```

### assert_property enemy_Marker3D1.health == 5 → ok

### act.input move_forward pressed=true → ok
### time.frames n=120 physics=true (~2s at 60Hz) → ok
### act.input move_forward pressed=false → ok

### assert_property player_1.has_moved == true → ok
The player exceeded the 2m threshold (`MOVED_THRESHOLD_METERS`) over 120
physics frames of `move_forward`.

### act.invoke enemy_Marker3D1.hit() ×5 → ok (the 5th call enters the
`health == 0` branch of `hit()`, which contains an `await` — the serialized
return value is a `GDScriptFunctionState`, cf. `FRICTIONS.md`)

### assert_property enemy_Marker3D1.health == 0 → ok
### assert_property enemy_Marker3D1.dead == true → ok

### query enemy_Marker3D1 (final state)
```json
{
  "id": 17, "ok": true,
  "nodes": [{
    "state": { "dead": true, "health": 0, "state": "IDLE" },
    "test_id": "enemy_Marker3D1"
  }]
}
```

### verifySelectorsLive → `[]` (no broken selector)

### freeze_scenario
```json
{ "fileName": "tps_demo_player_moves_and_neutralizes_a_robot.gd", "ciSafe": true }
```

## Result

Frozen test written to
[`dogfooding/playtests/tps_demo_player_moves_and_neutralizes_a_robot.gd`](playtests/tps_demo_player_moves_and_neutralizes_a_robot.gd),
`ci_safe = true` (no `act.input` of type `click`/`screenshot` in the
trace), replayed **20/20 headless** on the instrumented clone (see
[`playtests/README.md`](playtests/README.md) for the replay command).

## For the real launch demo

This session is the technical draft, not the final script: the public demo
(ADR-0001) will benefit from being **windowed** (showing the game running
on screen rather than a stream of JSON) and from chaining a longer scenario
(several robots, a real shot rather than an `act.invoke`). The real GitHub
fork (`64ix/tps-demo`) and the video recording remain manual QA steps to be
done at launch time, not here.
