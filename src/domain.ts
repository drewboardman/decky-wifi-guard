/** Pure policy: no Steam, React, timers, filesystem, or exceptions. */
export interface Settings {
  enabled: boolean;
  ssid: string;
}
export interface Snapshot extends Settings {
  owned_pause: boolean;
  networks: string[];
  network_error: string | null;
}
export type Decision =
  | { kind: "wait"; reason: string }
  | { kind: "hold" }
  | { kind: "acquire" }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "release" };

export const protects = (snapshot: Snapshot): boolean =>
  snapshot.enabled &&
  snapshot.ssid !== "" &&
  snapshot.networks.includes(snapshot.ssid);

export function decide(
  snapshot: Snapshot | null,
  paused: boolean | null,
  owned: boolean,
): Decision {
  if (!snapshot) return { kind: "wait", reason: "Waiting for saved settings…" };
  if (snapshot.enabled && snapshot.ssid && snapshot.network_error)
    return { kind: "wait", reason: snapshot.network_error };
  if (paused === null)
    return { kind: "wait", reason: "Waiting for Steam download status…" };
  if (protects(snapshot))
    return paused ? { kind: "hold" } : { kind: owned ? "pause" : "acquire" };
  return owned ? { kind: paused ? "resume" : "release" } : { kind: "hold" };
}

export function isSettings(value: unknown): value is Settings {
  if (!value || typeof value !== "object") return false;
  const v = value as Settings;
  return (
    typeof v.enabled === "boolean" &&
    typeof v.ssid === "string" &&
    new TextEncoder().encode(v.ssid).length <= 32 &&
    !/[\x00-\x1f\x7f]/.test(v.ssid)
  );
}

export function isSnapshot(value: unknown): value is Snapshot {
  if (!isSettings(value)) return false;
  const v = value as Snapshot;
  return (
    typeof v.owned_pause === "boolean" &&
    Array.isArray(v.networks) &&
    v.networks.length <= 32 &&
    v.networks.every((s) => typeof s === "string" && s.length <= 128) &&
    (v.network_error === null || typeof v.network_error === "string")
  );
}
