import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  discoverLiveSessionInstances,
  sendLiveSessionControlRequest,
  startLiveSessionControlServer,
} from "../src/platform/live-session-control";
import { restoredLiveSessionMessageBlocks } from "../src/core/live-sessions";
import { formatSessionInspection, formatSessionsTable, runSessionControlCli } from "../src/platform/live-session-cli";

const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
let tempConfigHome = "";

beforeEach(() => {
  tempConfigHome = mkdtempSync(join(tmpdir(), "relay-live-control-"));
  process.env.XDG_CONFIG_HOME = tempConfigHome;
});

afterEach(() => {
  if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
  rmSync(tempConfigHome, { recursive: true, force: true });
});

test("restores persisted steering messages only for their ACP session", () => {
  const thread = {
    liveSessionMessages: [
      {
        id: "live-rm_one",
        acpSessionId: "acp-child",
        content: "[parent: build-beacon]\n\nCount to 20 instead",
        delivery: "current-turn-guidance" as const,
        createdAt: "2026-08-09T08:53:20.000Z",
      },
    ],
  };

  expect(restoredLiveSessionMessageBlocks(thread, "acp-other", [])).toEqual([]);
  expect(restoredLiveSessionMessageBlocks(thread, "acp-child", [])).toEqual([
    {
      type: "user",
      id: "live-rm_one",
      content: "[parent: build-beacon]\n\nCount to 20 instead",
      origin: "local",
      delivery: "current-turn-guidance",
    },
  ]);
  expect(
    restoredLiveSessionMessageBlocks(thread, "acp-child", [
      {
        type: "user",
        id: "provider-echo",
        content: "[parent: build-beacon]\n\nCount to 20 instead",
      },
    ]),
  ).toEqual([]);
});

