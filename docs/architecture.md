# Architecture and failure boundaries

The architecture separates a pure decision algebra from capability interfaces and their interpreters. It uses TypeScript discriminated unions and small interfaces where Scala would use a sealed trait and algebras. There is no generic effect framework: the plugin has a small fixed set of effects, and native Steam integration already uses promises.

## Modules

- `src/domain.ts`: validated settings/snapshots and the pure `decide` function. Its `Decision` cases are `wait`, `hold`, `acquire`, `pause`, `resume`, and `release`.
- `src/ports.ts`: the `Repository`, `Steam`, and `Runtime` algebras. They expose capabilities, not implementation details.
- `src/adapters/`: Decky RPC envelopes and native Steam integration. The Steam adapter validates unknown events, filters remote clients, and prevents callback exceptions from escaping into Steam.
- `src/controller.ts`: a serialized, bounded interpreter. It journals pause ownership before pausing and clears it after a resume acknowledgement. It also owns subscription lifetime and circuit state.
- `src/safety.ts`: explicit `Result` values and single-flight operation deadlines. The supervisor interprets errors as a latched circuit fault.
- `src/ErrorBoundary.tsx`: contains React rendering/lifecycle errors, reports them to the supervisor, and renders a plain fallback without Decky UI dependencies.
- `main.py`: Decky composition and an RPC error boundary. Initialization failures leave the plugin inert instead of throwing from `_main`.
- `py_modules/wifi_guard`: `SettingsStore` and `NetworkReader` protocols, filesystem/nmcli interpreters, and a serialized backend service. File I/O runs off the asyncio loop.

Tests substitute these capabilities with an in-memory repository, a fake Steam event source, and a deterministic clock. The policy tests run without React, Steam, Decky, or a filesystem.

## Bounds and recovery

| Boundary | Behavior |
| --- | --- |
| Native malformed event / API exception | Latched fault; callbacks become inert until explicit retry |
| Subscriber/render failure | Remove failing subscriber or render React fallback; do not intercept global Steam errors |
| Partial startup | Roll back acquired subscriptions independently |
| Unsubscribe failure | Continue cleanup, invalidate callback generation, refuse resubscription until reload |
| Event burst | Coalesce for 100 ms with one pending snapshot |
| Event flood / feedback loop | Stop above 100 meaningful events/second or 16 reconciliation passes |
| Effect/RPC | 6-second deadline; keep timed-out work tracked until settlement; no overlapping retry |
| Native command acknowledgement | 3-second one-shot deadline; stop if Steam never confirms |
| Network subprocess | 4-second deadline, 256 KiB output cap, kill/reap on error or cancellation; 0.5-second reap limit |
| Corrupt or oversized settings | Inert startup; preserve file for inspection; maximum 4 KiB |
| Settings write | Serialize, write temporary file, fsync, replace, fsync parent; retain previous in-memory state on failure |
| Shutdown | Attempt to restore only an owned pause; preserve the journal if cleanup fails or work is uncertain |

Timers exist only for event coalescing and operation deadlines. There is no periodic poll, ping, active network scan, or automatic retry loop. An idle healthy plugin schedules no work.

Ordinary NetworkManager lookup errors are a degraded state: keep the current download state, show the error, and permit explicitly disabling protection. Unexpected failures open the circuit. A retry resubscribes for a fresh native pause snapshot before making decisions; it does not trust events missed while faulted.

On shutdown the native control call may be dispatched without a final pause acknowledgement because Decky is tearing down event delivery. Cleanup is best effort. The frontend shares Steam's JavaScript process, so these boundaries cannot isolate a native Steam crash, a synchronous native call that never returns, an out-of-memory condition, or an OS fault. No device-wide "never crashes" guarantee is possible. The plugin performs no firewall/routing changes, service restarts, process termination outside its own nmcli child, or root operations.

## Manual SteamOS acceptance

The automated suite verifies policy, adapters, React containment, timeout and recovery behavior with test interpreters. On a Steam Deck, verify network switching, a pre-existing manual pause, a manual resume while protected, sleep/wake, closed-panel operation, fault retry, and unload. Confirm the callback registration/unregistration contract on the installed Steam build.
