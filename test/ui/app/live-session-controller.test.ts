import { describe, expect, test } from "bun:test";
import type { AcpClient } from "../../../src/acp/client";
import { createLiveSessionController } from "../../../src/ui/app/live-session-controller";
import { store } from "../../../src/ui/app/runtime-store";
import { createAppStateValue } from "../../../src/ui/context/app-state";
import { LIVE_SESSION_CONTINUATION_ACKNOWLEDGEMENT } from "../../../src/core/live-sessions";
import type { ThreadInfo } from "../../../src/core/threads";

function parentThread(status: ThreadInfo["status"] = "paused"): ThreadInfo {
  return {
    id: "parent-thread",
    relaySessionId: "rs_parent",
    relaySessionName: "build-beacon",
    title: "Parent",
    sessionId: "acp-parent",
    cwd: "/tmp/project",
    workspaceKind: "local",
    status,
    archived: false,
  };
}

function request(
  method:
    | "session.list"
    | "session.inspect"
    | "session.message"
    | "session.createChild"
    | "session.wait"
    | "session.cancel",
  params?: Record<string, unknown>,
) {
  return { version: 1 as const, requestId: "request-1", token: "token", method, params };
}

describe("live session controller", () => {
  test("creates a child with native metadata while allowing a stale persisted name", async () => {
    store.liveSessionInstanceId = "ri_test";
    const app = createAppStateValue("/tmp/project");
    const staleChild: ThreadInfo = {
      ...parentThread(),
      id: "stale-child",
      relaySessionId: "rs_stale",
      relaySessionName: "auth-review",
      sessionId: "acp-stale",
      parentThreadId: "old-parent",
      relationKind: "child",
    };
    app.setState("threads", [parentThread("running"), staleChild]);
    app.setState("activeThreadId", "parent-thread");
    const submissions: Array<{ text: string; threadId?: string }> = [];
    const controller = createLiveSessionController({
      app,
      agentName: () => "test-agent",
      createThread: async (_app, _worktree, options) => {
        const child: ThreadInfo = {
          id: "child-thread",
          relaySessionId: "rs_child",
          relaySessionName: options?.relaySessionName,
          title: options?.title ?? "Child",
          sessionId: null,
          parentThreadId: options?.parentThreadId,
          relationKind: options?.relationKind,
          relationGoal: options?.relationGoal,
          childTaskStatus: "starting",
          cwd: options?.cwd ?? "/tmp/project",
          workspaceKind: "local",
          status: "paused",
          archived: false,
        };
        app.setState("threads", (threads) => [...threads, child]);
        return child;
      },
      ensureThreadSession: async (_app, thread) => {
        const sessionId = `acp-${thread.id}`;
        _app.setState("threads", (candidate) => candidate.id === thread.id, "sessionId", sessionId);
        return { client: { sessionId } as unknown as AcpClient };
      },
      submitPromptToAgent: async (text, _app, _placement, options) => {
        submissions.push({
          text,
          threadId: options?.targetThreadId,
        });
      },
      threadClient: (threadId) =>
        threadId === "parent-thread" ? ({ sessionId: "acp-parent" } as unknown as AcpClient) : null,
      threadUiAdapter: () => ({ state: { blocks: [] }, addBlock: () => undefined }),
    });

    const response = await controller.handleRequest(
      request("session.createChild", {
        parentSessionId: "rs_parent",
        task: "Review authentication",
        name: "Auth review",
      }),
    );

    expect(response).toMatchObject({ ok: true, result: { session: { role: "child" } } });
    expect(app.state.threads[2]).toMatchObject({
      relaySessionId: "rs_child",
      relaySessionName: "auth-review",
      parentThreadId: "parent-thread",
      relationKind: "child",
      relationGoal: "Review authentication",
      relationParentSessionId: "acp-parent",
      relationChildSessionId: "acp-child-thread",
    });
    expect(submissions).toEqual([
      {
        text: "Review authentication",
        threadId: "child-thread",
      },
    ]);
    expect(app.state.threads[0]?.status).toBe("running");
  });

  test("rejects nested creation and a child requester targeting its parent", async () => {
    store.liveSessionInstanceId = "ri_test";
    const app = createAppStateValue("/tmp/project");
    const parent = parentThread();
    const child: ThreadInfo = {
      ...parentThread(),
      id: "child-thread",
      relaySessionId: "rs_child",
      relaySessionName: "review-otter",
      sessionId: "acp-child",
      parentThreadId: parent.id,
      relationKind: "child",
    };
    app.setState("threads", [parent, child]);
    const client = { sessionId: "acp-test" } as unknown as AcpClient;
    const controller = createLiveSessionController({
      app,
      agentName: () => "test-agent",
      createThread: async () => {
        throw new Error("createThread should not be called");
      },
      ensureThreadSession: async () => ({ client }),
      submitPromptToAgent: async () => undefined,
      threadClient: () => client,
      threadUiAdapter: () => ({ state: { blocks: [] }, addBlock: () => undefined }),
    });

    const nested = await controller.handleRequest(
      request("session.createChild", {
        parentSessionId: child.relaySessionId,
        task: "Create a grandchild",
        name: "nested-raven",
      }),
    );
    expect(nested).toMatchObject({
      ok: false,
      error: { code: "child_start_failed", message: "Child session review-otter cannot create sessions" },
    });

    const sibling = await controller.handleRequest(
      request("session.createChild", {
        parentSessionId: parent.relaySessionId,
        requesterSessionId: child.relaySessionId,
        requesterSessionName: child.relaySessionName,
        task: "Create a sibling through the parent",
        name: "sibling-raven",
      }),
    );
    expect(sibling).toMatchObject({ ok: false, error: { code: "child_creation_forbidden" } });
  });

  test("rejects child creation when the parent is at capacity", async () => {
    store.liveSessionInstanceId = "ri_test";
    const app = createAppStateValue("/tmp/project");
    const parent = parentThread();
    const children: ThreadInfo[] = ["one", "two", "three"].map((suffix) => ({
      ...parentThread("running"),
      id: `child-${suffix}`,
      relaySessionId: `rs_child_${suffix}`,
      relaySessionName: `review-${suffix}`,
      sessionId: `acp-child-${suffix}`,
      parentThreadId: parent.id,
      relationKind: "child",
      childTaskStatus: "running",
    }));
    app.setState("threads", [parent, ...children]);
    const client = { sessionId: "acp-test" } as unknown as AcpClient;
    const controller = createLiveSessionController({
      app,
      agentName: () => "test-agent",
      createThread: async () => {
        throw new Error("createThread should not be called");
      },
      ensureThreadSession: async () => ({ client }),
      submitPromptToAgent: async () => undefined,
      threadClient: () => client,
      threadUiAdapter: () => ({ state: { blocks: [] }, addBlock: () => undefined }),
    });

    const response = await controller.handleRequest(
      request("session.createChild", {
        parentSessionId: parent.relaySessionId,
        requesterSessionId: parent.relaySessionId,
        task: "Another task",
        name: "extra-raven",
      }),
    );

    expect(response).toMatchObject({
      ok: false,
      error: { code: "child_start_failed", message: expect.stringContaining("already has 3 active children") },
    });
  });

  test("starts three children concurrently without double-counting pending threads", async () => {
    store.liveSessionInstanceId = "ri_test";
    const app = createAppStateValue("/tmp/project");
    const parent = parentThread("running");
    app.setState("threads", [parent]);
    const client = { sessionId: "acp-test" } as unknown as AcpClient;
    let createdCount = 0;
    let releaseStarts: () => void = () => undefined;
    const startsReleased = new Promise<void>((resolve) => {
      releaseStarts = resolve;
    });
    const controller = createLiveSessionController({
      app,
      agentName: () => "test-agent",
      createThread: async (_app, _worktree, options) => {
        createdCount += 1;
        const child: ThreadInfo = {
          ...parentThread("paused"),
          id: `child-${createdCount}`,
          relaySessionId: `rs_child_${createdCount}`,
          relaySessionName: options?.relaySessionName,
          sessionId: null,
          parentThreadId: options?.parentThreadId,
          relationKind: "child",
          relationGoal: options?.relationGoal,
          childTaskStatus: "starting",
        };
        app.setState("threads", (threads) => [...threads, child]);
        await startsReleased;
        return child;
      },
      ensureThreadSession: async (_app, thread) => {
        const sessionId = `acp-${thread.id}`;
        _app.setState("threads", (candidate) => candidate.id === thread.id, "sessionId", sessionId);
        return { client: { sessionId } as unknown as AcpClient };
      },
      submitPromptToAgent: async () => undefined,
      threadClient: () => client,
      threadUiAdapter: () => ({ state: { blocks: [] }, addBlock: () => undefined }),
    });

    const starts = ["review-runtime", "review-tests", "review-docs"].map((name) =>
      controller.handleRequest(
        request("session.createChild", {
          parentSessionId: parent.relaySessionId,
          requesterSessionId: parent.relaySessionId,
          task: `Run ${name}`,
          name,
        }),
      ),
    );
    await Bun.sleep(0);
    const countBeforeRelease = createdCount;
    releaseStarts();
    const responses = await Promise.all(starts);

    expect(countBeforeRelease).toBe(3);
    expect(responses.every((response) => response.ok)).toBe(true);
    expect(app.state.threads.filter((thread) => thread.parentThreadId === parent.id)).toHaveLength(3);
  });

  test("applies child model and thinking level before submitting its task", async () => {
    store.liveSessionInstanceId = "ri_test";
    const app = createAppStateValue("/tmp/project");
    app.setState("threads", [parentThread()]);
    const events: string[] = [];
    const client = {
      sessionId: "acp-child",
      setSessionModel: async (model: string) => {
        events.push(`model:${model}`);
        return {
          configOptions: [
            { id: "model", category: "model", type: "select", currentValue: model, options: [{ value: model }] },
            {
              id: "thought_level",
              category: "thought_level",
              type: "select",
              currentValue: "medium",
              options: [{ value: "medium" }, { value: "high" }],
            },
          ],
        };
      },
      setSessionThinkingLevel: async (level: string) => {
        events.push(`thinking:${level}`);
        return {};
      },
    } as unknown as AcpClient;
    const controller = createLiveSessionController({
      app,
      agentName: () => "test-agent",
      createThread: async (_app, _worktree, options) => {
        const child: ThreadInfo = {
          ...parentThread(),
          id: "child-thread",
          relaySessionId: "rs_child",
          relaySessionName: options?.relaySessionName,
          sessionId: null,
          parentThreadId: options?.parentThreadId,
          childTaskType: options?.childTaskType,
          modelId: options?.modelId,
          thinkingLevel: options?.thinkingLevel,
        };
        app.setState("threads", (threads) => [...threads, child]);
        return child;
      },
      ensureThreadSession: async () => ({
        client,
        result: {
          configOptions: [
            {
              id: "model",
              category: "model",
              type: "select",
              currentValue: "model-default",
              options: [{ value: "model-a" }],
            },
          ],
        },
      }),
      submitPromptToAgent: async () => {
        events.push("prompt");
      },
      threadClient: () => client,
      threadUiAdapter: () => ({ state: { blocks: [] }, addBlock: () => undefined }),
    });

    const response = await controller.handleRequest(
      request("session.createChild", {
        parentSessionId: "rs_parent",
        task: "Plan the migration",
        name: "plan-otter",
        taskType: "plan",
        model: "model-a",
        thinkingLevel: "high",
      }),
    );

    expect(response).toMatchObject({
      ok: true,
      result: { session: { taskType: "plan", model: "model-a", thinkingLevel: "high" } },
    });
    expect(events).toEqual(["model:model-a", "thinking:high", "prompt"]);
  });

  test("appends sanitized parent history to the child opening prompt", async () => {
    store.liveSessionInstanceId = "ri_test";
    const app = createAppStateValue("/tmp/project");
    app.setState("threads", [parentThread("running")]);
    app.setState("activeThreadId", "parent-thread");
    const parentBlocks = [
      { type: "user" as const, id: "user", content: "Investigate cancellation", delivery: "turn" as const },
      { type: "thinking" as const, id: "thinking", content: "private reasoning", finalized: true },
    ];
    app.setState("blocks", parentBlocks);
    const submissions: string[] = [];
    const controller = createLiveSessionController({
      app,
      agentName: () => "test-agent",
      createThread: async (_app, _worktree, options) => {
        const child: ThreadInfo = {
          ...parentThread(),
          id: "child-thread",
          relaySessionId: "rs_child",
          relaySessionName: options?.relaySessionName,
          sessionId: null,
          parentThreadId: options?.parentThreadId,
          relationKind: "child",
        };
        app.setState("threads", (threads) => [...threads, child]);
        return child;
      },
      ensureThreadSession: async () => ({ client: { sessionId: "acp-child" } as unknown as AcpClient }),
      submitPromptToAgent: async (text) => {
        submissions.push(text);
      },
      threadClient: () => ({ sessionId: "acp-parent" }) as unknown as AcpClient,
      threadUiAdapter: () => ({ state: { blocks: parentBlocks }, addBlock: () => undefined }),
    });

    const response = await controller.handleRequest(
      request("session.createChild", {
        parentSessionId: "rs_parent",
        task: "Implement the fix",
        name: "fix-raven",
        history: { mode: "recent", turns: 1 },
      }),
    );

    expect(response.ok).toBe(true);
    expect(submissions).toHaveLength(1);
    expect(submissions[0]?.startsWith("Implement the fix\n\n<parent_session_context")).toBe(true);
    expect(submissions[0]).toContain("Investigate cancellation");
    expect(submissions[0]).not.toContain("private reasoning");
  });

  test("lets a parent inspect sanitized recent turns from its direct child", async () => {
    store.liveSessionInstanceId = "ri_test";
    const app = createAppStateValue("/tmp/project");
    const parent = parentThread();
    const child: ThreadInfo = {
      ...parentThread(),
      id: "child-thread",
      relaySessionId: "rs_child",
      relaySessionName: "review-otter",
      title: "Child",
      sessionId: "acp-child",
      parentThreadId: "parent-thread",
      relationKind: "child",
      childTaskStatus: "running",
    };
    app.setState("threads", [parent, child]);
    const childBlocks = [
      { type: "user" as const, id: "user-one", content: "First child task", delivery: "turn" as const },
      { type: "content" as const, id: "answer-one", content: "First result", finalized: true },
      { type: "user" as const, id: "user-two", content: "Second child task", delivery: "turn" as const },
      { type: "thinking" as const, id: "thinking", content: "private child reasoning", finalized: true },
      {
        type: "user" as const,
        id: "guidance",
        content: "Check malformed input",
        delivery: "current-turn-guidance" as const,
      },
      { type: "content" as const, id: "answer-two", content: "Second result", finalized: true },
    ];
    const client = { sessionId: "acp-test" } as unknown as AcpClient;
    const controller = createLiveSessionController({
      app,
      agentName: () => "test-agent",
      createThread: async () => child,
      ensureThreadSession: async () => ({ client }),
      submitPromptToAgent: async () => undefined,
      threadClient: () => client,
      threadUiAdapter: (_app, threadId) => ({
        state: { blocks: threadId === child.id ? childBlocks : [] },
        addBlock: () => undefined,
      }),
    });

    const response = await controller.handleRequest(
      request("session.inspect", {
        targetSessionId: "rs_child",
        requesterSessionId: "rs_parent",
        history: { mode: "recent", turns: 1 },
      }),
    );

    expect(response).toMatchObject({
      ok: true,
      result: {
        session: { name: "review-otter", taskState: "running" },
        history: "recent:1",
        turns: [{ user: "Second child task", updates: ["Check malformed input"], assistant: "Second result" }],
      },
    });
    expect(JSON.stringify(response)).not.toContain("private child reasoning");

    const forbidden = await controller.handleRequest(
      request("session.inspect", {
        targetSessionId: "rs_parent",
        requesterSessionId: "rs_child",
        history: { mode: "recent", turns: 1 },
      }),
    );
    expect(forbidden).toMatchObject({ ok: false, error: { code: "inspection_forbidden" } });
  });

  test("delivers a message as ACP active-turn steering when supported", async () => {
    store.liveSessionInstanceId = "ri_test";
    const app = createAppStateValue("/tmp/project");
    const parent = parentThread("running");
    const child: ThreadInfo = {
      ...parentThread(),
      id: "child-thread",
      relaySessionId: "rs_child",
      relaySessionName: "review-otter",
      title: "Child",
      sessionId: "acp-child",
      parentThreadId: "parent-thread",
      relationKind: "child",
    };
    app.setState("threads", [parent, child]);
    app.setState("activeThreadId", "parent-thread");
    const guidance: string[] = [];
    const echoed: string[] = [];
    const client = {
      sessionId: "acp-parent",
      supportsActiveTurnInput: () => true,
      sendActiveTurnInput: async (text: string) => {
        guidance.push(text);
        return { accepted: true as const };
      },
    } as unknown as AcpClient;
    const controller = createLiveSessionController({
      app,
      agentName: () => "test-agent",
      createThread: async () => parentThread(),
      ensureThreadSession: async () => ({ client }),
      submitPromptToAgent: async () => undefined,
      threadClient: () => client,
      threadUiAdapter: () => ({ state: { blocks: [] }, addBlock: (block) => echoed.push(block.content) }),
    });

    const response = await controller.handleRequest(
      request("session.message", {
        targetSessionId: "rs_parent",
        senderSessionId: "rs_child",
        text: "Check the parser first",
        delivery: "auto",
      }),
    );

    expect(response).toMatchObject({ ok: true, result: { delivery: "steered", targetSessionId: "rs_parent" } });
    expect(guidance).toEqual(["[child: review-otter]\n\nCheck the parser first"]);
    expect(echoed).toEqual(["[child: review-otter]\n\nCheck the parser first"]);
    expect(app.state.threads[0]?.liveSessionMessages).toEqual([
      expect.objectContaining({
        acpSessionId: "acp-parent",
        content: "[child: review-otter]\n\nCheck the parser first",
        delivery: "current-turn-guidance",
      }),
    ]);
  });

  test("rejects messages sent to the sender's own session", async () => {
    store.liveSessionInstanceId = "ri_test";
    const app = createAppStateValue("/tmp/project");
    app.setState("threads", [parentThread()]);
    const client = { sessionId: "acp-parent" } as unknown as AcpClient;
    const controller = createLiveSessionController({
      app,
      agentName: () => "test-agent",
      createThread: async () => parentThread(),
      ensureThreadSession: async () => ({ client }),
      submitPromptToAgent: async () => undefined,
      threadClient: () => client,
      threadUiAdapter: () => ({ state: { blocks: [] }, addBlock: () => undefined }),
    });

    const response = await controller.handleRequest(
      request("session.message", {
        targetSessionId: "rs_parent",
        senderSessionId: "rs_parent",
        text: "Loop this message",
      }),
    );

    expect(response).toEqual({
      version: 1,
      requestId: "request-1",
      ok: false,
      error: {
        code: "self_message_rejected",
        message: "Session build-beacon cannot message itself",
      },
    });
  });

  test("allows parent peers while rejecting child-to-child messages", async () => {
    store.liveSessionInstanceId = "ri_test";
    const app = createAppStateValue("/tmp/project");
    const firstParent = parentThread();
    const secondParent: ThreadInfo = {
      ...parentThread(),
      id: "second-parent-thread",
      relaySessionId: "rs_second_parent",
      relaySessionName: "plan-heron",
      sessionId: "acp-second-parent",
    };
    const firstChild: ThreadInfo = {
      ...parentThread(),
      id: "first-child-thread",
      relaySessionId: "rs_first_child",
      relaySessionName: "review-otter",
      sessionId: "acp-first-child",
      parentThreadId: firstParent.id,
      relationKind: "child",
    };
    const sibling: ThreadInfo = {
      ...firstChild,
      id: "sibling-thread",
      relaySessionId: "rs_sibling",
      relaySessionName: "test-raven",
      sessionId: "acp-sibling",
    };
    app.setState("threads", [firstParent, secondParent, firstChild, sibling]);
    const client = { sessionId: "acp-test" } as unknown as AcpClient;
    const controller = createLiveSessionController({
      app,
      agentName: () => "test-agent",
      createThread: async () => firstChild,
      ensureThreadSession: async () => ({ client }),
      submitPromptToAgent: async () => undefined,
      threadClient: () => client,
      threadUiAdapter: () => ({ state: { blocks: [] }, addBlock: () => undefined }),
    });

    const peer = await controller.handleRequest(
      request("session.message", {
        targetSessionId: "rs_second_parent",
        senderSessionId: "rs_parent",
        text: "Coordinate the rollout",
        delivery: "mailbox",
      }),
    );
    expect(peer).toMatchObject({ ok: true, result: { delivery: "queued" } });
    expect(app.state.threads.find((thread) => thread.id === secondParent.id)?.liveSessionInbox).toEqual([
      expect.objectContaining({
        kind: "message",
        content: "[peer: build-beacon]\n\nCoordinate the rollout",
      }),
    ]);

    const childPeer = await controller.handleRequest(
      request("session.message", {
        targetSessionId: "rs_sibling",
        senderSessionId: "rs_first_child",
        text: "Coordinate directly",
      }),
    );
    expect(childPeer).toMatchObject({ ok: false, error: { code: "message_forbidden" } });
  });

  test("steers child messages into an active parent and wakes its wait inbox", async () => {
    store.liveSessionInstanceId = "ri_test";
    const app = createAppStateValue("/tmp/project");
    const parent = parentThread("running");
    const child: ThreadInfo = {
      ...parentThread("running"),
      id: "child-thread",
      relaySessionId: "rs_child",
      relaySessionName: "review-otter",
      sessionId: "acp-child",
      parentThreadId: parent.id,
      relationKind: "child",
      childTaskStatus: "running",
    };
    app.setState("threads", [parent, child]);
    const activeInputs: string[] = [];
    const parentClient = {
      sessionId: "acp-parent",
      supportsActiveTurnInput: () => true,
      sendActiveTurnInput: async (text: string) => {
        activeInputs.push(text);
        return { accepted: true };
      },
    } as unknown as AcpClient;
    const childInputs: string[] = [];
    const childClient = {
      sessionId: "acp-child",
      supportsActiveTurnInput: () => true,
      sendActiveTurnInput: async (text: string) => {
        childInputs.push(text);
        return { accepted: true };
      },
    } as unknown as AcpClient;
    const controller = createLiveSessionController({
      app,
      agentName: () => "test-agent",
      createThread: async () => child,
      ensureThreadSession: async () => ({ client: childClient }),
      submitPromptToAgent: async () => undefined,
      threadClient: (threadId) => (threadId === parent.id ? parentClient : childClient),
      threadUiAdapter: () => ({ state: { blocks: [] }, addBlock: () => undefined }),
    });

    const message = await controller.handleRequest(
      request("session.message", {
        targetSessionId: parent.relaySessionId,
        senderSessionId: child.relaySessionId,
        text: "Full child report",
        delivery: "mailbox",
      }),
    );
    expect(message).toMatchObject({ ok: true, result: { delivery: "steered" } });
    expect(activeInputs).toEqual(["[child: review-otter]\n\nFull child report"]);

    const guidance = await controller.handleRequest(
      request("session.message", {
        targetSessionId: child.relaySessionId,
        senderSessionId: parent.relaySessionId,
        text: "Prioritize the concise summary",
        delivery: "mailbox",
      }),
    );
    expect(guidance).toMatchObject({ ok: true, result: { delivery: "steered" } });
    expect(childInputs).toEqual(["[parent: build-beacon]\n\nPrioritize the concise summary"]);

    const waited = await controller.handleRequest(
      request("session.wait", {
        requesterSessionId: parent.relaySessionId,
        targetSessionId: child.relaySessionId,
        timeoutMs: 10_000,
      }),
    );
    expect(waited).toMatchObject({
      ok: true,
      result: {
        outcome: "message",
        delivery: "continuation",
        result: LIVE_SESSION_CONTINUATION_ACKNOWLEDGEMENT,
      },
    });
  });

  test("waits for a complete terminal child result and lets only its parent cancel it", async () => {
    store.liveSessionInstanceId = "ri_test";
    const completeResult = `Evidence-backed child result\n\n${"full result ".repeat(40).trim()}`;
    expect(completeResult.length).toBeGreaterThan(200);
    const app = createAppStateValue("/tmp/project");
    const parent = parentThread();
    const child: ThreadInfo = {
      ...parentThread("paused"),
      id: "child-thread",
      relaySessionId: "rs_child",
      relaySessionName: "review-otter",
      sessionId: "acp-child",
      parentThreadId: parent.id,
      relationKind: "child",
      childTaskStatus: "done",
    };
    app.setState("threads", [parent, child]);
    let cancelled = false;
    const published: Array<{ status: string; result: string | undefined }> = [];
    const client = {
      sessionId: "acp-child",
      cancel: async () => {
        cancelled = true;
      },
    } as unknown as AcpClient;
    const controller = createLiveSessionController({
      app,
      agentName: () => "test-agent",
      createThread: async () => child,
      ensureThreadSession: async () => ({ client }),
      submitPromptToAgent: async () => undefined,
      publishChildCompletion: async (_app, _thread, status, result) => {
        published.push({ status, result });
      },
      threadClient: () => client,
      threadUiAdapter: (_app, threadId) => ({
        state: {
          blocks:
            threadId === child.id ? [{ type: "content", id: "answer", content: completeResult, finalized: true }] : [],
        },
        addBlock: () => undefined,
      }),
    });

    const waited = await controller.handleRequest(
      request("session.wait", {
        requesterSessionId: "rs_parent",
        timeoutMs: 10_000,
      }),
    );
    expect(waited).toMatchObject({
      ok: true,
      result: {
        outcome: "terminal",
        result: completeResult,
        delivery: "inline",
        session: { taskState: "done" },
      },
    });

    const repeatedWait = await controller.handleRequest(
      request("session.wait", { requesterSessionId: "rs_parent", timeoutMs: 10_000 }),
    );
    expect(repeatedWait).toMatchObject({ ok: true, result: { outcome: "idle" } });

    app.setState("threads", (thread) => thread.id === child.id, "childTaskStatus", "running");
    app.setState("threads", (thread) => thread.id === child.id, "status", "running");
    const cancelledResponse = await controller.handleRequest(
      request("session.cancel", { targetSessionId: "rs_child", requesterSessionId: "rs_parent" }),
    );
    expect(cancelledResponse).toMatchObject({ ok: true, result: { cancelled: true } });
    expect(cancelled).toBe(true);
    expect(app.state.threads[1]).toMatchObject({ childTaskStatus: "interrupted", status: "paused" });
    expect(published).toEqual([{ status: "interrupted", result: "Child session was interrupted." }]);
  });

  test("prefixes messages passed between parent and child sessions", async () => {
    store.liveSessionInstanceId = "ri_test";
    const app = createAppStateValue("/tmp/project");
    const parent = parentThread();
    const child: ThreadInfo = {
      ...parentThread(),
      id: "child-thread",
      relaySessionId: "rs_child",
      relaySessionName: "review-otter",
      title: "Child",
      sessionId: "acp-child",
      parentThreadId: "parent-thread",
      relationKind: "child",
    };
    app.setState("threads", [parent, child]);
    const submissions: Array<{ text: string; threadId?: string }> = [];
    const client = { sessionId: "acp-test" } as unknown as AcpClient;
    const controller = createLiveSessionController({
      app,
      agentName: () => "test-agent",
      createThread: async () => child,
      ensureThreadSession: async () => ({ client }),
      submitPromptToAgent: async (text, _app, _placement, options) => {
        submissions.push({ text, threadId: options?.targetThreadId });
      },
      threadClient: () => client,
      threadUiAdapter: () => ({ state: { blocks: [] }, addBlock: () => undefined }),
    });

    await controller.handleRequest(
      request("session.message", {
        targetSessionId: "rs_child",
        senderSessionId: "rs_parent",
        text: "Check the parser",
        delivery: "turn",
      }),
    );
    await controller.handleRequest(
      request("session.message", {
        targetSessionId: "rs_parent",
        senderSessionId: "rs_child",
        text: "Parser checked",
        delivery: "turn",
      }),
    );

    expect(submissions).toEqual([
      { text: "[parent: build-beacon]\n\nCheck the parser", threadId: "child-thread" },
      { text: "[child: review-otter]\n\nParser checked", threadId: "parent-thread" },
    ]);
  });
});
