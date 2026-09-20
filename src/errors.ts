/** Stable error codes cross boundaries; exception messages never become UI copy. */
const messages = {
  unknown: [
    "An unknown error occurred.",
    "Try again. If it keeps happening, reload Decky.",
  ],
  steam_unavailable: [
    "Steam controls are unavailable.",
    "Update Steam, then reload Decky.",
  ],
  backend_unavailable: [
    "Wi-Fi Guard couldn’t connect.",
    "Try again, or reload Decky.",
  ],
  invalid_response: [
    "Received an unexpected response.",
    "Try again, or reload Decky.",
  ],
  network_unavailable: [
    "Couldn’t read the Wi-Fi network.",
    "Check your connection, then try again.",
  ],
  network_timeout: ["Wi-Fi detection timed out.", "Try again."],
  settings_unreadable: [
    "Couldn’t load saved settings.",
    "Reload Decky. Your saved settings were left untouched.",
  ],
  storage_unavailable: [
    "Couldn’t save settings.",
    "Check available storage and try again.",
  ],
  invalid_settings: [
    "That network name isn’t valid.",
    "Use up to 32 bytes without control characters.",
  ],
  timeout: ["The operation timed out.", "Wait a moment, then try again."],
  busy: ["An operation is still running.", "Wait a moment, then try again."],
  event_overload: [
    "Too many updates arrived at once.",
    "Try again when Steam has settled.",
  ],
  command_unconfirmed: [
    "Steam didn’t confirm the change.",
    "Check Steam’s Downloads page, then try again.",
  ],
  cleanup_failed: [
    "Couldn’t reset the Steam connection.",
    "Reload Decky to try again.",
  ],
  settings_pending: ["Loading settings…", ""],
  steam_pending: ["Waiting for Steam…", ""],
} as const;

export type IssueCode = keyof typeof messages;
export interface UiIssue {
  code: IssueCode;
  message: string;
  hint: string;
  tone: "error" | "info";
}
export function issueCode(value: unknown): IssueCode {
  return typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(messages, value)
    ? (value as IssueCode)
    : "unknown";
}
export function issue(code: IssueCode): UiIssue {
  const [message, hint] = messages[code];
  return {
    code,
    message,
    hint,
    tone:
      code === "settings_pending" || code === "steam_pending"
        ? "info"
        : "error",
  };
}
export class GuardFault extends Error {
  readonly code: IssueCode;
  readonly detail: unknown;
  constructor(code: IssueCode, detail?: unknown) {
    super(code);
    this.name = "GuardFault";
    this.code = code;
    this.detail = detail;
  }
}
export function issueFor(error: unknown): UiIssue {
  try {
    return issue(
      error instanceof GuardFault ? issueCode(error.code) : "unknown",
    );
  } catch {
    return issue("unknown");
  }
}
