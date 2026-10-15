import test from "node:test";
import assert from "node:assert/strict";
import { canTransition } from "../src/orderStateMachine.js";

test("open orders can be paid or expire", () => {
  assert.ok(canTransition("created", "pending"));
  assert.ok(canTransition("pending", "paid"));
  assert.ok(canTransition("pending", "expired"));
});

test("terminal states never move", () => {
  for (const from of ["paid", "expired", "failed"] as const)
    for (const to of ["created", "pending", "paid", "expired", "failed"] as const)
      assert.equal(canTransition(from, to), false);
});
