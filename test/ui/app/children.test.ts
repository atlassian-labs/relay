import { describe, expect, test } from "bun:test";
import type { ThreadInfo } from "../../../src/core/threads";
import {
  childListItems,
  childStatusLabel,
  directChildThreads,
  parentThreadForChild,
} from "../../../src/ui/app/children";

function thread(id: string, overrides: Partial<ThreadInfo> = {}): ThreadInfo {
  return {
    id,
    relaySessionId: `rs_${id}`,
    relaySessionName: `review-${id}`,
    title: id,
    sessionId: `acp_${id}`,
    cwd: "/tmp/project",
    workspaceKind: "local",
    status: "paused",
    archived: false,
    ...overrides,
  };
}

describe("child session UI data", () => {
  test("lists only direct visible children with task status and Relay identity", () => {
    const threads = [
      thread("parent"),
      thread("running", {
        parentThreadId: "parent",
        relationGoal: "Review authentication",
        status: "running",
        childTaskStatus: "running",
      }),
      thread("done", {
        parentThreadId: "parent",
        relationGoal: "Update tests",
        childTaskStatus: "done",
      }),
      thread("grandchild", { parentThreadId: "running", childTaskStatus: "starting" }),
      thread("archived", { parentThreadId: "parent", archived: true }),
    ];

    expect(directChildThreads(threads, "parent").map((child) => child.id)).toEqual(["running", "done"]);
    expect(childStatusLabel(threads[1]!)).toBe("running");
    expect(childListItems(threads, "parent").map((item) => item.description)).toEqual([
      "running · review-running · rs_running",
      "done · review-done · rs_done",
    ]);
    expect(parentThreadForChild(threads, "running")?.id).toBe("parent");
    expect(parentThreadForChild(threads, "parent")).toBeUndefined();
  });
});
