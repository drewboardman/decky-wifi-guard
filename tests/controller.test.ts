import assert from 'node:assert/strict';
import test from 'node:test';
import { DownloadGuard } from '../src/controller.ts';
import type { BackendState } from '../src/controller.ts';

function setup(paused = false, owned = false) {
  let backend: BackendState = { enabled: true, ssid: 'Phone', owned_pause: owned, networks: ['Phone'], network_error: null };
  const calls: boolean[] = [];
  const journal: boolean[] = [];
  let failOwn = false;
  let callback: (state: { paused: boolean }) => void = () => {};
  let networkEvent: () => void = () => {};
  const guard = new DownloadGuard({
    network: { RegisterForDeviceChanges: (fn) => { networkEvent = fn; return { unregister() {} }; } },
    read: async () => ({ ...backend }),
    own: async (value) => { if (failOwn) throw new Error('disk full'); journal.push(value); backend.owned_pause = value; },
    downloads: {
      EnableAllDownloads: (value) => { calls.push(value); callback({ paused: !value }); },
      RegisterForDownloadOverview: (fn) => { callback = fn; fn({ paused }); return { unregister() {} }; },
    },
  });
  guard.start();
  return { guard, calls, journal, backend, networkEvent: () => networkEvent(), setFail: () => { failOwn = true; },
    overview: (value: boolean) => callback({ paused: value }),
    settle: () => new Promise<void>((resolve) => setImmediate(resolve)) };
}

test('pauses on match, resumes on departure, records ownership first', async () => {
  const h = setup(); await h.settle();
  assert.deepEqual(h.calls, [false]); assert.deepEqual(h.journal, [true]);
  await h.guard.refresh(); assert.deepEqual(h.calls, [false]);
  h.backend.networks = ['Home']; await h.guard.refresh();
  assert.deepEqual(h.calls, [false, true]); assert.equal(h.backend.owned_pause, false);
  await h.guard.stop();
});
test('a pre-existing manual pause is never resumed', async () => {
  const h = setup(true); await h.settle();
  h.backend.networks = ['Home']; await h.guard.refresh(); await h.guard.stop();
  assert.deepEqual(h.calls, []); assert.deepEqual(h.journal, []);
});
test('manual resume on protected Wi-Fi is paused again', async () => {
  const h = setup(); await h.settle(); h.overview(false); await h.guard.refresh();
  assert.deepEqual(h.calls, [false, false]); await h.guard.stop();
});
test('network read failure keeps owned pause; switch off still releases', async () => {
  const h = setup(); await h.settle();
  h.backend.networks = []; h.backend.network_error = 'nmcli unavailable';
  await h.guard.refresh(); assert.deepEqual(h.calls, [false]); assert.match(h.guard.state.error!, /nmcli/);
  h.backend.enabled = false; await h.guard.refresh(); assert.deepEqual(h.calls, [false, true]); await h.guard.stop();
});
test('restart recovers owned pause on another network', async () => {
  const h = setup(true, true); await h.settle();
  h.backend.networks = ['Home']; await h.guard.refresh();
  assert.deepEqual(h.calls, [true]); await h.guard.stop();
});
test('matching is case and whitespace sensitive; supports multiple adapters', async () => {
  const h = setup(true); await h.settle();
  h.overview(false); h.backend.networks = ['phone', 'Phone ']; await h.guard.refresh();
  assert.deepEqual(h.calls, []);
  h.backend.networks = ['Home', 'Phone']; await h.guard.refresh(); assert.deepEqual(h.calls, [false]); await h.guard.stop();
});
test('cannot pause if recovery journal cannot be saved', async () => {
  const h = setup(true); await h.settle(); h.overview(false); h.setFail();
  await h.guard.refresh(); assert.deepEqual(h.calls, []); assert.match(h.guard.state.error!, /disk full/); await h.guard.stop();
});
test('unload restores only an owned pause', async () => {
  const h = setup(); await h.settle(); await h.guard.stop(); assert.deepEqual(h.calls, [false, true]);
});
test('closing panel does not stop monitoring', async () => {
  const h = setup(); const unsubscribe = h.guard.subscribe(() => {}); await h.settle(); unsubscribe();
  h.backend.networks = ['Home']; await h.guard.refresh(); assert.deepEqual(h.calls, [false, true]); await h.guard.stop();
});
test('unknown Steam pause status never guesses original state', async () => {
  const calls: boolean[] = [];
  const guard = new DownloadGuard({ network: { RegisterForDeviceChanges: () => ({ unregister() {} }) }, read: async () => ({ enabled: true, ssid: 'Phone', owned_pause: false, networks: ['Phone'], network_error: null }), own: async () => {}, downloads: { EnableAllDownloads: (v) => { calls.push(v); }, RegisterForDownloadOverview: () => ({ unregister() {} }) } });
  guard.start(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, []); assert.match(guard.state.error!, /Waiting/); guard.stop();
});

