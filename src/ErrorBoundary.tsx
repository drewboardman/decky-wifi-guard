import { issueFor } from "./errors";
import type { UiIssue } from "./errors";
import { IssueMessage } from "./IssueMessage";
import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

/** A plain React fallback deliberately avoids Decky's potentially failing UI. */
export class ErrorBoundary extends Component<
  { children: ReactNode; onError: (error: unknown) => void },
  { failure: UiIssue | null }
> {
  state: { failure: UiIssue | null } = { failure: null };
  static getDerivedStateFromError(error: unknown) {
    return { failure: issueFor(error) };
  }
  componentDidCatch(error: Error, _info: ErrorInfo) {
    try {
      this.props.onError(error);
    } catch {
      /* React boundary must stay inert. */
    }
  }
  render() {
    if (this.state.failure)
      return (
        <div style={{ padding: 16 }}>
          <IssueMessage issue={this.state.failure} stopped />
          <div style={{ color: "#ff8b8b" }}>Reload Decky to try again.</div>
        </div>
      );
    return this.props.children;
  }
}
