import { describe, expect, test } from "bun:test";
import { resolveAgentBehaviorProfile } from "../../../src/acp/agent-profile";
import type { AcpSessionInfo } from "../../../src/acp/client";
import { altaSessionListPolicy } from "../../../src/acp/profiles/alta";
import {
  filterInternalSessions,
  hierarchicalSessionSelectionItems,
  isInternalSessionTitle,
  resumableSessionSelectionItems,
  resumableSessions,
} from "../../../src/ui/app/session-list";
import { filterListItems } from "../../../src/ui/app/overlay-filter";

const session = (sessionId: string, title: string, updatedAt?: string | null): AcpSessionInfo => ({
  sessionId,
  title,
  updatedAt,
  cwd: "/tmp/project",
});

describe("session list filtering", () => {
  test("filters Alta cache path titles", () => {
    const sessions = [
      session("real", "real user prompt", "2026-01-01T00:00:00.000Z"),
      session("cache", "/Users/me/.alta/cache/agents/agent.yml", null),
    ];

    expect(filterInternalSessions(sessions, altaSessionListPolicy).map((item) => item.sessionId)).toEqual(["real"]);
  });

  test("keeps provider-looking titles when no session-list policy is supplied", () => {
    const sessions = [
      session("cache-looking", "/Users/me/.cache/alta/agents/agent.yml", null),
      session("timestamped-yaml", "/Users/me/agents/dev-agent.yml", "2026-01-01T00:00:00.000Z"),
    ];

    expect(filterInternalSessions(sessions).map((item) => item.sessionId)).toEqual([
      "cache-looking",
      "timestamped-yaml",
    ]);
  });

  test("keeps provider-looking titles when default profile is active", () => {
    const sessions = [
      session("cache-looking", "/Users/me/.cache/alta/agents/agent.yml", null),
      session("timestamped-yaml", "/Users/me/agents/dev-agent.yml", "2026-01-01T00:00:00.000Z"),
    ];

    expect(
      filterInternalSessions(sessions, resolveAgentBehaviorProfile("default").sessionListPolicy).map(
        (item) => item.sessionId,
      ),
    ).toEqual(["cache-looking", "timestamped-yaml"]);
  });

  test("keeps provider-looking titles for unknown profiles", () => {
    const sessions = [
      session("cache-looking", "/Users/me/.cache/alta/agents/agent.yml", null),
      session("timestamped-yaml", "/Users/me/agents/dev-agent.yml", "2026-01-01T00:00:00.000Z"),
    ];

    expect(
      filterInternalSessions(sessions, resolveAgentBehaviorProfile("custom-agent").sessionListPolicy).map(
        (item) => item.sessionId,
      ),
    ).toEqual(["cache-looking", "timestamped-yaml"]);
  });

  test("filters actual Alta package-cache agent.yml fallback titles even when timestamped", () => {
    const sessions = [
      session("real", "which repo are you in", "2026-01-01T00:00:00.000Z"),
      session(
        "cache",
        "/Users/me/.cache/alta/agents/axiom-example@2026.26.2522/node_modules/@atlassian/alta-agent-axiom-example/agent.yml",
        "2026-06-28T03:53:31.000Z",
      ),
    ];

    expect(filterInternalSessions(sessions, altaSessionListPolicy).map((item) => item.sessionId)).toEqual(["real"]);
  });

  test("filters configured Alta agent fallback titles before sorting resume sessions", () => {
    const sessions = [
      session("real", "which repo are you in", "2026-01-01T00:00:00.000Z"),
      session("dummy", "axiom-example", "2026-06-28T03:53:31.000Z"),
    ];
    const policy = resolveAgentBehaviorProfile("alta", {
      internalSessionTitleAliases: ["axiom-example"],
    }).sessionListPolicy;

    expect(resumableSessions(sessions, policy).map((item) => item.sessionId)).toEqual(["real"]);
  });

  test("keeps bare slug titles when the Alta runner did not configure that alias", () => {
    const sessions = [
      session("real", "which repo are you in", "2026-01-01T00:00:00.000Z"),
      session("slug", "project-cleanup", "2026-06-28T03:53:31.000Z"),
    ];

    expect(resumableSessions(sessions, altaSessionListPolicy).map((item) => item.sessionId)).toEqual(["slug", "real"]);
  });

  test("filters untitled Alta path-agent sessions with YAML fallback titles", () => {
    const sessions = [
      session("real", "which repo are you in", "2026-01-01T00:00:00.000Z"),
      session("yaml", "/Users/me/agents/dev-agent.yml", null),
      session("yaml-uppercase", "/Users/me/agents/dev-agent.YAML", undefined),
    ];

    expect(filterInternalSessions(sessions, altaSessionListPolicy).map((item) => item.sessionId)).toEqual(["real"]);
  });

  test("keeps path-looking user prompt titles and timestamped YAML titles outside Alta cache", () => {
    const sessions = [
      session("slash-command", "/directories add /Users/me/project", "2026-01-01T00:00:00.000Z"),
      session("timestamped-yaml", "/Users/me/agents/dev-agent.yml", "2026-01-01T00:00:00.000Z"),
    ];

    expect(filterInternalSessions(sessions, altaSessionListPolicy).map((item) => item.sessionId)).toEqual([
      "slash-command",
      "timestamped-yaml",
    ]);
  });

  test("filters Alta source-only path-agent sessions with timestamped YAML fallback titles", () => {
    const agentPath = "/Users/me/agents/dev-agent.yml";
    const sessions: AcpSessionInfo[] = [
      session("real", "which repo are you in", "2026-01-01T00:00:00.000Z"),
      {
        sessionId: "source-only",
        title: agentPath,
        updatedAt: "2026-01-02T00:00:00.000Z",
        cwd: "/tmp/project",
        _meta: {
          altaSourceStatus: "known",
          altaAgentSource: { kind: "path", path: agentPath },
        },
      },
      {
        sessionId: "prompt-backed",
        title: agentPath,
        updatedAt: "2026-01-03T00:00:00.000Z",
        cwd: "/tmp/project",
        _meta: {
          altaSourceStatus: "known",
          altaAgentSource: { kind: "path", path: agentPath },
          altaTitleSource: "first_prompt",
        },
      },
    ];

    expect(filterInternalSessions(sessions, altaSessionListPolicy).map((item) => item.sessionId)).toEqual([
      "real",
      "prompt-backed",
    ]);
  });

  test("filters Alta source-only path-agent sessions that include list metadata", () => {
    const agentPath = "/Users/me/agents/dev-agent.yml";
    const sessions: AcpSessionInfo[] = [
      session("real", "which repo are you in", "2026-01-01T00:00:00.000Z"),
      {
        sessionId: "source-only-with-list-meta",
        title: agentPath,
        updatedAt: "2026-01-02T00:00:00.000Z",
        cwd: "/tmp/project",
        _meta: {
          altaSourceStatus: "known",
          altaAgentSource: { kind: "path", path: agentPath },
          "alta/session-list": { cwdExists: true, workspaceScope: "current-cwd" },
        },
      },
    ];

    expect(filterInternalSessions(sessions, altaSessionListPolicy).map((item) => item.sessionId)).toEqual(["real"]);
  });

  test("uses Alta prompt preview as the resume title for path-agent fallback titles", () => {
    const agentPath = "/Users/me/agents/dev-agent.yml";
    const items = resumableSessionSelectionItems(
      [
        {
          sessionId: "prompt-backed-path",
          title: agentPath,
          updatedAt: "2026-01-02T00:00:00.000Z",
          cwd: "/tmp/project",
          _meta: {
            altaSourceStatus: "known",
            altaAgentSource: { kind: "path", path: agentPath },
            altaFirstUserPromptPreview: "explain the repo layout",
            altaLastUserPromptPreview: "follow-up",
            "alta/session-list": { cwdExists: true, workspaceScope: "current-cwd" },
          },
        },
      ],
      null,
      altaSessionListPolicy,
    );

    expect(items).toHaveLength(1);
    expect(items[0]?.label).toBe("explain the repo layout");
    expect(items[0]?.value.title).toBe("explain the repo layout");
  });

  test("does not mutate Alta sessions when normalizing path-agent fallback titles", () => {
    const agentPath = "/Users/me/agents/dev-agent.yml";
    const sessions: AcpSessionInfo[] = [
      {
        sessionId: "prompt-backed-path",
        title: agentPath,
        updatedAt: "2026-01-02T00:00:00.000Z",
        cwd: "/tmp/project",
        _meta: {
          altaSourceStatus: "known",
          altaAgentSource: { kind: "path", path: agentPath },
          altaFirstUserPromptPreview: "explain the repo layout",
          "alta/session-list": { cwdExists: true, workspaceScope: "current-cwd" },
        },
      },
    ];

    expect(resumableSessions(sessions, altaSessionListPolicy)[0]?.title).toBe("explain the repo layout");
    expect(sessions[0]?.title).toBe(agentPath);
  });

  test("filters non-current Alta workspace sessions from resume lists", () => {
    const sessions: AcpSessionInfo[] = [
      {
        ...session("current", "Current checkout", "2026-01-03T00:00:00.000Z"),
        _meta: { "alta/session-list": { workspaceScope: "current-cwd", cwdExists: true } },
      },
      {
        ...session("same-project", "Same project checkout", "2026-01-04T00:00:00.000Z"),
        cwd: "/tmp/other-checkout",
        _meta: { "alta/session-list": { workspaceScope: "same-project", cwdExists: true } },
      },
      {
        ...session("missing", "Missing checkout", "2026-01-05T00:00:00.000Z"),
        cwd: "/tmp/missing-checkout",
        _meta: { "alta/session-list": { workspaceScope: "same-project", cwdExists: false } },
      },
      {
        ...session("unknown-scope", "Future checkout", "2026-01-06T00:00:00.000Z"),
        cwd: "/tmp/future-checkout",
        _meta: { "alta/session-list": { workspaceScope: "future-scope", cwdExists: true } },
      },
    ];

    expect(resumableSessions(sessions, altaSessionListPolicy).map((item) => item.sessionId)).toEqual(["current"]);
  });

  test("filters internal-title sessions from resume lists", () => {
    const cachePath = "/Users/me/.cache/alta/agents/axiom@1.0.0/node_modules/@atlassian/alta-agent-axiom/agent.yml";
    const sessions = [
      session("older", "Older real", "2026-01-01T00:00:00.000Z"),
      session("cache", cachePath, "2026-01-03T00:00:00.000Z"),
      session("newer", "Newer real", "2026-01-02T00:00:00.000Z"),
    ];

    expect(filterInternalSessions(sessions, altaSessionListPolicy).map((item) => item.sessionId)).toEqual([
      "older",
      "newer",
    ]);

    const resumable = resumableSessions(sessions, altaSessionListPolicy);

    expect(resumable.map((item) => item.sessionId)).toEqual(["newer", "older"]);
    expect(sessions[1]?.title).toBe(cachePath);
  });

  test("keeps missing-title sessions resumable", () => {
    const sessions: AcpSessionInfo[] = [
      { sessionId: "untitled", updatedAt: "2026-01-02T00:00:00.000Z", cwd: "/tmp/project" },
      session("older", "Older real", "2026-01-01T00:00:00.000Z"),
    ];

    expect(resumableSessions(sessions, altaSessionListPolicy).map((item) => item.sessionId)).toEqual([
      "untitled",
      "older",
    ]);
  });

  test("filters the only Alta cache-path session from resume picker items", () => {
    const cachePath = "/Users/me/.cache/alta/agents/axiom@1.0.0/node_modules/@atlassian/alta-agent-axiom/agent.yml";
    const items = resumableSessionSelectionItems(
      [session("cache-session", cachePath, "2026-01-03T00:00:00.000Z")],
      null,
      altaSessionListPolicy,
    );

    expect(items).toHaveLength(0);
  });

  test("filters an Alta YAML fallback title from resume picker items", () => {
    const fallbackPath = "/Users/me/agents/dev-agent.yml";
    const items = resumableSessionSelectionItems(
      [session("yaml-session", fallbackPath, null)],
      null,
      altaSessionListPolicy,
    );

    expect(items).toHaveLength(0);
  });

  test("identifies internal Alta cache titles for persisted thread title recovery", () => {
    expect(
      isInternalSessionTitle(
        "/Users/me/.cache/alta/agents/axiom@1.0.0/node_modules/@atlassian/alta-agent-axiom/agent.yml",
        altaSessionListPolicy,
      ),
    ).toBe(true);
    expect(isInternalSessionTitle("/Users/me/agents/dev-agent.yml", altaSessionListPolicy)).toBe(false);
    expect(isInternalSessionTitle("explain /Users/me/.cache/alta/agents in docs", altaSessionListPolicy)).toBe(false);
  });

  test("renders recursive handoff relationships without changing selected values", () => {
    const values = [
      session("grandchild", "Task Add retries"),
      session("child", "Task Diagnose callbacks"),
      session("parent", "Task Build authentication"),
      session("sibling", "Task Count branches"),
    ];
    const items = hierarchicalSessionSelectionItems(values, "child", [
      { parentSessionId: "parent", childSessionId: "child" },
      { parentSessionId: "child", childSessionId: "grandchild" },
      { parentSessionId: "parent", childSessionId: "sibling" },
    ]);

    expect(items.map((item) => item.label)).toEqual([
      "Task Build authentication",
      " L Task Diagnose callbacks",
      "    L Task Add retries",
      " L Task Count branches",
    ]);
    expect(items.map((item) => item.value.sessionId)).toEqual(["parent", "child", "grandchild", "sibling"]);
    expect(items[1]?.active).toBe(true);
  });

  test("keeps resume fuzzy filtering based on the original title instead of tree markers", () => {
    const items = hierarchicalSessionSelectionItems(
      [session("child", "Task Diagnose errors"), session("parent", "Task Repair authentication")],
      null,
      [{ parentSessionId: "parent", childSessionId: "child" }],
    );

    expect(filterListItems(items, "diagnose").map((item) => item.value.sessionId)).toEqual(["child"]);
    expect(filterListItems(items, "l", { includeDescription: false })).toHaveLength(0);
  });
});
