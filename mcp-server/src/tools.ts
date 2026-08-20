/**
 * MCP tools, 1:1 with the interaction verbs of the godot-playtest protocol
 * (docs/protocol/DRAFT-v0.md §4: the original 9, plus `time.step_until`
 * added additively by ticket #37) + `launch_game`/`attach` (ticket #12) and
 * `quit_game` (ticket #20, clean shutdown — protocol verb `quit`).
 *
 * Thin proxy (spec #7): each tool only translates its arguments into a
 * JSON-lines request and returns the Bridge's response as-is — no game
 * semantics here, that all lives in the Bridge (addon).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { compatibilityVerdict } from "./protocol.js";
import { Session } from "./session.js";
import { FreezeRefusedError, generateFrozenScript, verifySelectorsLive } from "./freeze.js";

/** Selector shared by `query`, `act.press`, `act.invoke`, `wait_for` (§3):
 * priority test-id > group > NodePath, all optional on the MCP schema side —
 * it's the Bridge that decides whether the absence of a selector is valid
 * (`query` alone) or a `bad_request` error (actions, `wait_for`). */
const selectorShape = {
  test_id: z.string().optional().describe("test-id selector (§3, level 1, the most stable)."),
  group: z.string().optional().describe("Group selector (§3, level 2, can match N nodes)."),
  path: z.string().optional().describe("NodePath selector (§3, level 3, fragile, exploration)."),
};

/** Client-side timeout shared by all "verb" tools (dogfooding/FRICTIONS.md
 * #7): in windowed mode, shader compilation (3D menu, first render of the
 * level) freezes the game's main thread beyond `BridgeClient`'s default 10s —
 * without this escape hatch, verbs time out as `BridgeTimeoutError` with no
 * recourse. Purely client-side: extracted from params before sending, never
 * forwarded to the Bridge, never recorded in the trace (so never frozen by
 * freeze_scenario). */
const clientTimeoutShape = {
  client_timeout_ms: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Client-side timeout (ms) waiting for the Bridge's response for THIS verb (default 10000, " +
        "wait_for/time.step_until: timeout_ms + 2000, if 'timeout_ms' is set). Increase it in " +
        "windowed mode if the game freezes (shader compilation on first render), or for a large " +
        "time.step_until 'max_frames' budget. Never forwarded to the Bridge.",
    ),
};

/** Named-instance dimension (spec #66): shared by every per-instance tool.
 * Defaults to `"default"` (instance 0) end-to-end, so every tool call that
 * predates this spec keeps its exact behavior. Address a further client by
 * the name minted with `launch_game`/`attach`'s own `instance` field. Never
 * forwarded to the Bridge (the wire protocol does not change) — purely a
 * session-side routing key. */
const instanceShape = {
  instance: z
    .string()
    .optional()
    .describe(
      "Named client this call addresses (default \"default\", instance 0). Address a further " +
        "client by the name minted with launch_game/attach's own 'instance' field.",
    ),
};

function textResult(resp: Record<string, unknown>): CallToolResult {
  const ok = resp["ok"] === true;
  return {
    isError: !ok,
    content: [{ type: "text", text: JSON.stringify(resp, null, 2) }],
  };
}

function errorResult(err: unknown): CallToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: "text", text: message }] };
}

/** Registers the tools 1:1 with the protocol's interaction verbs, plus
 * `launch_game`/`attach`/`quit_game`. `session` is injected so unit tests
 * can plug in a fake Bridge (see test/unit). */
