import assert from "node:assert/strict";
import test from "node:test";
import { DownloadGuard } from "../src/controller";
import type { Snapshot } from "../src/domain";
import type { Ports, Runtime } from "../src/ports";

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
function clock() {
  let now = 0,
    id = 0;
  const jobs = new Map<number, { at: number; run: () => void }>();
  const errors: unknown[] = [];
  const runtime: Runtime = {
    now: () => now,
    later(ms, run) {
      const key = ++id;
      jobs.set(key, { at: now + ms, run });
      return () => {
        jobs.delete(key);
      };
    },
    report: (...args) => {
      errors.push(args);
    },
  };
  return {
    runtime,
    jobs,
    errors,
    advance(ms: number) {
      now += ms;
      for (const [key, job] of [...jobs])
        if (job.at <= now) {
          jobs.delete(key);
          job.run();
        }
    },
  };
}
function fixture(paused = false, owned = false, start = true) {
  const time = clock();
  const snapshot: Snapshot = {
    enabled: true,
    ssid: "Phone",
    owned_pause: owned,
    networks: ["Phone"],
    network_error: null,
  };
  const calls: boolean[] = [],
    journal: boolean[] = [];
  let pauseEvent = (_value: boolean) => {},
    networkEvent = () => {},
    fault = (_error: unknown) => {};
  let reads = 0,
    removes = 0;
  const ports: Ports = {
    runtime: time.runtime,
    repository: {
      read: async () => {
        reads++;
        return { ...snapshot };
      },
      save: async (settings) => {
        Object.assign(snapshot, settings);
      },
      own: async (value) => {
        journal.push(value);
        snapshot.owned_pause = value;
      },
    },
    steam: {
      onPauseChanged(notify, onFault) {
        pauseEvent = notify;
        fault = onFault;
        notify(paused);
        return () => {
          removes++;
        };
      },
      onNetworkChanged(notify) {
        networkEvent = notify;
        return () => {
          removes++;
        };
      },
      async setDownloadsEnabled(enabled) {
        calls.push(enabled);
        paused = !enabled;
        pauseEvent(paused);
      },
    },
  };
  const guard = new DownloadGuard(ports);
  if (start) guard.start();
  return {
    guard,
    ports,
    snapshot,
    calls,
    journal,
    time,
    reads: () => reads,
    removes: () => removes,
    pause: (value: boolean) => {
      paused = value;
      pauseEvent(value);
    },
    network: () => networkEvent(),
    fault: (error: unknown) => fault(error),
    async event() {
      networkEvent();
      time.advance(100);
      await settle();
    },
  };
}

