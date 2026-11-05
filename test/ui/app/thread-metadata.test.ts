import { describe, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import type { ThreadInfo } from "../../../src/core/threads";
import { createAppStateValue } from "../../../src/ui/context/app-state";
import { visibleSidebarThreads } from "../../../src/ui/app/sidebar-navigation";
import {
  syncThreadStatus,
  threadTitleFromPrompt,
  threadTitleUpdateFromPrompt,
  updateThread,
} from "../../../src/ui/app/thread-metadata";

function thread(overrides: Partial<ThreadInfo> = {}): ThreadInfo {
  return {
    id: "thread-1",
    title: "New thread",
    sessionId: null,
    cwd: "/tmp/relay",
    workspaceKind: "local",
    status: "paused",
    archived: false,
    ...overrides,
  };
}

describe("thread metadata", () => {
  test("summarizes ordinary prompts with existing thread-title behavior", () => {
    expect(threadTitleFromPrompt("  add threads, git branch and worktree support to Relay  ")).toBe(
      "add threads, git branch and workt…",
    );
  });

  test("uses explicit skill invocation intent instead of raw slash prompt text", () => {
    expect(
      threadTitleFromPrompt("/review focus on regressions", { name: "review", userMessage: "focus on regressions" }),
    ).toBe("review — focus on regressions");
  });

  test("uses bare skill invocations as replaceable fallback titles", () => {
    expect(threadTitleFromPrompt("/review", { name: "review" })).toBe("Review session");
    expect(threadTitleUpdateFromPrompt(thread(), "/review", { name: "review" })).toEqual({
      title: "Review session",
      titleQuality: "fallback",
    });
  });

  test("keeps low-signal prompts untitled and strips acknowledgement prefixes from meaningful prompts", () => {
    expect(threadTitleFromPrompt("yes")).toBe("New thread");
    expect(threadTitleFromPrompt("no")).toBe("New thread");
    expect(threadTitleFromPrompt("no, use first prompt")).toBe("no, use first prompt");
  });

  test("allows meaningful prompts to replace fallback titles", () => {
    expect(
      threadTitleUpdateFromPrompt(
        thread({ title: "Review session", titleQuality: "fallback" }),
        "focus on regressions",
      ),
    ).toEqual({ title: "focus on regressions", titleQuality: "strong" });
  });

  test("does not replace existing non-default or strong generated titles", () => {
    expect(threadTitleUpdateFromPrompt(thread({ title: "Provider title" }), "focus on regressions")).toBeNull();
    expect(
      threadTitleUpdateFromPrompt(thread({ title: "first real task", titleQuality: "strong" }), "second task"),
    ).toBeNull();
  });

  test("clears generated title quality when an external title update replaces the title", () => {
    createRoot((dispose) => {
      const app = createAppStateValue("/tmp/relay");
      const existing = thread({ title: "Review session", titleQuality: "fallback" });
      app.setState("threads", [existing]);
      app.setState("activeThreadId", existing.id);

      updateThread(app, existing.id, { title: "Provider title" });

      expect(app.state.threads[0]).toMatchObject({ title: "Provider title" });
      expect(app.state.threads[0].titleQuality).toBeUndefined();
      dispose();
    });
  });

  test("can include inactive draft threads for expanded sidebar navigation", () => {
    const draft = thread({ id: "draft", title: "New thread", updatedAt: "2026-07-02T00:00:00.000Z" });
    const active = thread({ id: "active", title: "Active thread", updatedAt: "2026-07-03T00:00:00.000Z" });

    expect(visibleSidebarThreads([draft, active], "active").map((item) => item.id)).toEqual(["active"]);
    expect(
      visibleSidebarThreads([draft, active], "active", { includeDefaultDrafts: true }).map((item) => item.id),
    ).toEqual(["active", "draft"]);
  });

  test("does not touch recency for status-only updates unless requested", () => {
    createRoot((dispose) => {
      const app = createAppStateValue("/tmp/relay");
      const existing = thread({ title: "Older thread", updatedAt: "2026-07-01T00:00:00.000Z" });
      app.setState("threads", [existing]);

      const newer = thread({
        id: "thread-2",
        title: "Newer thread",
        updatedAt: "2026-07-02T00:00:00.000Z",
      });
      app.setState("threads", (threads) => [...threads, newer]);

      syncThreadStatus(app, existing.id, "running");
      expect(app.state.threads[0].updatedAt).toBe("2026-07-01T00:00:00.000Z");
      expect(visibleSidebarThreads(app.state.threads).map((item) => item.id)).toEqual(["thread-2", "thread-1"]);

      syncThreadStatus(app, existing.id, "paused", { touch: true });
      expect(app.state.threads[0].updatedAt).not.toBe("2026-07-01T00:00:00.000Z");
      dispose();
    });
  });

  test("compacts filesystem skill prompt titles instead of persisting frontmatter", () => {
    const prompt = [
      "---",
      "name: review",
      "description: Review changes",
      "register_cmd: true",
      "---",
      "# Review",
      "ARGUMENTS: focus on regressions",
    ].join("\n");

    expect(threadTitleFromPrompt(prompt)).toBe("review — focus on regressions");
  });
});