export function registerTools(server: McpServer, session: Session): void {
  server.registerTool(
    "hello",
    {
      title: "hello",
      description:
        "Protocol handshake (§2): protocol version, state contract, advertised capabilities " +
        "(e.g. 'windowed' only outside headless). Call after launch_game/attach — the result carries " +
        "a `compatibility` verdict comparing the addon's versions to this server's, naming which " +
        "side to update on a drift.",
      inputSchema: { ...clientTimeoutShape, ...instanceShape },
    },
    async (params) => {
      try {
        const resp = await session.call("hello", {}, params.client_timeout_ms, params.instance);
        if (resp["ok"] === true) {
          return textResult({ ...resp, compatibility: compatibilityVerdict(resp) });
        }
        return textResult(resp);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "query",
    {
      title: "query",
      description:
        "Reads the live game's state (§4): without a selector, returns every node carrying a test_id " +
        "(accessibility snapshot); with a selector, returns the matched node(s). " +
        "Possible errors: not_found (with suggestions, empty when no known test_id is " +
        "close enough to be worth proposing), ambiguous (with candidates) for test_id/path.",
      inputSchema: { ...selectorShape, ...clientTimeoutShape, ...instanceShape },
    },
    async (params) => {
      try {
        const { client_timeout_ms, instance, ...verbParams } = params;
        const resp = await session.call("query", verbParams, client_timeout_ms, instance);
        return textResult(resp);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "act_press",
    {
      title: "act.press",
      description:
        "Semantic activation of a Control by selector (§4): emits its 'pressed' signal " +
        "(Button, CheckBox...) — never hit-testing, works in headless. " +
        "bad_request if the node isn't a Control or doesn't have this signal; " +
        "not_found/ambiguous depending on selector resolution (strict mode, §3).",
      inputSchema: { ...selectorShape, ...clientTimeoutShape, ...instanceShape },
    },
    async (params) => {
      try {
        const { client_timeout_ms, instance, ...verbParams } = params;
        const resp = await session.call("act.press", verbParams, client_timeout_ms, instance);
        return textResult(resp);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "act_input",
    {
      title: "act.input",
      description:
        "Low-level input injection (§4). type='action'|'key' work everywhere (headless included). " +
        "type='click' (positional) requires the 'windowed' capability (advertised by hello): " +
        "fails in headless with error='no_display'.",
      inputSchema: {
        type: z.enum(["action", "key", "click"]).describe("Nature of the input to inject."),
        action: z.string().optional().describe("InputMap action name (type='action')."),
        keycode: z.number().int().optional().describe("Godot key code (type='key')."),
        // Not `z.tuple()` (issue #23): it serialises to draft-07 tuple
        // validation (`items` as an array of schemas), which vLLM-backed
        // OpenAI-compatible gateways reject with a bare 400 — killing every
        // other tool in the same payload. A length-bounded array of numbers
        // is equivalent for an [x, y] pair and serialises to a single
        // `items` schema. See test/unit/tool-schema-compat.test.ts.
        position: z
          .array(z.number())
          .min(2)
          .max(2)
          .optional()
          .describe("Screen position [x, y] (type='click', 'windowed' capability only)."),
        button: z.number().int().optional().describe("MouseButton (type='click'), default left button."),
        pressed: z.boolean().optional().describe("true=press, false=release. Default true."),
        strength: z.number().optional().describe("Action strength (type='action'), default 1.0."),
        ...clientTimeoutShape,
        ...instanceShape,
      },
    },
    async (params) => {
      try {
        const { client_timeout_ms, instance, ...verbParams } = params;
        const resp = await session.call("act.input", verbParams, client_timeout_ms, instance);
        return textResult(resp);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "act_invoke",
    {
      title: "act.invoke",
      description:
        "Reflection: calls `method` with `args` on the node resolved by the selector, returns the " +
        "serialized value (Variant→JSON mapping, docs/protocol/ANNEX-variant-json.md). " +
        "The deliberate escape hatch for when no other verb covers the need. " +
        "not_found if the method doesn't exist on the resolved node.",
      inputSchema: {
        ...selectorShape,
        method: z.string().describe("Name of the GDScript method to call on the resolved node."),
        args: z.array(z.unknown()).default([]).describe("Positional arguments of the method."),
        ...clientTimeoutShape,
        ...instanceShape,
      },
    },
    async (params) => {
      try {
        const { client_timeout_ms, instance, ...verbParams } = params;
        const resp = await session.call("act.invoke", verbParams, client_timeout_ms, instance);
        return textResult(resp);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "wait_for",
    {
      title: "wait_for",
      description:
        "Waits for a node to appear, a property to equal a value, a signal to be emitted, or " +
        "a method (pure read, re-called every frame with 'args') to return 'equals' (§4) — " +
        "THE anti-flake building block, never a sleep on the agent side. Asynchronous on the Bridge " +
        "side: the response can arrive after other calls sent afterwards. Returns error='timeout' if " +
        "the deadline (timeout_ms) expires without the condition becoming true.",
      inputSchema: {
        ...selectorShape,
        property: z.string().optional().describe("Name of the property to watch (with 'equals')."),
        equals: z
          .unknown()
          .optional()
          .describe("Expected value of 'property' or 'method' (Variant→JSON mapping)."),
        signal: z.string().optional().describe("Name of the signal to wait for (a single emission)."),
        method: z
          .string()
          .optional()
          .describe(
            "Parameterized domain query: method (pure read) re-called every frame with " +
              "'args' until its return value equals 'equals'.",
          ),
        args: z.array(z.unknown()).optional().describe("Positional arguments of 'method'."),
        timeout_ms: z.number().int().positive().optional().describe("Delay before 'timeout'. Default 5000ms."),
        ...clientTimeoutShape,
        ...instanceShape,
      },
    },
    async (params) => {
      try {
        const { client_timeout_ms, instance, ...verbParams } = params;
        const resp = await session.call("wait_for", verbParams, client_timeout_ms, instance);
        return textResult(resp);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "time_scale",
    {
      title: "time.scale",
      description: "Fast-forward: sets Engine.time_scale (§4). factor=1.0 restores normal speed.",
      inputSchema: {
        factor: z.number().describe("Engine time speed multiplier."),
        ...clientTimeoutShape,
        ...instanceShape,
      },
    },
    async (params) => {
      try {
        const { client_timeout_ms, instance, ...verbParams } = params;
        const resp = await session.call("time.scale", verbParams, client_timeout_ms, instance);
        return textResult(resp);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "time_frames",
    {
      title: "time.frames",
      description:
        "Fine-grained synchronization: responds after `n` frames (idle or physics) have actually " +
        "elapsed (§4). Always resolved deterministically, no deadline.",
      inputSchema: {
        n: z.number().int().nonnegative().describe("Number of frames to wait for."),
        physics: z.boolean().optional().describe("true=physics frames, false=idle frames (default false)."),
        ...clientTimeoutShape,
        ...instanceShape,
      },
    },
    async (params) => {
      try {
        const { client_timeout_ms, instance, ...verbParams } = params;
        const resp = await session.call("time.frames", verbParams, client_timeout_ms, instance);
        return textResult(resp);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "time_step_until",
    {
      title: "time.step_until",
      description:
        "Deterministically advances the game frame-by-frame until a condition holds, or a frame " +
        "budget is exhausted (§4, ticket #37, docs/adr/0007-time-step-until-as-a-new-verb.md). " +
        "Reuses wait_for's condition vocabulary minus 'signal' (a one-shot event doesn't fit a frame " +
        "budget): no property/method = node presence, 'property'+'equals', or the parameterized " +
        "'method'/'args'/'equals' domain query. Frame-stepped, not wall-clock: resolves after the same " +
        "number of engine frames on every run (see the 'frames' field on the response). Returns the " +
        "resolved node plus 'frames' (engine frames elapsed since registration) on success, or " +
        "error='timeout' once 'max_frames' is exhausted (or the optional 'timeout_ms' safety ceiling " +
        "is hit first — never the intended way to bound a deterministic scenario). Like time.scale/" +
        "time.frames, this only advances the local engine clock — see docs/INSTRUMENTATION.md 'Domain " +
        "time' for network/server-authoritative games.",
      inputSchema: {
        ...selectorShape,
        property: z
          .string()
          .optional()
          .describe("Name of the property to watch (with 'equals'). Mutually exclusive with 'method'."),
        equals: z
          .unknown()
          .optional()
          .describe("Expected value of 'property' or 'method' (Variant→JSON mapping)."),
        method: z
          .string()
          .optional()
          .describe(
            "Parameterized domain query: method (pure read) re-called every step with 'args' until " +
              "its return value equals 'equals'. Mutually exclusive with 'property'.",
          ),
        args: z.array(z.unknown()).optional().describe("Positional arguments of 'method'."),
        signal: z
          .string()
          .optional()
          .describe("Not supported by time.step_until (a one-shot event doesn't fit a frame budget) — rejected with error='bad_request'."),
        max_frames: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe(
            "Frame budget before 'timeout' (default 300, ~5s at 60 FPS) — the deterministic axis. " +
              "0 = check the condition once, no stepping. Raise 'client_timeout_ms' accordingly for large budgets.",
          ),
        timeout_ms: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Optional wall-clock safety ceiling (ms) — never the primary budget, only a net against " +
              "a stuck engine loop. Unset by default (frame budget only).",
          ),
        ...clientTimeoutShape,
        ...instanceShape,
      },
    },
    async (params) => {
      try {
        const { client_timeout_ms, instance, ...verbParams } = params;
        const resp = await session.call("time.step_until", verbParams, client_timeout_ms, instance);
        return textResult(resp);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "screenshot",
    {
      title: "screenshot",
      description:
        "PNG (base64) capture of the window — best effort, never an oracle (§1/§4). " +
        "Fails with error='no_renderer' in --headless (no renderer available). Addressable per " +
        "instance (spec #66): pass 'instance' to see a specific connected client's screen.",
      inputSchema: { ...clientTimeoutShape, ...instanceShape },
    },
    async (params) => {
      try {
        const resp = await session.call("screenshot", {}, params.client_timeout_ms, params.instance);
        return textResult(resp);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "launch_game",
    {
      title: "launch_game",
      description:
        "Launches the Godot binary/project with --playtest --bridge-port=0 (+ port-file), waits for " +
        "the Bridge to listen then connects to it (with retry). `command` is the Godot binary (or the " +
        "game's export); `args` are the arguments *before* the '--' separator (e.g. '--path', '.', " +
        "'--headless'). Add-not-replace (spec #66): binds the new connection to `instance` (default " +
        "\"default\"), replacing only that instance's own slot — every other connected instance is " +
        "left untouched, so a session can hold several named clients at once.",
      inputSchema: {
        command: z.string().describe("Path of the Godot binary (or game export) to launch."),
        args: z
          .array(z.string())
          .optional()
          .describe("Arguments before '--' (e.g. ['--path', '.', '--headless'])."),
        extraGameArgs: z
          .array(z.string())
          .optional()
          .describe("Additional user arguments after --playtest (after '--')."),
        cwd: z.string().optional().describe("Working directory of the launched process."),
        env: z
          .record(z.string())
          .optional()
          .describe(
            "Additional environment variables, merged on top of the MCP server's own " +
              "(e.g. pointing the game to an ephemeral test backend).",
          ),
        portFileTimeoutMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Max delay waiting for the port file (default 30000ms)."),
        connectRetries: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("TCP connection attempts once the port is known (default 20)."),
        ...instanceShape,
      },
    },
    async (params) => {
      try {
        const { instance, ...launchOptions } = params;
        const result = await session.launch(launchOptions, instance);
        return textResult({ id: 0, ok: true, ...result });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "attach",
    {
      title: "attach",
      description:
        "Connects to a Bridge already listening on an existing port (game already launched manually, " +
        "or a known fixed port). Add-not-replace (spec #66): binds the connection to `instance` " +
        "(default \"default\"), replacing only that instance's own slot — every other connected " +
        "instance is left untouched.",
      inputSchema: {
        port: z.number().int().positive().describe("TCP port of the Bridge to join."),
        host: z.string().optional().describe("Bridge host (default 127.0.0.1 — loopback, §2)."),
        retries: z.number().int().positive().optional().describe("Connection attempts (default 1)."),
        ...instanceShape,
      },
    },
    async (params) => {
      try {
        const result = await session.attach(params.port, params.host, params.retries, undefined, params.instance);
        return textResult({ id: 0, ok: true, ...result });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "quit_game",
    {
      title: "quit_game",
      description:
        "Clean shutdown of the controlled game (ticket #20): sends the `quit` verb (the Bridge " +
        "responds then calls get_tree().quit(), §4), waits for its natural exit if the process was " +
        "launched by launch_game — SIGKILL as a last resort if the grace delay expires (never " +
        "SIGTERM: it crashes Godot .NET builds into an OS crash popup) — " +
        "then closes that instance's slot (like disconnect). A bare call (no `instance`) closes only " +
        "\"default\" — closing several instances is one quit_game call per instance, there is no " +
        "quit-all (spec #66). Prefer this tool over an external process kill: a direct kill triggers " +
        "noise (OS-side crash notification, messy exit logs).",
      inputSchema: {
        quit_grace_ms: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Grace delay after 'quit' before the last-resort SIGKILL (default 5000ms)."),
        kill_grace_ms: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Max wait for the process to disappear after SIGKILL (default 3000ms)."),
        ...instanceShape,
      },
    },
    async (params) => {
      try {
        await session.quitGame(params.instance, { quitGraceMs: params.quit_grace_ms, killGraceMs: params.kill_grace_ms });
        return textResult({ id: 0, ok: true });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "assert_eventually_property",
    {
      title: "assert_eventually_property",
      description:
        "Sets an assertion (ticket #13, split into now/eventually by ticket #35, ADR-0006): retries " +
        "(retry-until-timeout, like wait_for) until a selector resolves to a given property, then — " +
        "only if it's true — records it in the session trace as a step to be frozen by freeze_scenario. " +
        "Unlike `query`, this is an explicit judgment by the agent on the game's state, not a simple " +
        "exploratory read. For a value that must already be correct RIGHT NOW, with no retry, use " +
        "assert_now_property instead.",
      inputSchema: {
        ...selectorShape,
        property: z.string().describe("Name of the property to check."),
        equals: z.unknown().describe("Expected value of 'property'."),
        message: z.string().optional().describe("Optional message, carried into the generated frozen script."),
        timeout_ms: z.number().int().positive().optional().describe("Delay before failure. Default 2000ms."),
        ...clientTimeoutShape,
        ...instanceShape,
      },
    },
    async (params) => {
      try {
        const { test_id, group, path, property, equals, message, timeout_ms, client_timeout_ms, instance } = params;
        const resp = await session.assertEventuallyProperty(
          { test_id, group, path },
          property,
          equals,
          message,
          timeout_ms ?? 2000,
          client_timeout_ms,
          instance,
        );
        return textResult(resp);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "assert_now_property",
    {
      title: "assert_now_property",
      description:
        "Sets an assertion (ticket #35, ADR-0006): checks RIGHT NOW, once, with no retry, that a " +
        "selector resolves to a given property, then — only if it's true — records it in the session " +
        "trace as a step to be frozen by freeze_scenario. Fails if the property is wrong at the moment " +
        "of the call, even if it would become correct later — the guarantee assert_eventually_property " +
        "cannot provide. Unlike `query`, this is an explicit judgment by the agent on the game's state, " +
        "not a simple exploratory read.",
      inputSchema: {
        ...selectorShape,
        property: z.string().describe("Name of the property to check."),
        equals: z.unknown().describe("Expected value of 'property'."),
        message: z.string().optional().describe("Optional message, carried into the generated frozen script."),
        ...clientTimeoutShape,
        ...instanceShape,
      },
    },
    async (params) => {
      try {
        const { test_id, group, path, property, equals, message, client_timeout_ms, instance } = params;
        const resp = await session.assertNowProperty(
          { test_id, group, path },
          property,
          equals,
          message,
          client_timeout_ms,
          instance,
        );
        return textResult(resp);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "freeze_scenario",
    {
      title: "freeze_scenario",
      description:
        "Freezes the session trace (replayable verbs + assertions set via assert_now_property/" +
          "assert_eventually_property) into a " +
        "frozen PlaytestCase test (docs/protocol/DRAFT-v0.md §7), written to res://playtests/ of the " +
        "targeted project. Every selector in the trace is re-verified against the live game before " +
        "generation: a selector that no longer resolves refuses the freeze (explicit error, never a " +
        "stillborn test). A scenario using a non-CI-safe verb (screenshot, act.input type=click) is " +
        "refused unless `windowed: true` is passed explicitly (the generated test is then marked " +
        "windowed-only and skipped by the runner in --headless).",
      inputSchema: {
        name: z.string().describe("Scenario name: becomes test_<name>() and the file name (snake_case)."),
        scene_path: z
          .string()
          .describe("res://... scene instantiated by start_game() in the generated script."),
        windowed: z
          .boolean()
          .optional()
          .describe("Assumes a non-CI-safe scenario (screenshot/act.input click) — otherwise refused."),
        project_path: z
          .string()
          .optional()
          .describe(
            "Filesystem root of the targeted Godot project (where to write playtests/<name>.gd). " +
              "Default: the cwd passed to launch_game, if there is one.",
          ),
        verify_timeout_ms: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Delay for the live re-verification of each selector. Default 500ms."),
      },
    },
    async (params) => {
      try {
        const trace = session.getTrace();
        if (trace.length === 0) {
          return errorResult(
            "empty session trace — explore the game (act.press/wait_for/...) and set at least one " +
              "assertion (assert_now_property/assert_eventually_property) before freezing.",
          );
        }

        const problems = await verifySelectorsLive(session, trace, params.verify_timeout_ms ?? 500);
        if (problems.length > 0) {
          const detail = problems
            .map((p) => `- [instance: ${p.instance}] ${JSON.stringify(p.selector)}: ${p.error}${p.detail ? ` (${p.detail})` : ""}`)
            .join("\n");
          return errorResult(
            `freeze refused: ${problems.length} selector(s) no longer resolve against the live game ` +
              `(re-verification at generation time) — not a stillborn test:\n${detail}`,
          );
        }

        let result;
        try {
          result = generateFrozenScript(trace, {
            name: params.name,
            scenePath: params.scene_path,
            windowed: params.windowed,
          });
        } catch (err) {
          if (err instanceof FreezeRefusedError) {
            return errorResult(err.message);
          }
          throw err;
        }

        const projectPath = params.project_path ?? session.getLaunchedProjectPath();
        if (!projectPath) {
          return errorResult(
            "missing project_path: cannot determine where to write res://playtests/ " +
              "(pass project_path explicitly, especially after an 'attach').",
          );
        }

        const playtestsDir = join(projectPath, "playtests");
        mkdirSync(playtestsDir, { recursive: true });
        const filePath = join(playtestsDir, result.fileName);
        writeFileSync(filePath, result.code, "utf8");

        return textResult({
          id: 0,
          ok: true,
          file_path: filePath,
          file_name: result.fileName,
          ci_safe: result.ciSafe,
          code: result.code,
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
