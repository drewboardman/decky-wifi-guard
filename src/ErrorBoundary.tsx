import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

/** A plain React fallback deliberately avoids Decky's potentially failing UI. */
export class ErrorBoundary extends Component<
  { children: ReactNode; onError: (error: unknown) => void },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error, _info: ErrorInfo) {
    try {
      this.props.onError(error);
    } catch {
      /* React boundary must stay inert. */
    }
  }
  render() {
    if (this.state.failed)
      return (
        <div role="alert" style={{ padding: 16 }}>
          Wi-Fi Guard encountered an error and stopped automatic protection.
          Reload Decky to try again. Steam’s Downloads page remains available.
        </div>
      );
    return this.props.children;
  }
}