describe("live session control transport", () => {
  test("registers an instance and exchanges authenticated requests", async () => {
    const server = await startLiveSessionControlServer((request) => ({
      version: 1,
      requestId: request.requestId,
      ok: true,
      result: { sessions: [{ id: "rs_test" }] },
    }));

    try {
      const instances = discoverLiveSessionInstances();
      expect(instances).toHaveLength(1);
      expect(instances[0]?.instanceId).toBe(server.instanceId);

      const response = await sendLiveSessionControlRequest(instances[0]!, "session.list");
      expect(response).toMatchObject({ ok: true, result: { sessions: [{ id: "rs_test" }] } });
    } finally {
      await server.close();
    }

    expect(discoverLiveSessionInstances()).toEqual([]);
  });

  test("binds managed requests to their scoped session token", async () => {
    let handled = false;
    const server = await startLiveSessionControlServer((request) => {
      handled = true;
      return { version: 1, requestId: request.requestId, ok: true, result: {} };
    });

    try {
      const manifest = discoverLiveSessionInstances()[0]!;
      const managed = {
        ...manifest,
        token: server.tokenForSession("rs_child"),
        actorSessionId: "rs_child",
      };
      const response = await sendLiveSessionControlRequest(managed, "session.message", {
        senderSessionId: "rs_parent",
        targetSessionId: "rs_target",
        text: "spoofed",
      });
      expect(response).toMatchObject({ ok: false, error: { code: "identity_mismatch" } });
      expect(handled).toBe(false);
    } finally {
      await server.close();
    }
  });

  test("deduplicates mutating requests by operation id", async () => {
    let handled = 0;
    const server = await startLiveSessionControlServer((request) => {
      handled += 1;
      return {
        version: 1,
        requestId: request.requestId,
        ok: true,
        result: { handled },
      };
    });

    try {
      const manifest = discoverLiveSessionInstances()[0]!;
      const first = await sendLiveSessionControlRequest(manifest, "session.message", {
        operationId: "operation-one",
        targetSessionId: "rs_target",
        text: "hello",
      });
      const replay = await sendLiveSessionControlRequest(manifest, "session.message", {
        operationId: "operation-one",
        targetSessionId: "rs_target",
        text: "hello",
      });
      const conflict = await sendLiveSessionControlRequest(manifest, "session.message", {
        operationId: "operation-one",
        targetSessionId: "rs_target",
        text: "different",
      });

      expect(first).toMatchObject({ ok: true, result: { handled: 1 } });
      expect(replay).toMatchObject({ ok: true, result: { handled: 1 } });
      expect(conflict).toMatchObject({ ok: false, error: { code: "operation_conflict" } });
      expect(handled).toBe(1);
    } finally {
      await server.close();
    }
  });

  test("formats non-JSON session listings as aligned columns", () => {
    const table = formatSessionsTable([
      {
        id: "rs_one",
        name: "review-wren",
        role: "parent",
        instanceId: "ri_one",
        threadId: "thread-one",
        title: "Parser review",
        cwd: "/tmp/one",
        agent: "test",
        activity: "idle",
      },
      {
        id: "rs_two",
        name: "build-beacon",
        role: "child",
        instanceId: "ri_two",
        threadId: "thread-two",
        title: "Build",
        cwd: "/tmp/two",
        agent: "test",
        activity: "running",
        relation: "child",
      },
    ]);
    const [header, first, second] = table.split("\n");

    expect(first.indexOf("idle")).toBe(header.indexOf("STATUS"));
    expect(second.indexOf("running")).toBe(header.indexOf("STATUS"));
    expect(first.indexOf("parent")).toBe(header.indexOf("ROLE"));
    expect(second.indexOf("child")).toBe(header.indexOf("ROLE"));
    expect(second.indexOf("child", header.indexOf("RELATION"))).toBe(header.indexOf("RELATION"));
    expect(header).not.toContain("ID");
    expect(table).not.toContain("rs_one");
    expect(table).not.toContain("rs_two");
  });

  test("formats sanitized session inspections for agent-readable output", () => {
    const output = formatSessionInspection({
      session: {
        id: "rs_child",
        name: "review-otter",
        role: "child",
        instanceId: "ri_one",
        threadId: "thread-child",
        title: "Review",
        cwd: "/tmp/project",
        agent: "test",
        activity: "running",
        taskState: "running",
      },
      history: "recent:2",
      turns: [
        {
          user: "Inspect parser",
          updates: ["Check malformed input"],
          assistant: "Found one issue",
        },
      ],
    });

    expect(output).toContain("Session: review-otter");
    expect(output).toContain("Activity: running");
    expect(output).toContain("Update: Check malformed input");
    expect(output).toContain("Assistant: Found one issue");
  });

  test("managed CLI waits for any child and prints its final result", async () => {
    const server = await startLiveSessionControlServer((request) => {
      if (request.method === "session.list") {
        return {
          version: 1,
          requestId: request.requestId,
          ok: true,
          result: {
            sessions: [
              {
                id: "rs_parent",
                name: "build-beacon",
                role: "parent",
                instanceId: server.instanceId,
                threadId: "thread-parent",
                title: "Parent",
                cwd: process.cwd(),
                agent: "test",
                activity: "running",
              },
            ],
          },
        };
      }
      expect(request.method).toBe("session.wait");
      expect(request.params).toMatchObject({ requesterSessionId: "rs_parent", timeoutMs: 45_000 });
      expect(request.params).not.toHaveProperty("targetSessionId");
      return {
        version: 1,
        requestId: request.requestId,
        ok: true,
        result: {
          outcome: "terminal",
          waitedMs: 12,
          session: {
            id: "rs_child",
            name: "review-otter",
            role: "child",
            parentSessionId: "rs_parent",
            instanceId: server.instanceId,
            threadId: "thread-child",
            title: "Review",
            cwd: process.cwd(),
            agent: "test",
            activity: "idle",
            taskState: "done",
          },
          result: "Evidence-backed review complete.",
        },
      };
    });

    const previousEnv = {
      RELAY_INSTANCE_ID: process.env.RELAY_INSTANCE_ID,
      RELAY_CONTROL_TOKEN: process.env.RELAY_CONTROL_TOKEN,
      RELAY_SESSION_ID: process.env.RELAY_SESSION_ID,
      RELAY_SESSION_NAME: process.env.RELAY_SESSION_NAME,
      RELAY_SESSION_ROLE: process.env.RELAY_SESSION_ROLE,
    };
    const output: string[] = [];

    try {
      process.env.RELAY_INSTANCE_ID = server.instanceId;
      process.env.RELAY_CONTROL_TOKEN = server.tokenForSession("rs_parent");
      process.env.RELAY_SESSION_ID = "rs_parent";
      process.env.RELAY_SESSION_NAME = "build-beacon";
      process.env.RELAY_SESSION_ROLE = "parent";

      const exitCode = await runSessionControlCli(
        { kind: "wait-session", timeoutMs: 45_000, json: false },
        { writeLine: (line) => output.push(line) },
      );

      expect(exitCode).toBe(0);
      expect(output.join("\n")).toContain("Completed: review-otter (done)");
      expect(output.join("\n")).toContain("do not call relay inspect to retrieve it again");
      expect(output.join("\n")).toContain("Evidence-backed review complete.");
    } finally {
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await server.close();
    }
  });

  test("installed CLI discovers sessions and routes a message to the owning instance", async () => {
    const received: unknown[] = [];
    const server = await startLiveSessionControlServer((request) => {
      if (request.method === "session.list") {
        return {
          version: 1,
          requestId: request.requestId,
          ok: true,
          result: {
            sessions: [
              {
                id: "rs_cli_test",
                name: "test-otter",
                role: "parent",
                instanceId: server.instanceId,
                threadId: "thread-test",
                title: "CLI test",
                cwd: process.cwd(),
                agent: "test",
                activity: "idle",
              },
            ],
          },
        };
      }
      received.push(request.params);
      if (request.method === "session.inspect") {
        return {
          version: 1,
          requestId: request.requestId,
          ok: true,
          result: {
            session: {
              id: "rs_cli_test",
              name: "test-otter",
              role: "parent",
              instanceId: server.instanceId,
              threadId: "thread-test",
              title: "CLI test",
              cwd: process.cwd(),
              agent: "test",
              activity: "running",
              taskState: "running",
            },
            history: "recent:2",
            turns: [{ user: "Inspect parser", updates: ["Check malformed input"] }],
          },
        };
      }
      return {
        version: 1,
        requestId: request.requestId,
        ok: true,
        result: {
          messageId: "rm_test",
          targetSessionId: "rs_cli_test",
          delivery: "started_turn",
          accepted: true,
        },
      };
    });

    try {
      const relayEntry = resolve(import.meta.dir, "../src/index.ts");
      const cliEnv: Record<string, string | undefined> = { ...process.env, XDG_CONFIG_HOME: tempConfigHome };
      delete cliEnv.RELAY_SESSION_ID;
      delete cliEnv.RELAY_SESSION_NAME;
      delete cliEnv.RELAY_SESSION_ROLE;
      delete cliEnv.RELAY_PARENT_SESSION_ID;
      delete cliEnv.RELAY_PARENT_SESSION_NAME;
      const runRelayCli = async (args: string[], env: Record<string, string | undefined> = cliEnv) => {
        const child = Bun.spawn([process.execPath, "run", relayEntry, ...args], {
          env,
          stdout: "pipe",
          stderr: "pipe",
        });
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        return { exitCode, stdout, stderr };
      };

      const [list, inspect] = await Promise.all([
        runRelayCli(["list", "sessions", "--json"]),
        runRelayCli(["inspect", "session", "test-otter", "--history", "recent:2", "--json"]),
      ]);
      expect(list.exitCode).toBe(0);
      expect(JSON.parse(list.stdout).sessions[0].id).toBe("rs_cli_test");
      expect(inspect.exitCode).toBe(0);
      const inspection = JSON.parse(inspect.stdout);
      expect(inspection).toMatchObject({
        session: { name: "test-otter", activity: "running" },
        history: "recent:2",
        turns: [{ user: "Inspect parser", updates: ["Check malformed input"] }],
      });

      const [message, managedStart] = await Promise.all([
        runRelayCli(["message", "test-otter", "please", "continue"]),
        runRelayCli(["start", "session", "Review parser", "--name", "review-raven"], {
          ...cliEnv,
          RELAY_INSTANCE_ID: server.instanceId,
          RELAY_CONTROL_TOKEN: server.tokenForSession("rs_cli_test"),
          RELAY_SESSION_ID: "rs_cli_test",
          RELAY_SESSION_NAME: "test-otter",
          RELAY_SESSION_ROLE: "parent",
        }),
      ]);
      expect(message.exitCode).toBe(0);
      expect(message.stdout).toContain("started_turn: test-otter");
      expect(managedStart.exitCode).toBe(0);

      const [byId, selfMessage, nestedStart] = await Promise.all([
        runRelayCli(["message", "rs_cli_test", "not", "allowed"]),
        runRelayCli(["message", "test-otter", "loop", "message"], {
          ...cliEnv,
          RELAY_INSTANCE_ID: server.instanceId,
          RELAY_CONTROL_TOKEN: server.tokenForSession("rs_cli_test"),
          RELAY_SESSION_ID: "rs_cli_test",
          RELAY_SESSION_NAME: "test-otter",
        }),
        runRelayCli(["start", "session", "Create a sibling", "--name", "nested-raven", "--parent", "test-otter"], {
          ...cliEnv,
          RELAY_INSTANCE_ID: server.instanceId,
          RELAY_CONTROL_TOKEN: server.tokenForSession("rs_child"),
          RELAY_SESSION_ID: "rs_child",
          RELAY_SESSION_NAME: "review-otter",
          RELAY_SESSION_ROLE: "child",
          RELAY_PARENT_SESSION_ID: "rs_cli_test",
          RELAY_PARENT_SESSION_NAME: "test-otter",
        }),
      ]);
      expect(byId.exitCode).toBe(1);
      expect(byId.stderr).toContain("Live session rs_cli_test was not found");
      expect(selfMessage.exitCode).toBe(1);
      expect(selfMessage.stderr).toContain("Session test-otter cannot message itself");
      expect(nestedStart.exitCode).toBe(1);
      expect(nestedStart.stderr).toContain("Child sessions cannot create sessions");

      expect(received).toHaveLength(3);
      expect(received).toEqual(
        expect.arrayContaining([
          {
            targetSessionId: "rs_cli_test",
            history: { mode: "recent", turns: 2 },
          },
          {
            operationId: expect.any(String),
            targetSessionId: "rs_cli_test",
            text: "please continue",
            delivery: "mailbox",
          },
          {
            operationId: expect.any(String),
            parentSessionId: "rs_cli_test",
            requesterSessionId: "rs_cli_test",
            requesterSessionName: "test-otter",
            task: "Review parser",
            name: "review-raven",
            history: { mode: "none" },
            worktree: false,
            relation: "child",
          },
        ]),
      );
    } finally {
      await server.close();
    }
  }, 45_000);
});