test("pause/resume policy runs with the panel closed; no scheduled idle work", async () => {
  const h = fixture();
  await settle();
  assert.deepEqual(h.calls, [false]);
  assert.deepEqual(h.journal, [true]);
  assert.equal(h.time.jobs.size, 0);
  h.snapshot.networks = ["Home"];
  await h.event();
  assert.deepEqual(h.calls, [false, true]);
  assert.deepEqual(h.journal, [true, false]);
  assert.equal(h.time.jobs.size, 0);
  await h.guard.stop();
});
test("pre-existing manual pause is never claimed or resumed", async () => {
  const h = fixture(true);
  await settle();
  h.snapshot.networks = ["Home"];
  await h.event();
  await h.guard.stop();
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.journal, []);
});
test("download events re-enforce protection without network I/O", async () => {
  const h = fixture();
  await settle();
  for (let i = 0; i < 1000; i++) h.pause(true);
  h.pause(false);
  h.time.advance(100);
  await settle();
  assert.deepEqual(h.calls, [false, false]);
  assert.equal(h.reads(), 1);
  await h.guard.stop();
});
test("case-sensitive match and multiple Wi-Fi interfaces", async () => {
  const h = fixture(true);
  await settle();
  h.pause(false);
  h.snapshot.networks = ["phone", "Phone "];
  await h.event();
  assert.deepEqual(h.calls, []);
  h.snapshot.networks = ["Home", "Phone"];
  await h.event();
  assert.deepEqual(h.calls, [false]);
  await h.guard.stop();
});
test("network lookup error never resumes an owned pause; explicit disable releases it", async () => {
  const h = fixture();
  await settle();
  h.snapshot.networks = [];
  h.snapshot.network_error = "nmcli failed";
  await h.event();
  assert.deepEqual(h.calls, [false]);
  assert.match(h.guard.state.error!, /nmcli/);
  await h.guard.configure({ enabled: false, ssid: "Phone" });
  assert.deepEqual(h.calls, [false, true]);
  await h.guard.stop();
});
test("journal failure opens circuit before any download command", async () => {
  const h = fixture(true);
  await settle();
  h.ports.repository.own = async () => {
    throw new Error("disk full");
  };
  h.pause(false);
  await h.guard.refresh(false);
  assert.equal(h.guard.state.mode, "faulted");
  assert.deepEqual(h.calls, []);
  for (let i = 0; i < 1000; i++) {
    h.network();
    h.pause(false);
  }
  h.time.advance(10000);
  await settle();
  assert.equal(h.reads(), 1);
  assert.equal(h.time.errors.length, 1);
  await h.guard.stop();
});
test("malformed backend snapshot trips instead of invoking policy", async () => {
  const h = fixture(true, false, false);
  h.ports.repository.read = async () => null as never;
  h.guard.start();
  await settle();
  assert.equal(h.guard.state.mode, "faulted");
  assert.deepEqual(h.calls, []);
  await h.guard.stop();
});
test("failing view listener is removed; other listeners still receive updates", async () => {
  const h = fixture(true, false, false);
  let good = 0,
    bad = 0;
  h.guard.subscribe(() => {
    bad++;
    throw new Error("render observer failed");
  });
  h.guard.subscribe(() => {
    good++;
  });
  h.guard.start();
  await settle();
  await h.guard.refresh();
  assert.equal(bad, 1);
  assert.ok(good > 1);
  assert.equal(h.guard.state.mode, "active");
  await h.guard.stop();
});
test("failure while subscribing rolls back partial initialization", async () => {
  const h = fixture(true, false, false);
  h.ports.steam.onNetworkChanged = () => {
    throw new Error("API missing");
  };
  h.guard.start();
  await settle();
  assert.equal(h.guard.state.mode, "faulted");
  assert.equal(h.removes(), 1);
  assert.equal(h.reads(), 0);
  await h.guard.stop();
});
test("unsubscribe errors cannot skip other cleanup or owned-pause restoration", async () => {
  const h = fixture(false, false, false);
  const original = h.ports.steam.onPauseChanged;
  h.ports.steam.onPauseChanged = (...args) => {
    original(...args);
    return () => {
      throw new Error("unsubscribe");
    };
  };
  h.guard.start();
  await settle();
  await h.guard.stop();
  assert.equal(h.removes(), 1);
  assert.deepEqual(h.calls, [false, true]);
  const count = h.calls.length;
  h.network();
  h.pause(false);
  await settle();
  assert.equal(h.calls.length, count);
});
test("event storm opens circuit, bounds pending work and reports once", async () => {
  const h = fixture(true);
  await settle();
  for (let i = 0; i < 1000; i++) h.network();
  assert.equal(h.guard.state.mode, "faulted");
  assert.equal(h.time.jobs.size, 0);
  assert.equal(h.reads(), 1);
  assert.equal(h.time.errors.length, 1);
  await h.guard.stop();
});
test("event burst coalesces into one network snapshot", async () => {
  const h = fixture(true);
  await settle();
  for (let i = 0; i < 20; i++) h.network();
  assert.equal(h.time.jobs.size, 1);
  h.time.advance(100);
  await settle();
  assert.equal(h.reads(), 2);
  await h.guard.stop();
});
test("hung read times out, stays single-flight, and can be retried after settlement", async () => {
  const h = fixture(true, false, false);
  let release!: (s: Snapshot) => void,
    attempts = 0;
  h.ports.repository.read = () => {
    attempts++;
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  h.guard.start();
  await settle();
  h.time.advance(6001);
  await settle();
  assert.equal(h.guard.state.mode, "faulted");
  await h.guard.retry();
  assert.equal(attempts, 1);
  release({ ...h.snapshot });
  await settle();
  h.ports.repository.read = async () => ({ ...h.snapshot });
  await h.guard.retry();
  assert.equal(h.guard.state.mode, "active");
  await h.guard.stop();
});
test("a timed-out write cannot trigger a late pause or competing cleanup", async () => {
  const h = fixture(true);
  await settle();
  let complete!: () => void;
  h.ports.repository.own = () =>
    new Promise((resolve) => {
      complete = () => {
        h.snapshot.owned_pause = true;
        resolve();
      };
    });
  h.pause(false);
  const operation = h.guard.refresh(false);
  await settle();
  h.time.advance(6001);
  await operation;
  assert.equal(h.guard.state.mode, "faulted");
  await h.guard.stop();
  complete();
  await settle();
  assert.deepEqual(h.calls, []);
  assert.equal(h.snapshot.owned_pause, true);
});
test("a network event invalidates an in-flight snapshot before resume", async () => {
  const h = fixture(true, true, false);
  let release!: (s: Snapshot) => void;
  let reads = 0;
  h.ports.repository.read = () =>
    ++reads === 1
      ? new Promise((resolve) => {
          release = resolve;
        })
      : Promise.resolve({ ...h.snapshot });
  h.guard.start();
  await settle();
  h.network();
  release({ ...h.snapshot, networks: ["Home"] });
  await settle();
  assert.equal(reads, 2);
  assert.deepEqual(h.calls, []);
  await h.guard.stop();
});
test("rejected native command is contained without an unhandled rejection or auto retry", async () => {
  const h = fixture(true);
  await settle();
  h.ports.steam.setDownloadsEnabled = async () => {
    throw new Error("Steam failed");
  };
  h.pause(false);
  await h.guard.refresh(false);
  assert.equal(h.guard.state.mode, "faulted");
  assert.match(h.guard.state.error!, /Steam failed/);
  await h.guard.stop();
});
test("restore failure preserves journal; stop is idempotent", async () => {
  const h = fixture();
  await settle();
  let attempts = 0;
  h.ports.steam.setDownloadsEnabled = async () => {
    attempts++;
    throw new Error("Steam gone");
  };
  await h.guard.stop();
  await h.guard.stop();
  assert.equal(attempts, 1);
  assert.equal(h.snapshot.owned_pause, true);
});
test("fault and logger failures never escape the event boundary", async () => {
  const h = fixture(true);
  await settle();
  h.ports.runtime.report = () => {
    throw new Error("logger");
  };
  assert.doesNotThrow(() => h.fault(new Error("native event")));
  assert.equal(h.guard.state.mode, "faulted");
  await h.guard.stop();
});
test("reload recovers journal and only releases its own pause", async () => {
  const h = fixture(true, true, false);
  h.snapshot.networks = ["Home"];
  h.guard.start();
  await settle();
  assert.deepEqual(h.calls, [true]);
  assert.deepEqual(h.journal, [false]);
  await h.guard.stop();
});
test("unknown initial download state cannot acquire pause ownership", async () => {
  const h = fixture(false, false, false);
  h.ports.steam.onPauseChanged = () => () => {};
  h.guard.start();
  await settle();
  assert.deepEqual(h.calls, []);
  assert.match(h.guard.state.error!, /Waiting/);
  await h.guard.stop();
});

test("retry obtains fresh native state after manual resume while faulted", async () => {
  const h = fixture(true);
  await settle();
  h.guard.fail("test fault");
  h.pause(false);
  await h.guard.retry();
  await settle();
  assert.equal(h.guard.state.mode, "active");
  assert.deepEqual(h.calls, [false]);
  await h.guard.stop();
});
test("silent native command failure trips once instead of issuing commands repeatedly", async () => {
  const h = fixture(true);
  await settle();
  let calls = 0;
  h.ports.steam.setDownloadsEnabled = async () => {
    calls++;
  };
  h.pause(false);
  await h.guard.refresh(false);
  h.network();
  h.time.advance(100);
  await settle();
  assert.equal(calls, 1);
  h.time.advance(3001);
  await settle();
  assert.equal(h.guard.state.mode, "faulted");
  assert.match(h.guard.state.error!, /confirm/);
  await h.guard.stop();
});
test("failed unsubscribe prevents retries from accumulating listeners", async () => {
  const h = fixture(true, false, false);
  let registrations = 0;
  h.ports.steam.onNetworkChanged = () => {
    registrations++;
    return () => {
      throw new Error("unsubscribe");
    };
  };
  h.guard.start();
  await settle();
  h.guard.fail("test");
  await h.guard.retry();
  await h.guard.retry();
  assert.equal(registrations, 1);
  assert.equal(h.guard.state.mode, "faulted");
  await h.guard.stop();
});
test("a feedback loop yields to the circuit breaker within one drain", async () => {
  const h = fixture(false, false, false);
  let reads = 0;
  h.ports.repository.read = async () => {
    reads++;
    h.network();
    return { ...h.snapshot };
  };
  h.guard.start();
  await settle();
  assert.equal(h.guard.state.mode, "faulted");
  assert.ok(reads <= 16);
  assert.match(h.guard.state.error!, /feedback loop/);
  await h.guard.stop();
});
