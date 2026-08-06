/**
 * Instance name validation (spec #66): the naming site for `launch_game`/
 * `attach`'s `instance` field — validated up front so Freeze can never turn
 * a bad name into a GDScript variable that fails to parse.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { assertValidNewInstanceName, DEFAULT_INSTANCE, InvalidInstanceNameError } from "../../src/instance-name.js";

test("'default' is always a legal instance name (addresses/replaces the built-in slot)", () => {
  assert.doesNotThrow(() => assertValidNewInstanceName(DEFAULT_INSTANCE));
});

test("a lowercase snake_case name is legal", () => {
  assert.doesNotThrow(() => assertValidNewInstanceName("b"));
  assert.doesNotThrow(() => assertValidNewInstanceName("player_two"));
  assert.doesNotThrow(() => assertValidNewInstanceName("client2"));
});

test("a name starting with a digit is rejected", () => {
  assert.throws(() => assertValidNewInstanceName("2b"), InvalidInstanceNameError);
});

test("an uppercase name is rejected", () => {
  assert.throws(() => assertValidNewInstanceName("Player"), InvalidInstanceNameError);
});

test("a name with a dash or space is rejected", () => {
  assert.throws(() => assertValidNewInstanceName("player-two"), InvalidInstanceNameError);
  assert.throws(() => assertValidNewInstanceName("player two"), InvalidInstanceNameError);
});

test("GDScript keywords are rejected", () => {
  for (const kw of ["self", "if", "var", "func", "class_name", "await", "true", "null"]) {
    assert.throws(() => assertValidNewInstanceName(kw), InvalidInstanceNameError, `expected '${kw}' to be rejected`);
  }
});

test("the error names the offending value and the reason", () => {
  try {
    assertValidNewInstanceName("Bad Name!");
    assert.fail("expected a throw");
  } catch (err) {
    assert.ok(err instanceof InvalidInstanceNameError);
    assert.match((err as Error).message, /Bad Name!/);
  }
});
