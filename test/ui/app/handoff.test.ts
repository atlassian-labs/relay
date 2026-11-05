import { describe, expect, test } from "bun:test";
import type { AcpClient } from "../../../src/acp/client";
import type { CreateChildSessionInput } from "../../../src/core/live-sessions";
import type { ThreadInfo } from "../../../src/core/threads";
import { createHandoffController, type HandoffControllerDeps } from "../../../src/ui/app/handoff";
import { createAppStateValue } from "../../../src/ui/context/app-state";

function parentThread(): ThreadInfo {
  return {
    id: "parent-thread",
    relaySessionId: "rs_parent",
    title: "Parent",
    sessionId: "acp-parent",
    cwd: process.cwd(),
    workspaceKind: "local",
    status: "paused",
    archived: false,
  };
}

function commandContext(running = false) {
  return {
    cwd: process.cwd(),
    sessionId: "acp-parent",
    threadId: "parent-thread",
    userMessageCount: 1,
    running,
    waitForIdle: () => Promise.resolve(),
    toast: () => undefined,
  };
}

function mockClient(): AcpClient {
  return {
    sessionId: "acp-parent",
    supportsSessionFork: () => true,
    supportsSessionDelete: () => true,
    supportsSessionClose: () => false,
    forkSession: async () => ({ sessionId: "scratch-session" }),
    deleteSession: async () => undefined,
  } as unknown as AcpClient;
}

function setup() {
  const app = createAppStateValue(process.cwd());
  app.setState("threads", [parentThread()]);
  app.setState("activeThreadId", "parent-thread");
  const created: CreateChildSessionInput[] = [];
  const statuses: string[] = [];
  const deps: HandoffControllerDeps = {
    showToast: () => undefined,
    setNativeStatus: (_key, value) => statuses.push(value?.text ?? "cleared"),
    ensureThreadSession: async () => ({ client: mockClient() }),
    runHiddenPrompt: async () => "Task: continue in the child",
    createChildSession: async (input) => {
      created.push(input);
      return {
        ...parentThread(),
        id: "child-thread",
        relaySessionId: "rs_child",
        title: "Child",
        sessionId: "acp-child",
        parentThreadId: "parent-thread",
        relationKind: "handoff",
      };
    },
  };
  return { app, created, statuses, controller: createHandoffController(deps) };
}

describe("native handoff", () => {
  test("creates a handoff through the shared child-session primitive", async () => {
    const { app, created, statuses, controller } = setup();

    await controller.runCommand(app, "continue in child", commandContext());

    expect(created).toEqual([
      {
        parentSessionId: "rs_parent",
        task: "continue in child",
        openingPrompt: "Task: continue in the child",
        relation: "handoff",
      },
    ]);
    expect(statuses).toEqual(["Creating handoff...", "cleared"]);
  });

  test("does not summarize a handoff while the parent turn is running", async () => {
    const { app, created, controller } = setup();

    await controller.runCommand(app, "continue in child", commandContext(true));

    expect(created).toEqual([]);
    expect(app.state.blocks.at(-1)).toMatchObject({ type: "info", variant: "warning" });
  });
});
