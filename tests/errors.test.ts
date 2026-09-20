import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { create, act } from "react-test-renderer";
import { GuardFault, issue, issueCode, issueFor } from "../src/errors";
import type { IssueCode } from "../src/errors";
import { IssueMessage } from "../src/IssueMessage";
import { unwrap } from "../src/adapters/protocol";
import { Effects } from "../src/safety";

test("unknown exceptions and lookalike messages never leak diagnostics into UI", () => {
  for (const error of [
    new Error("/private/settings.json: disk full\nstack"),
    "timeout",
    null,
    { code: "timeout", message: "raw failure" },
  ]) {
    const result = issueFor(error);
    assert.equal(result.code, "unknown");
    assert.equal(result.message, "An unknown error occurred.");
  }
});
test("known codes have short copy and keep technical causes out of the notice", () => {
  const codes: IssueCode[] = [
    "steam_unavailable",
    "backend_unavailable",
    "invalid_response",
    "network_unavailable",
    "network_timeout",
    "settings_unreadable",
    "storage_unavailable",
    "invalid_settings",
    "timeout",
    "busy",
    "event_overload",
    "command_unconfirmed",
    "cleanup_failed",
  ];
  for (const code of codes) {
    const result = issueFor(new GuardFault(code, "SECRET DIAGNOSTIC"));
    assert.equal(result.code, code);
    assert.equal(result.tone, "error");
    assert.ok(result.message.length < 65 && result.hint.length < 80);
    assert.doesNotMatch(JSON.stringify(result), /SECRET/);
  }
});
test("new or unsupported backend codes fall back to unknown", () => {
  for (const code of [
    "new_future_error",
    "__proto__",
    "constructor",
    123,
    null,
  ])
    assert.equal(issueCode(code), "unknown");
  assert.throws(
    () =>
      unwrap({
        ok: false,
        error_code: "storage_unavailable",
        error: "raw disk failure",
      }),
    (error) =>
      error instanceof GuardFault &&
      issueFor(error).message === "Couldn’t save settings.",
  );
  assert.throws(
    () =>
      unwrap({ ok: false, error_code: "new_future_error", error: "secret" }),
    (error) =>
      error instanceof GuardFault && issueFor(error).code === "unknown",
  );
  assert.throws(
    () => unwrap(null),
    (error) => error instanceof GuardFault && error.code === "invalid_response",
  );
});
test("effect boundary preserves typed faults and technical cause for logging", async () => {
  const effects = new Effects({
    now: () => 0,
    later: () => () => {},
    report: () => {},
  });
  const cause = new GuardFault("storage_unavailable", new Error("disk full"));
  const result = await effects.run("save", () => {
    throw cause;
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(issueFor(result.error).code, "storage_unavailable");
    assert.equal((result.error as GuardFault).detail.cause, cause);
  }
});
test("known and unknown errors render in red, while waiting is a neutral status", () => {
  for (const code of ["timeout", "unknown", "steam_pending"] as const) {
    let renderer: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        React.createElement(IssueMessage, { issue: issue(code) }),
      );
    });
    const view = renderer!.toJSON();
    assert.equal(
      view.props.role,
      code === "steam_pending" ? "status" : "alert",
    );
    assert.equal(
      view.props.style.color,
      code === "steam_pending" ? undefined : "#ff8b8b",
    );
    act(() => renderer!.unmount());
  }
});

test("unreadable thrown values and future typed codes still use unknown fallback", () => {
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  assert.equal(issueFor(revoked.proxy).code, "unknown");
  assert.equal(issueFor(new GuardFault("future" as IssueCode)).code, "unknown");
});