test('network event changes policy without a timer or panel', async () => {
  const h = setup(); await h.settle();
  h.backend.networks = ['Home']; h.networkEvent(); await h.settle();
  assert.deepEqual(h.calls, [false, true]);
  h.backend.networks = ['Phone']; h.networkEvent(); await h.settle();
  assert.deepEqual(h.calls, [false, true, false]);
  await h.guard.stop();
});

test('download pause events enforce protection without another network read', async () => {
  let reads = 0;
  let overview: (value: { paused: boolean; remote_client_id?: string }) => void = () => {};
  let paused = false;
  const calls: boolean[] = [];
  const guard = new DownloadGuard({
    read: async () => { reads++; return { enabled: true, ssid: 'Phone', owned_pause: false, networks: ['Phone'], network_error: null }; },
    own: async () => {},
    network: { RegisterForDeviceChanges: () => ({ unregister() {} }) },
    downloads: {
      RegisterForDownloadOverview: fn => { overview = fn; fn({ paused }); return { unregister() {} }; },
      EnableAllDownloads: enable => { calls.push(enable); paused = !enable; overview({ paused }); },
    },
  });
  guard.start(); await new Promise(resolve => setImmediate(resolve));
  for (let i = 0; i < 100; i++) overview({ paused: true });
  overview({ paused: false, remote_client_id: '123456' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [false]); assert.equal(reads, 1);
  overview({ paused: false, remote_client_id: '0' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [false, false]); assert.equal(reads, 1);
  await guard.stop();
});

test('missing event API reports incompatibility without polling', async () => {
  let reads = 0;
  const guard = new DownloadGuard({ read: async () => { reads++; throw new Error(); }, own: async () => {}, downloads: {} as never, network: {} as never });
  guard.start(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 0); assert.match(guard.state.error!, /required network\/download events/);
  await guard.stop();
});

test('network change during an in-flight snapshot cannot resume from stale data', async () => {
  let event: () => void = () => {};
  let release: (state: BackendState) => void = () => {};
  let count = 0;
  const calls: boolean[] = [];
  const blocked: BackendState = { enabled: true, ssid: 'Phone', owned_pause: true, networks: ['Phone'], network_error: null };
  const guard = new DownloadGuard({
    read: () => ++count === 1 ? new Promise(resolve => { release = resolve; }) : Promise.resolve(blocked),
    own: async () => {},
    downloads: { RegisterForDownloadOverview: fn => { fn({ paused: true }); return { unregister() {} }; }, EnableAllDownloads: value => { calls.push(value); } },
    network: { RegisterForDeviceChanges: fn => { event = fn; return { unregister() {} }; } },
  });
  guard.start(); await new Promise(resolve => setImmediate(resolve));
  event(); release({ ...blocked, networks: ['Home'] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(count, 2); assert.deepEqual(calls, []);
  await guard.stop();
});
