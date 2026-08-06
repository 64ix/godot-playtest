/**
 * Shared discriminator for the integration suite (spec #55, same class as
 * #40 for the GDScript runner): `npm run test:integration` is an explicit
 * request to run these tests against a real Godot binary, so a missing
 * `GODOT_BIN` means the harness could not resolve *how* to run them — a
 * resolution failure, not a "nothing to run" state. Every integration test
 * calls this first so the failure surfaces as a normal failing test (never
 * a `skip`, which contributes nothing to the exit code) while leaving
 * unrelated files — and `npm test`'s unit suite — unaffected.
 */
export function requireGodotBin(): string {
  const bin = process.env.GODOT_BIN;
  if (!bin) {
    throw new Error(
      "GODOT_BIN not set — export it to a Godot binary path to run the integration suite " +
        "(e.g. GODOT_BIN=/path/to/godot npm run test:integration). " +
        "No-Godot path: `npm test` (unit tests against the fake Bridge).",
    );
  }
  return bin;
}
