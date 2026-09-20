import assert from "node:assert/strict";
import test from "node:test";
import { decide, isSnapshot } from "../src/domain";
import type { Snapshot } from "../src/domain";
const snapshot: Snapshot = {
  enabled: true,
  ssid: "Phone",
  owned_pause: false,
  networks: ["Phone"],
  network_error: null,
};

test("decision algebra covers waiting, acquisition, enforcement and release", () => {
  assert.equal(decide(null, false, false).kind, "wait");
  assert.equal(decide(snapshot, null, false).kind, "wait");
  assert.equal(decide(snapshot, false, false).kind, "acquire");
  assert.equal(decide(snapshot, false, true).kind, "pause");
  assert.equal(decide(snapshot, true, false).kind, "hold");
  const home = { ...snapshot, networks: ["Home"] };
  assert.equal(decide(home, true, true).kind, "resume");
  assert.equal(decide(home, false, true).kind, "release");
  assert.equal(decide(home, true, false).kind, "hold");
});
test("unowned pauses are never resumed across every boolean policy combination", () => {
  for (const enabled of [false, true])
    for (const match of [false, true])
      for (const paused of [false, true, null])
        for (const network_error of [null, "failed"]) {
          const decision = decide(
            {
              ...snapshot,
              enabled,
              networks: match ? ["Phone"] : [],
              network_error,
            },
            paused,
            false,
          );
          assert.notEqual(decision.kind, "resume");
          assert.notEqual(decision.kind, "release");
        }
});
test("network failure holds while enabled but does not prevent explicit disable", () => {
  assert.equal(
    decide({ ...snapshot, network_error: "unknown" }, true, true).kind,
    "wait",
  );
  assert.equal(
    decide(
      { ...snapshot, network_error: "unknown", enabled: false },
      true,
      true,
    ).kind,
    "resume",
  );
});
test("snapshot validation rejects malformed boundaries, oversized names and control characters", () => {
  for (const value of [
    null,
    {},
    { ...snapshot, owned_pause: 1 },
    { ...snapshot, networks: [null] },
    { ...snapshot, ssid: "é".repeat(17) },
    { ...snapshot, ssid: "x\ny" },
  ])
    assert.equal(isSnapshot(value), false);
  assert.equal(isSnapshot({ ...snapshot, ssid: " Phone " }), true);
});
