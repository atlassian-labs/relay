import { describe, expect, test } from "bun:test";
import { createEffect, createRoot } from "solid-js";
import { createSessionController } from "../../../src/ui/app/session-controller";
import { createAppStateValue } from "../../../src/ui/context/app-state";
import type { RelaySessionUpdate } from "../../../src/acp/sdk";

function controller() {
  return createSessionController({
    threadAgentCommands: new Map(),
    historyLoadedSessionIdsByThread: new Map(),
    acpClient: () => null,
    activeAgentName: () => "agent",
    agentBehaviorProfile: () => ({}) as never,
    resetSessionUi: () => undefined,
    applyThreadSessionCapabilities: () => undefined,
    refreshOpenSlashAutocomplete: () => undefined,
    showSelectionOverlay: () => undefined,
    hideSelectionOverlay: () => undefined,
    threadUiAdapter: () => undefined,
    setAllowGlobalPromptHistoryContinuation: () => undefined,
    onThreadCwdChange: () => undefined,
  } as never);
}

function historyUpdates(turns: number): RelaySessionUpdate[] {
  return Array.from({ length: turns }, (_, turn) => [
    { sessionUpdate: "user_message_chunk", content: { type: "text", text: `prompt ${turn}` } },
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "a" } },
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "b" } },
    { sessionUpdate: "tool_call", toolCallId: `t${turn}`, title: "bash", kind: "execute", status: "pending" },
    { sessionUpdate: "tool_call_update", toolCallId: `t${turn}`, status: "completed" },
  ]).flat() as RelaySessionUpdate[];
}

describe("replayLoadedSessionUpdates", () => {
  test("runs transcript effects once per replay, not once per update", () => {
    let effectRuns = 0;
    const { app, dispose } = createRoot((dispose) => {
      const app = createAppStateValue("/tmp/project");
      app.setState("activeThreadId", "thread-a");
      createEffect(() => {
        void app.state.blocks.length;
        effectRuns += 1;
      });
      return { app, dispose };
    });
    const before = effectRuns;
    try {
      controller().replayLoadedSessionUpdates(app as never, "thread-a", historyUpdates(50));
      expect(app.state.blocks.length).toBeGreaterThan(100);
      expect(effectRuns - before).toBe(1);
    } finally {
      dispose();
    }
  });
});
