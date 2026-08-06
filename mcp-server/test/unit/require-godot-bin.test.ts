import assert from "node:assert/strict";
import { test } from "node:test";
import { requireGodotBin } from "../integration/require-godot-bin.js";

test("requireGodotBin throws naming the variable and how to set it when GODOT_BIN is unset", () => {
  const prev = process.env.GODOT_BIN;
  delete process.env.GODOT_BIN;
  try {
    assert.throws(() => requireGodotBin(), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /GODOT_BIN/);
      assert.match(err.message, /GODOT_BIN=\/path\/to\/godot npm run test:integration/);
      return true;
    });
  } finally {
    if (prev === undefined) delete process.env.GODOT_BIN;
    else process.env.GODOT_BIN = prev;
  }
});

test("requireGodotBin returns GODOT_BIN unchanged when it is set", () => {
  const prev = process.env.GODOT_BIN;
  process.env.GODOT_BIN = "/some/path/to/godot";
  try {
    assert.equal(requireGodotBin(), "/some/path/to/godot");
  } finally {
    if (prev === undefined) delete process.env.GODOT_BIN;
    else process.env.GODOT_BIN = prev;
  }
});
