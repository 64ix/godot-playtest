/**
 * Instance names (spec #66): the shared naming rule for the "which
 * connection" dimension both drivers gained — the MCP surface's `instance`
 * field (`launch_game`/`attach`, every per-instance tool) and the GDScript
 * surface's `attach_instance(name)` (addons/playtest/playtest_client.gd,
 * mirrored by addons/playtest/instance_name.gd since that runtime is a
 * separate engine, not Node).
 *
 * Validated **at the naming site** (here, for `launch_game`/`attach`) so
 * that a name Freeze later turns into a GDScript variable
 * (`var <name> := await attach_instance("<name>")`) can never produce a file
 * that fails to parse.
 */

/** The session's built-in slot: instance 0, `self` on the GDScript surface.
 * Always a legal value for `launch_game`/`attach`'s `instance` field (it
 * addresses/replaces the default slot — the "launch-twice-to-restart"
 * workflow every existing single-instance tool call already relies on) —
 * but never a name `attach_instance` mints on the GDScript surface (it
 * never mints instance 0; see instance_name.gd `validate`). */
export const DEFAULT_INSTANCE = "default";

/** GDScript keywords that would otherwise satisfy `^[a-z][a-z0-9_]*$` —
 * kept in sync with addons/playtest/instance_name.gd's identical list
 * (reference: GDScript 2.0 "Keywords" table, Godot 4 docs). Keywords that
 * are already uppercase (PI, TAU, INF, NAN, ...) never match the regex, so
 * they need no entry here. */
const GDSCRIPT_KEYWORDS = new Set([
  "if", "elif", "else", "for", "while", "match", "break", "continue", "pass",
  "return", "class", "class_name", "extends", "is", "in", "as", "self",
  "signal", "func", "static", "const", "enum", "var", "breakpoint", "preload",
  "await", "yield", "assert", "void", "and", "or", "not", "true", "false",
  "null", "super",
]);

const INSTANCE_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

export class InvalidInstanceNameError extends Error {
  constructor(name: string, reason: string) {
    super(`invalid instance name '${name}': ${reason}`);
    this.name = "InvalidInstanceNameError";
  }
}

/** Validates a name given to `launch_game`/`attach`'s `instance` field (MCP
 * surface naming site). `"default"` is always legal there — it addresses or
 * replaces the built-in default slot, never mints a new one. Any other name
 * must be a safe GDScript identifier: `^[a-z][a-z0-9_]*$`, not a reserved
 * keyword, not `self` — so that Freeze can always turn it into
 * `var <name> := await attach_instance("<name>")` without producing a file
 * that fails to parse. Throws `InvalidInstanceNameError` otherwise. */
export function assertValidNewInstanceName(name: string): void {
  if (name === DEFAULT_INSTANCE) return;
  if (!INSTANCE_NAME_PATTERN.test(name)) {
    throw new InvalidInstanceNameError(name, "must match ^[a-z][a-z0-9_]*$");
  }
  if (GDSCRIPT_KEYWORDS.has(name)) {
    throw new InvalidInstanceNameError(name, "reserved GDScript keyword");
  }
}
