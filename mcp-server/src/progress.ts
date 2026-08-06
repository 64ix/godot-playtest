/**
 * Server-side progress reporting for slow waits (spec #9, ticket #14): while
 * a `wait_for`/`time.step_until` request is in flight, `BridgeClient.send`
 * ticks a reporter at the heartbeat cadence (5s by default,
 * `GODOT_PLAYTEST_PROGRESS_INTERVAL_MS` to override — unit tests shorten
 * it). This module turns each tick into the two agent-visible surfaces: a
 * server console line (stderr — stdout is the MCP transport, cf. index.ts)
 * and an MCP-standard `$/progress` notification
 * (`notifications/progress`). Both name the condition and elapsed/total, so
 * a slow wait reads as "in progress" rather than dead — with zero change to
 * the godot-playtest wire protocol (ADR-0004: interim Bridge responses stay
 * rejected; `$/progress` is MCP-standard and server-side).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WaitProgress } from "./bridge-client.js";

export type ProgressReporter = (report: WaitProgress) => void;

/** Reporter bound to a live `McpServer`: mirrors each progress tick to the
 * server console (stderr — stdout is the MCP transport) and as a
 * `notifications/progress` notification. The progress token is synthesized
 * per request (`wait:<id>`): agents rarely attach `_meta.progressToken` to
 * tool calls, and the notification requires a token; a client that cannot
 * correlate an unknown token simply ignores it — the console line is the
 * fallback for those clients. Best-effort by design: a tick racing a
 * teardown (game quit mid-wait) must never crash the server process, so
 * both failure modes are swallowed — the log line already went out. */
export function createProgressReporter(server: McpServer): ProgressReporter {
  return (report) => {
    console.error(`[godot-playtest-mcp] ${report.message}: ${report.elapsedMs}/${report.totalMs} ms`);
    try {
      void server.server
        .notification({
          method: "notifications/progress",
          params: {
            progressToken: `wait:${report.id}`,
            progress: report.elapsedMs,
            total: report.totalMs,
            message: report.message,
          },
        })
        .catch(() => {
          /* transport already gone: the console line above is the fallback */
        });
    } catch {
      /* not connected (teardown race): the console line above is the fallback */
    }
  };
}
