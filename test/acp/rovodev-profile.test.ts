import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { forkRovodevSession, listRovodevSessions } from "../../src/acp/profiles/rovodev";

const tmpRoots: string[] = [];

function tmpRoot(): string {
  const root = path.join(tmpdir(), `relay-rovodev-profile-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(root, { recursive: true });
  tmpRoots.push(root);
  return root;
}

function writeRovodevSession(
  storagePath: string,
  sessionId: string,
  metadata: { title?: string; workspace_path?: string },
): void {
  const sessionPath = path.join(storagePath, "sessions", sessionId);
  mkdirSync(sessionPath, { recursive: true });
  writeFileSync(path.join(sessionPath, "metadata.json"), JSON.stringify(metadata), "utf-8");
  writeFileSync(
    path.join(sessionPath, "session_context.json"),
    JSON.stringify({
      id: sessionId,
      workspace_path: metadata.workspace_path,
      message_history: [{ kind: "request" }, { kind: "response" }],
      prompts: ["stale prompt"],
      initial_prompt: "stale initial prompt",
      deferred_results: { stale: true },
      deps: { artifacts: { "metadata.json": metadata } },
    }),
    "utf-8",
  );
}

afterEach(() => {
  while (tmpRoots.length > 0) rmSync(tmpRoots.pop()!, { recursive: true, force: true });
});

describe("Rovo Dev session-list facade", () => {
  test("reads persisted Rovo sessions and ignores malformed entries", () => {
    const storagePath = tmpRoot();
    writeRovodevSession(storagePath, "session-1", {
      title: "Persisted Rovo session",
      workspace_path: "/workspace/relay",
    });
    writeRovodevSession(storagePath, "other-workspace", {
      title: "Must not appear",
      workspace_path: "/workspace/other",
    });
    const malformedPath = path.join(storagePath, "sessions", "malformed");
    mkdirSync(malformedPath, { recursive: true });
    writeFileSync(path.join(malformedPath, "session_context.json"), "not json", "utf-8");

    const sessions = listRovodevSessions({ cwd: "/workspace/relay", agentEnv: { ROVODEV_USER_DIR: storagePath } });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      sessionId: "session-1",
      title: "Persisted Rovo session",
      cwd: "/workspace/relay",
    });
    expect(Date.parse(sessions[0].updatedAt ?? "")).toBeGreaterThan(0);
  });

  test("creates a loadable full-history fork without mutating the parent", () => {
    const storagePath = tmpRoot();
    const sessionId = "source-session";
    const workspacePath = "/workspace/relay";
    writeRovodevSession(storagePath, sessionId, {
      title: "Source session",
      workspace_path: workspacePath,
    });
    const sourceContextPath = path.join(storagePath, "sessions", sessionId, "session_context.json");
    const sourceBefore = readFileSync(sourceContextPath, "utf-8");

    const result = forkRovodevSession({
      sessionId,
      cwd: workspacePath,
      agentEnv: { ROVODEV_USER_DIR: storagePath },
    });

    expect(result.sessionId).not.toBe(sessionId);
    expect(readFileSync(sourceContextPath, "utf-8")).toBe(sourceBefore);
    const forkPath = path.join(storagePath, "sessions", result.sessionId);
    const forkContext = JSON.parse(readFileSync(path.join(forkPath, "session_context.json"), "utf-8")) as Record<
      string,
      unknown
    >;
    const forkMetadata = JSON.parse(readFileSync(path.join(forkPath, "metadata.json"), "utf-8")) as Record<
      string,
      unknown
    >;
    expect(forkContext).toMatchObject({
      id: result.sessionId,
      message_history: [{ kind: "request" }, { kind: "response" }],
      prompts: [],
      initial_prompt: "",
      deferred_results: null,
      deps: { artifacts: { "metadata.json": forkMetadata } },
    });
    expect(forkMetadata).toMatchObject({
      title: "Fork of Source session",
      workspace_path: workspacePath,
      is_manual_title: false,
      fork_data: { parent_session_id: sessionId, fork_point: 2 },
    });
  });
});
