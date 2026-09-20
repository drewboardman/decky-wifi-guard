# Changelog

## 0.1.0

- Pause Steam downloads on a selected Wi-Fi network using Steam network/download events, without periodic polling or pings.
- Preserve pre-existing pauses and journal owned pauses for reload recovery.
- Add a bounded event supervisor, explicit fault recovery, operation/acknowledgement deadlines, callback containment, and a React error boundary.
- Separate pure policy and effect algebras from Steam, Decky, filesystem, and NetworkManager adapters.
- Add automated failure-injection tests and CI packaging.

Live Steam Deck integration still requires on-device verification.
