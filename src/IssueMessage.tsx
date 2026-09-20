import type { UiIssue } from "./errors";

/** Plain React also works inside the crash fallback, without Decky UI. */
export function IssueMessage({
  issue,
  stopped = false,
}: {
  issue: UiIssue;
  stopped?: boolean;
}) {
  return (
    <div
      role={issue.tone === "error" ? "alert" : "status"}
      style={{ color: issue.tone === "error" ? "#ff8b8b" : undefined }}
    >
      <div style={{ fontWeight: 600 }}>{issue.message}</div>
      {issue.hint && <div>{issue.hint}</div>}
      {stopped && <div>Automatic protection is stopped.</div>}
    </div>
  );
}
