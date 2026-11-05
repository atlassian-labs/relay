import { describe, expect, test } from "bun:test";
import { createInitialState } from "../../../src/ui/state";
import { statusLabel } from "../../../src/ui/util/status-label";

function runningState() {
  const state = createInitialState("/tmp/relay-status");
  state.running = true;
  state.spinnerActive = true;
  return state;
}

describe("statusLabel", () => {
  test("running state keeps the generic working label", () => {
    const state = runningState();
    state.elapsedSeconds = 120;
    state.toolCallCount = 3;

    expect(statusLabel(state)).toBe("Working...");
  });

  test("completed turn renders elapsed time and tool count", () => {
    const state = createInitialState("/tmp/relay-status");
    state.elapsedSeconds = 120;
    state.toolCallCount = 3;

    expect(statusLabel(state)).toBe("2m 0s • 3 tool calls");
  });

  test("running state stays generic when ACP activity state changes", () => {
    const state = runningState();

    state.lastAcpActivityKind = "streaming";
    state.lastAcpActivityAt = 1;
    state.elapsedSeconds = 2;
    expect(statusLabel(state)).toBe("Working...");

    state.lastAcpActivityKind = "reasoning";
    expect(statusLabel(state)).toBe("Working...");

    state.lastAcpActivityKind = "tool";
    state.lastAcpActivityLabel = "Bash";
    state.toolCallCount = 1;
    expect(statusLabel(state)).toBe("Working...");

    state.lastAcpActivityKind = "active";
    state.lastAcpActivityLabel = "";
    expect(statusLabel(state)).toBe("Working...");
  });

  test("stale ACP activity keeps the elapsed core label after completion", () => {
    const state = createInitialState("/tmp/relay-status");
    state.lastAcpActivityKind = "reasoning";
    state.lastAcpActivityAt = 0;
    state.elapsedSeconds = 10_000;

    expect(statusLabel(state)).toBe("2h 46m • 0 tool calls");
    expect(statusLabel(state)).not.toContain("no ACP updates");
  });

  test("stale tool activity keeps the elapsed core label after completion", () => {
    const state = createInitialState("/tmp/relay-status");
    state.lastAcpActivityKind = "tool";
    state.lastAcpActivityLabel = "Bash";
    state.lastAcpActivityAt = 0;
    state.elapsedSeconds = 10_000;

    expect(statusLabel(state)).toBe("2h 46m • 0 tool calls");
    expect(statusLabel(state)).not.toContain("no ACP updates");
  });

  test("spinner label overrides the generic busy labels", () => {
    const state = createInitialState("/tmp/relay-status");
    state.connecting = true;
    state.connectingAgentName = "faux";
    state.spinnerLabel = "Loading session: session-123";

    expect(statusLabel(state)).toBe("Loading session: session-123");
  });

  test("connecting status still works", () => {
    const state = createInitialState("/tmp/relay-status");
    state.connecting = true;
    state.connectingAgentName = "faux";

    expect(statusLabel(state)).toBe("Connecting to faux...");
  });
});
