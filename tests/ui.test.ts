import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { create, act } from "react-test-renderer";
import { ErrorBoundary } from "../src/ErrorBoundary";

test("React render crash renders a plain fallback and faults the supervisor", () => {
  let fault: unknown = null;
  const original = console.error;
  console.error = () => {};
  try {
    function Broken(): never {
      throw new Error("render failed");
    }
    let renderer: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        React.createElement(ErrorBoundary, {
          onError: (error) => {
            fault = error;
          },
          children: React.createElement(Broken),
        }),
      );
    });
    assert.match(String(fault), /render failed/);
    assert.equal(
      renderer!.root.findByProps({ role: "alert" }).props.style.color,
      "#ff8b8b",
    );
    assert.match(
      JSON.stringify(renderer!.toJSON()),
      /Automatic protection is stopped/,
    );
    assert.match(
      JSON.stringify(renderer!.toJSON()),
      /An unknown error occurred/,
    );
    assert.doesNotMatch(JSON.stringify(renderer!.toJSON()), /render failed/);
    act(() => renderer!.unmount());
  } finally {
    console.error = original;
  }
});
