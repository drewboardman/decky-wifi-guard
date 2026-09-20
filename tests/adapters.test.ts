import assert from "node:assert/strict";
import test from "node:test";
import { steamAdapter } from "../src/adapters/steam";

test("Steam adapter rejects malformed events, ignores remote clients, and contains failing handlers", () => {
  let callback: (v: unknown) => void = () => {};
  const values: boolean[] = [],
    faults: unknown[] = [];
  const adapter = steamAdapter({
    Downloads: {
      RegisterForDownloadOverview(fn) {
        callback = fn;
        return { unregister() {} };
      },
      EnableAllDownloads() {},
    },
  });
  const off = adapter.onPauseChanged(
    (v) => values.push(v),
    (e) => faults.push(e),
  );
  for (const value of [null, undefined, {}, { paused: "no" }])
    assert.doesNotThrow(() => callback(value));
  callback({ paused: false, remote_client_id: "123" });
  callback({ paused: true, remote_client_id: "0" });
  assert.deepEqual(values, [true]);
  assert.equal(faults.length, 4);
  off();
  adapter.onPauseChanged(
    () => {
      throw new Error("subscriber");
    },
    () => {
      throw new Error("fault handler");
    },
  );
  assert.doesNotThrow(() => callback({ paused: false }));
});
test("missing native capabilities fail locally, not via an unguarded property access", async () => {
  const adapter = steamAdapter(undefined);
  assert.throws(
    () =>
      adapter.onNetworkChanged(
        () => {},
        () => {},
      ),
    /unavailable/,
  );
  await assert.rejects(adapter.setDownloadsEnabled(false), /unavailable/);
});
test("download command always targets local client and awaits rejection", async () => {
  const calls: unknown[] = [];
  const adapter = steamAdapter({
    Downloads: {
      RegisterForDownloadOverview: () => ({ unregister() {} }),
      EnableAllDownloads(enabled, id) {
        calls.push([enabled, id]);
        return Promise.reject(new Error("rejected"));
      },
    },
  });
  await assert.rejects(adapter.setDownloadsEnabled(false), /rejected/);
  assert.deepEqual(calls, [[false, "0"]]);
});
