import { callable, definePlugin } from "@decky/api";
import { ButtonItem, PanelSection, PanelSectionRow, staticClasses, TextField, ToggleField } from "@decky/ui";
import { useEffect, useState } from "react";
import { FaWifi } from "react-icons/fa";
import { KeyValue, Notice, Pill } from "./Common";
import { DownloadGuard } from "./controller";
import type { BackendState, Downloads, Network } from "./controller";

const read = callable<[], BackendState>("get_state");
const own = callable<[boolean], void>("set_owned_pause");
const save = callable<[boolean, string], { enabled: boolean; ssid: string }>("save_settings");

function Content({ guard }: { guard: DownloadGuard }) {
  const [state, setState] = useState(guard.state);
  const [ssid, setSsid] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setState(guard.state);
    return guard.subscribe(() => setState({ ...guard.state }));
  }, [guard]);
  const backend = state.backend;
  const draft = ssid ?? backend?.ssid ?? "";
  const current = backend?.networks[0];
  async function update(enabled: boolean, network: string) {
    setBusy(true);
    setError(null);
    try {
      await save(enabled, network);
      setSsid(null);
      await guard.refresh();
    } catch (err) { setError(String(err)); }
    finally { setBusy(false); }
  }
  const problem = error || state.error;
  const label = problem ? "Needs attention" : !backend ? "Checking…" : !backend.enabled ? "Guard off" :
    !backend.ssid ? "Choose a network" : state.blocked ? (state.paused ? "Downloads paused" : "Pausing downloads…") : "Downloads unrestricted";
  return <>
    <PanelSection title="Download protection">
      <PanelSectionRow>
        <Pill color={problem ? "#7b3636" : state.blocked ? "#5a4a20" : "#2f6b3f"}>{label}</Pill>
        <div style={{ marginTop: 10 }}>
          <KeyValue label="Connected Wi-Fi" value={backend?.network_error ? "Unavailable" : backend?.networks.join(", ") || "Not connected"} />
          <KeyValue label="Protected network" value={backend?.ssid || "Not set"} />
        </div>
      </PanelSectionRow>
      {problem && <PanelSectionRow><Notice tone="error">{problem}</Notice><ButtonItem layout="below" onClick={() => void guard.refresh()}>Retry status</ButtonItem></PanelSectionRow>}
      <PanelSectionRow><ToggleField label="Pause on this network" description="Pause all Steam downloads while connected." checked={backend?.enabled ?? false} disabled={!backend || busy} onChange={(enabled) => void update(enabled, backend?.ssid ?? "")} /></PanelSectionRow>
    </PanelSection>
    <PanelSection title="Wi-Fi network">
      <PanelSectionRow><ButtonItem layout="below" disabled={busy || !current || !!backend?.network_error} onClick={() => void update(backend?.enabled ?? true, current!)}>Use current network</ButtonItem></PanelSectionRow>
      <PanelSectionRow><TextField label="Network name (SSID)" description="Match the name exactly, including capitals and spaces." value={draft} disabled={busy || !backend} onChange={(event) => setSsid(event.target.value)} /></PanelSectionRow>
      <PanelSectionRow><ButtonItem layout="below" disabled={busy || !backend || draft === backend.ssid} onClick={() => void update(backend!.enabled, draft)}>{busy ? "Saving…" : "Save network"}</ButtonItem></PanelSectionRow>
      <PanelSectionRow><Notice title="Automatic protection">Downloads resume after leaving this network if the guard paused them. A pre-existing pause stays in place. Turn off the guard to download here.</Notice></PanelSectionRow>
      <PanelSectionRow><Notice>Responds to network changes while Decky is running in Gaming Mode. Steam game and Workshop downloads only; other apps and system updates are unaffected.</Notice></PanelSectionRow>
    </PanelSection>
  </>;
}

export default definePlugin(() => {
  const steam = (window as unknown as { SteamClient?: { Downloads?: Downloads; System?: { Network?: Network } } }).SteamClient;
  const guard = new DownloadGuard({ read, own, downloads: steam?.Downloads as Downloads, network: steam?.System?.Network as Network });
  guard.start();
  return {
    name: "Wi-Fi Download Guard",
    titleView: <div className={staticClasses.Title}>Wi-Fi Download Guard</div>,
    icon: <FaWifi />,
    content: <Content guard={guard} />,
    onDismount() { void guard.stop(); },
  };
});
