import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Effect } from "effect";
import {
  AcpClient,
  formatToolOutput,
  latestAvailableCommandsFromUpdates,
  primaryStartupErrorFromStderr,
  summarizeStderr,
  type AcpClientCallbacks,
  type AcpProcessExitEvent,
} from "../../src/acp/client";
import { ALTA_IMAGE_ATTACHMENT_NOTE, altaAgentBehaviorProfile } from "../../src/acp/profiles/alta";
import { ApprovalResponse } from "../../src/core/events";
import { runTestEffect } from "../lib/effect";

const tmpRoots: string[] = [];

function tmpRoot(): string {
  const dir = path.join(tmpdir(), `relay-acp-client-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  tmpRoots.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpRoots.length > 0) rmSync(tmpRoots.pop()!, { recursive: true, force: true });
});

function agentCommand(name: string, description: string) {
  return {
    name,
    description,
    origin: "agent" as const,
    kind: "unknown" as const,
    invocation: { syntax: "slash" as const, composable: false as const },
  };
}

function callbacks(overrides: Partial<AcpClientCallbacks> = {}): AcpClientCallbacks {
  return {
    onSessionUpdate: () => undefined,
    onPermissionRequest: (request) => request.respond(ApprovalResponse.DENY),
    ...overrides,
  };
}

async function waitForExit(events: unknown[], timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (events.length === 0 && Date.now() < deadline) await Bun.sleep(10);
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform !== "linux") return true;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    const commandEnd = stat.lastIndexOf(")");
    const state = commandEnd >= 0 ? stat.slice(commandEnd + 2, commandEnd + 3) : "";
    return state !== "Z" && state !== "X";
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsRunning(pid)) return;
    await Bun.sleep(10);
  }
  throw new Error(`Process ${pid} did not exit within ${timeoutMs} ms`);
}

function writePermissionAgent(agentPath: string, permissionOptionsSource: string): void {
  writeFileSync(
    agentPath,
    `
      import * as readline from "node:readline";
      let pendingPromptId = null;
      const permissionOptions = ${permissionOptionsSource};
      function write(message: unknown) { process.stdout.write(JSON.stringify(message) + "\\n"); }
      for await (const raw of readline.createInterface({ input: process.stdin })) {
        const message = JSON.parse(raw);
        if (message.method === "initialize") {
          write({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
        } else if (message.method === "session/new") {
          write({ jsonrpc: "2.0", id: message.id, result: { sessionId: "session-1" } });
        } else if (message.method === "session/prompt") {
          pendingPromptId = message.id;
          write({
            jsonrpc: "2.0",
            id: "permission-1",
            method: "session/request_permission",
            params: {
              sessionId: message.params.sessionId,
              toolCall: { toolCallId: "tool-1", title: "Bash", kind: "execute", rawInput: { command: "echo hi" } },
              ...(permissionOptions === undefined ? {} : { options: permissionOptions }),
            },
          });
        } else if (message.id === "permission-1") {
          const outcome = message.result?.outcome ?? {};
          write({
            jsonrpc: "2.0",
            id: pendingPromptId,
            result: {
              outcome: outcome.outcome,
              selectedOptionId: outcome.optionId ?? null,
            },
          });
        }
      }
    `,
    "utf-8",
  );
}

describe("summarizeStderr", () => {
  test("keeps short stderr output intact", () => {
    expect(summarizeStderr(" first\nsecond\n")).toBe("first\nsecond");
  });

  test("strips terminal control sequences before rendering stderr", () => {
    expect(summarizeStderr("\x1b[34mDEBUG\x1b[0m cached token\x07")).toBe("DEBUG cached token");
  });

  test("keeps the first and last 25 lines for long stderr output", () => {
    const lines = Array.from({ length: 60 }, (_, index) => `line ${index + 1}`);

    expect(summarizeStderr(lines.join("\n"))).toBe(
      [...lines.slice(0, 25), "... 10 lines hidden ...", ...lines.slice(-25)].join("\n"),
    );
  });

  test("promotes safe startup errors and hints from stderr", () => {
    expect(
      primaryStartupErrorFromStderr(
        [
          "[16:40:54.098] DEBUG cached credential lookup",
          "[sample-agent] Error: Authentication required. No OAuth credential is saved.",
          "hint: Run `sample-agent auth login`.",
        ].join("\n"),
      ),
    ).toBe("Authentication required. No OAuth credential is saved. Run `sample-agent auth login`.");
  });

  test("does not promote unsafe startup stderr", () => {
    const unsafeOutputs = [
      "error: Authentication required. See https://internal.example.test/token",
      "error: Authentication failed password=hunter2",
      "error: Authentication failed api_key=abc123",
    ];

    for (const output of unsafeOutputs) expect(primaryStartupErrorFromStderr(output)).toBe("");
  });
});

describe("formatToolOutput", () => {
  test("formats shallow object results as key/value lines", () => {
    expect(formatToolOutput({ totalFiles: 144, truncated: false })).toBe("totalFiles: 144\ntruncated: false");
  });

  test("prefers ACP content-like text fields over generic object formatting", () => {
    expect(formatToolOutput({ content: "from content", totalFiles: 144 })).toBe("from content");
  });
});

describe("AcpClient", () => {
  test("reads latest replayed available commands from ACP updates", () => {
    expect(
      latestAvailableCommandsFromUpdates([
        { sessionUpdate: "available_commands_update", availableCommands: [{ name: "review", description: "old" }] },
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ignored" } },
        { sessionUpdate: "available_commands_update", availableCommands: [{ name: "/publish", description: "new" }] },
      ]),
    ).toEqual([agentCommand("publish", "new")]);
  });

  test("preserves agent command input and extension metadata", () => {
    const command = latestAvailableCommandsFromUpdates([
      {
        sessionUpdate: "available_commands_update",
        availableCommands: [
          {
            name: "review",
            description: "Review changes",
            input: { hint: "scope" },
            _meta: { "example.dev": { kind: "skill" } },
          },
        ],
      },
    ])?.[0];

    expect(command).toEqual({
      ...agentCommand("review", "Review changes"),
      input: { hint: "scope" },
      meta: { "example.dev": { kind: "skill" } },
    });
  });

  test("appends prompt submission system reminders to ACP prompt content", async () => {
    const root = tmpRoot();
    const agentPath = path.join(root, "agent.ts");
    const promptPath = path.join(root, "prompt.json");

    writeFileSync(
      agentPath,
      `
        import { writeFileSync } from "node:fs";
        import * as readline from "node:readline";
        const promptPath = ${JSON.stringify(promptPath)};
        function write(message: unknown) { process.stdout.write(JSON.stringify(message) + "\\n"); }
        for await (const raw of readline.createInterface({ input: process.stdin })) {
          const message = JSON.parse(raw);
          if (message.method === "initialize") {
            write({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
          } else if (message.method === "session/new") {
            write({ jsonrpc: "2.0", id: message.id, result: { sessionId: "session-1" } });
          } else if (message.method === "session/prompt") {
            writeFileSync(promptPath, JSON.stringify(message.params));
            write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
          }
        }
      `,
      "utf-8",
    );

    const client = new AcpClient(callbacks(), { cwd: root, command: "bun", args: [agentPath] });

    try {
      await client.connect();
      await client.newSession(root);
      await client.prompt({ text: "visible prompt", images: [], systemReminders: ["keep it concise"] });

      expect(JSON.parse(readFileSync(promptPath, "utf-8"))).toEqual({
        sessionId: "session-1",
        prompt: [
          { type: "text", text: "visible prompt" },
          { type: "text", text: "system-reminder: keep it concise" },
        ],
      });
    } finally {
      await client.disposeAsync();
    }
  });

  test("stores advertised auth methods and sends authenticate and logout requests", async () => {
    const root = tmpRoot();
    const agentPath = path.join(root, "agent.ts");
    const transcriptPath = path.join(root, "transcript.ndjson");

    writeFileSync(
      agentPath,
      `
        import { appendFileSync } from "node:fs";
        import * as readline from "node:readline";
        const transcriptPath = ${JSON.stringify(transcriptPath)};
        function record(message: unknown) { appendFileSync(transcriptPath, JSON.stringify({ method: (message as any).method, params: (message as any).params }) + "\\n"); }
        function write(message: unknown) { process.stdout.write(JSON.stringify(message) + "\\n"); }
        for await (const raw of readline.createInterface({ input: process.stdin })) {
          const message = JSON.parse(raw);
          record(message);
          if (message.method === "initialize") {
            write({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                protocolVersion: 1,
                agentCapabilities: { auth: { logout: {} } },
                authMethods: [
                  { id: "oauth", name: "OAuth", description: "Browser login" },
                  { type: "terminal", id: "terminal", name: "Terminal login", args: ["auth", "login"] },
                ],
              },
            });
          } else if (message.method === "authenticate") {
            write({ jsonrpc: "2.0", id: message.id, result: {} });
          } else if (message.method === "logout") {
            write({ jsonrpc: "2.0", id: message.id, result: {} });
          }
        }
      `,
      "utf-8",
    );

    const client = new AcpClient(callbacks(), { cwd: root, command: "bun", args: [agentPath] });

    try {
      await client.connect();

      expect(client.supportsAuthLogout()).toBe(true);
      expect(client.authMethods()).toEqual([
        {
          id: "oauth",
          name: "OAuth",
          description: "Browser login",
          type: "agent",
          link: undefined,
          supported: true,
        },
        {
          id: "terminal",
          name: "Terminal login",
          description: undefined,
          type: "terminal",
          link: undefined,
          terminal: { command: "bun", args: [agentPath, "auth", "login"] },
          supported: true,
        },
      ]);
      expect(client.supportedAuthMethods().map((method) => method.id)).toEqual(["oauth", "terminal"]);
      await client.authenticate("oauth");
      await client.logout();

      const requests = readFileSync(transcriptPath, "utf-8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      expect(requests.map((entry) => entry.method)).toEqual(["initialize", "authenticate", "logout"]);
      expect(requests[0].params.clientCapabilities).toEqual({
        auth: { terminal: true },
        elicitation: { form: {} },
        _meta: { "terminal-auth": true, "alta/subagent": { liveStreaming: true } },
      });
      expect(requests[1].params).toEqual({ methodId: "oauth" });
      expect(requests[2].params).toEqual({});
    } finally {
      await client.disposeAsync();
    }
  });

  test("rejects unsupported initialize protocol versions", async () => {
    const root = tmpRoot();
    const agentPath = path.join(root, "agent.ts");

    writeFileSync(
      agentPath,
      `
        import * as readline from "node:readline";
        function write(message: unknown) { process.stdout.write(JSON.stringify(message) + "\\n"); }
        process.on("SIGTERM", () => process.exit(0));
        for await (const raw of readline.createInterface({ input: process.stdin })) {
          const message = JSON.parse(raw);
          if (message.method === "initialize") {
            write({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 2, agentCapabilities: {}, authMethods: [] } });
          }
        }
      `,
      "utf-8",
    );

    const client = new AcpClient(callbacks(), { cwd: root, command: "bun", args: [agentPath] });

    try {
      await expect(client.connect()).rejects.toThrow("Unsupported ACP protocol version 2; Relay supports 1");
      expect(client.supportsSessionList()).toBe(false);
    } finally {
      await client.disposeAsync();
    }
  });

  test("detaches stdio agent process from Relay's terminal on POSIX", async () => {
    if (process.platform === "win32") return;
    const root = tmpRoot();
    const agentPath = path.join(root, "agent.ts");
    const statusPath = path.join(root, "status.json");

    writeFileSync(
      agentPath,
      `
        import { execFileSync } from "node:child_process";
        import { readFileSync, writeFileSync } from "node:fs";
        import * as readline from "node:readline";
        const statusPath = ${JSON.stringify(statusPath)};
        function processGroupId(): number | null {
          try {
            const stat = readFileSync("/proc/self/stat", "utf-8");
            const endOfCommand = stat.lastIndexOf(")");
            const fields = endOfCommand === -1 ? [] : stat.slice(endOfCommand + 2).trim().split(/\\s+/);
            const value = Number(fields[2]);
            if (Number.isFinite(value)) return value;
          } catch {
            // /proc is Linux-only; fall back to Python/ps below.
          }
          try {
            const output = execFileSync("python3", ["-c", "import os; print(os.getpgrp())"], { encoding: "utf-8" });
            const value = Number(output.trim());
            if (Number.isFinite(value)) return value;
          } catch {
            // python3 may not be installed in minimal unit-test environments.
          }
          try {
            const output = execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf-8" });
            const value = Number(output.trim());
            return Number.isFinite(value) ? value : null;
          } catch {
            return null;
          }
        }
        function write(message: unknown) { process.stdout.write(JSON.stringify(message) + "\\n"); }
        for await (const raw of readline.createInterface({ input: process.stdin })) {
          const message = JSON.parse(raw);
          if (message.method === "initialize") {
            writeFileSync(statusPath, JSON.stringify({
              pid: process.pid,
              pgid: processGroupId(),
              stdinIsTTY: process.stdin.isTTY === true,
              stdoutIsTTY: process.stdout.isTTY === true,
            }));
            write({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
          }
        }
      `,
      "utf-8",
    );

    const client = new AcpClient(callbacks(), { cwd: root, command: "bun", args: [agentPath] });

    try {
      await client.connect();
      const status = JSON.parse(readFileSync(statusPath, "utf-8")) as {
        readonly pid: number;
        readonly pgid: number | null;
        readonly stdinIsTTY: boolean;
        readonly stdoutIsTTY: boolean;
      };
      expect(status.pgid).toBe(status.pid);
      expect(status.stdinIsTTY).toBe(false);
      expect(status.stdoutIsTTY).toBe(false);
    } finally {
      await client.disposeAsync();
    }
  });

  test("returns the selected advertised permission option id", async () => {
    const root = tmpRoot();
    const agentPath = path.join(root, "agent.ts");
    const receivedOptions: unknown[] = [];

    writeFileSync(
      agentPath,
      `
        import * as readline from "node:readline";
        let pendingPromptId = null;
        function write(message: unknown) { process.stdout.write(JSON.stringify(message) + "\\n"); }
        for await (const raw of readline.createInterface({ input: process.stdin })) {
          const message = JSON.parse(raw);
          if (message.method === "initialize") {
            write({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
          } else if (message.method === "session/new") {
            write({ jsonrpc: "2.0", id: message.id, result: { sessionId: "session-1" } });
          } else if (message.method === "session/prompt") {
            pendingPromptId = message.id;
            write({
              jsonrpc: "2.0",
              id: "permission-1",
              method: "session/request_permission",
              params: {
                sessionId: message.params.sessionId,
                toolCall: { toolCallId: "tool-1", title: "Bash", kind: "execute", rawInput: { command: "echo hi" } },
                options: [
                  { optionId: "custom-allow", name: "Allow custom", kind: "allow_always" },
                  { optionId: "custom-reject", name: "Reject custom", kind: "reject_once" },
                ],
              },
            });
          } else if (message.id === "permission-1") {
            write({
              jsonrpc: "2.0",
              id: pendingPromptId,
              result: {
                outcome: message.result.outcome.outcome,
                selectedOptionId: message.result.outcome.optionId,
              },
            });
          }
        }
      `,
      "utf-8",
    );

    const client = new AcpClient(
      callbacks({
        onPermissionRequest: (request) => {
          receivedOptions.push(request.options);
          request.respond(ApprovalResponse.APPROVE);
        },
      }),
      { cwd: root, command: "bun", args: [agentPath] },
    );

    try {
      await client.connect();
      await client.newSession(root);
      await expect(client.prompt("run a command")).resolves.toEqual({
        outcome: "selected",
        selectedOptionId: "custom-allow",
      });
      expect(receivedOptions).toEqual([
        [
          { optionId: "custom-allow", name: "Allow custom", kind: "allow_always" },
          { optionId: "custom-reject", name: "Reject custom", kind: "reject_once" },
        ],
      ]);
    } finally {
      await client.disposeAsync();
    }
  });

  for (const scenario of [
    { name: "missing permission options", permissionOptionsSource: "undefined" },
    { name: "invalid permission options", permissionOptionsSource: `[{ name: "Reject", kind: "reject_once" }]` },
  ]) {
    test(`cancels permission requests with ${scenario.name}`, async () => {
      const root = tmpRoot();
      const agentPath = path.join(root, "agent.ts");
      let prompted = false;
      writePermissionAgent(agentPath, scenario.permissionOptionsSource);

      const client = new AcpClient(
        callbacks({
          onPermissionRequest: (request) => {
            prompted = true;
            request.respond(ApprovalResponse.APPROVE);
          },
        }),
        { cwd: root, command: "bun", args: [agentPath] },
      );

      try {
        await client.connect();
        await client.newSession(root);
        await expect(client.prompt("run a command")).resolves.toEqual({
          outcome: "cancelled",
          selectedOptionId: null,
        });
        expect(prompted).toBe(false);
      } finally {
        await client.disposeAsync();
      }
    });
  }

  test("cancels when the selected permission option was not advertised", async () => {
    const root = tmpRoot();
    const agentPath = path.join(root, "agent.ts");
    writePermissionAgent(
      agentPath,
      `[
        { optionId: "custom-allow", name: "Allow custom", kind: "allow_once" },
        { optionId: "custom-reject", name: "Reject custom", kind: "reject_once" },
      ]`,
    );

    const client = new AcpClient(
      callbacks({
        onPermissionRequest: (request) => {
          request.respond({ optionId: "not-advertised", name: "Not advertised", kind: "allow_once" });
        },
      }),
      { cwd: root, command: "bun", args: [agentPath] },
    );

    try {
      await client.connect();
      await client.newSession(root);
      await expect(client.prompt("run a command")).resolves.toEqual({
        outcome: "cancelled",
        selectedOptionId: null,
      });
    } finally {
      await client.disposeAsync();
    }
  });

  test("dispose terminates a connected ACP child process with no active request", async () => {
    const root = tmpRoot();
    const agentPath = path.join(root, "agent.ts");
    const markerPath = path.join(root, "agent.closed");

    writeFileSync(
      agentPath,
      `
        import { writeFileSync } from "node:fs";
        import * as readline from "node:readline";
        process.once("exit", () => writeFileSync(${JSON.stringify(markerPath)}, "exited"));
        process.on("SIGTERM", () => process.exit(0));
        function write(message: unknown) { process.stdout.write(JSON.stringify(message) + "\\n"); }
        for await (const raw of readline.createInterface({ input: process.stdin })) {
          const message = JSON.parse(raw);
          if (message.method === "initialize") {
            write({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
          } else if (message.method === "session/new") {
            write({ jsonrpc: "2.0", id: message.id, result: { sessionId: "session-1" } });
          } else if (message.method === "session/prompt") {
            // Intentionally leave request pending until dispose closes the connection.
          }
        }
      `,
      "utf-8",
    );

    const client = new AcpClient(callbacks(), {
      cwd: root,
      command: "bun",
      args: [agentPath],
    });
    await client.connect();
    await runTestEffect(client.disposeEffect());

    expect(existsSync(markerPath) ? readFileSync(markerPath, "utf-8") : "").toBe("exited");
  });

  test("disposeAsync terminates a connected ACP child process", async () => {
    const root = tmpRoot();
    const agentPath = path.join(root, "agent.ts");
    const markerPath = path.join(root, "agent.closed");
    const exits: AcpProcessExitEvent[] = [];

    writeFileSync(
      agentPath,
      `
        import { writeFileSync } from "node:fs";
        import * as readline from "node:readline";
        process.on("SIGTERM", () => {
          writeFileSync(${JSON.stringify(markerPath)}, "terminated");
          process.exit(0);
        });
        function write(message: unknown) { process.stdout.write(JSON.stringify(message) + "\\n"); }
        for await (const raw of readline.createInterface({ input: process.stdin })) {
          const message = JSON.parse(raw);
          if (message.method === "initialize") {
            write({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
          }
        }
      `,
      "utf-8",
    );

    const client = new AcpClient(callbacks({ onProcessExit: (event) => exits.push(event) }), {
      cwd: root,
      command: "bun",
      args: [agentPath],
    });
    await client.connect();
    await client.disposeAsync();

    expect(existsSync(markerPath) ? readFileSync(markerPath, "utf-8") : "").toBe("terminated");
    expect(exits).toEqual([expect.objectContaining({ code: 0, expected: true, reason: "dispose" })]);
    expect(exits[0]?.signal).toBeUndefined();
  });

  test("disposeAsync escalates when an ACP child ignores SIGTERM", async () => {
    if (process.platform === "win32") return;

    const root = tmpRoot();
    const agentPath = path.join(root, "agent.ts");
    const markerPath = path.join(root, "agent.sigterm");
    const pidPath = path.join(root, "agent.pid");
    const exits: AcpProcessExitEvent[] = [];

    writeFileSync(
      agentPath,
      `
        import { writeFileSync } from "node:fs";
        import * as readline from "node:readline";
        writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
        process.on("SIGTERM", () => writeFileSync(${JSON.stringify(markerPath)}, "ignored"));
        function write(message: unknown) { process.stdout.write(JSON.stringify(message) + "\\n"); }
        for await (const raw of readline.createInterface({ input: process.stdin })) {
          const message = JSON.parse(raw);
          if (message.method === "initialize") {
            write({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
          }
        }
        await new Promise(() => {});
      `,
      "utf-8",
    );

    const client = new AcpClient(callbacks({ onProcessExit: (event) => exits.push(event) }), {
      cwd: root,
      command: "bun",
      args: [agentPath],
    });
    await client.connect();
    const pid = Number(readFileSync(pidPath, "utf-8"));
    const disposePromise = client.disposeAsync();
    let disposed = false;

    try {
      await Promise.race([
        disposePromise.then(() => {
          disposed = true;
        }),
        new Promise<void>((resolve) => setTimeout(resolve, 500)),
      ]);
      expect(disposed).toBe(true);
    } finally {
      if (!disposed) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {}
        await disposePromise;
      }
    }

    expect(existsSync(markerPath) ? readFileSync(markerPath, "utf-8") : "").toBe("ignored");
    await waitForProcessExit(pid);
    expect(processIsRunning(pid)).toBe(false);
    expect(exits).toEqual([expect.objectContaining({ signal: "SIGKILL", expected: true, reason: "dispose" })]);
  });

  test("forceDispose immediately kills a SIGTERM-resistant ACP child", async () => {
    if (process.platform === "win32") return;

    const root = tmpRoot();
    const agentPath = path.join(root, "agent.ts");
    const pidPath = path.join(root, "agent.pid");
    const sigtermMarkerPath = path.join(root, "agent.sigterm");
    const exits: AcpProcessExitEvent[] = [];

    writeFileSync(
      agentPath,
      `
        import { writeFileSync } from "node:fs";
        import * as readline from "node:readline";
        writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
        process.on("SIGTERM", () => writeFileSync(${JSON.stringify(sigtermMarkerPath)}, "received"));
        function write(message: unknown) { process.stdout.write(JSON.stringify(message) + "\\n"); }
        for await (const raw of readline.createInterface({ input: process.stdin })) {
          const message = JSON.parse(raw);
          if (message.method === "initialize") {
            write({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
          }
        }
        await new Promise(() => {});
      `,
      "utf-8",
    );

    const client = new AcpClient(callbacks({ onProcessExit: (event) => exits.push(event) }), {
      cwd: root,
      command: "bun",
      args: [agentPath],
    });
    await client.connect();
    const pid = Number(readFileSync(pidPath, "utf-8"));

    client.forceDispose();
    await waitForExit(exits);

    expect(existsSync(sigtermMarkerPath)).toBe(false);
    await waitForProcessExit(pid);
    expect(processIsRunning(pid)).toBe(false);
    expect(exits).toEqual([expect.objectContaining({ signal: "SIGKILL", expected: true, reason: "dispose" })]);
    await client.disposeAsync();
  });

  test("disposeAsync terminates ACP descendants after their launcher exits", async () => {
    if (process.platform === "win32") return;

    const root = tmpRoot();
    const agentPath = path.join(root, "agent.ts");
    const descendantPath = path.join(root, "descendant.ts");
    const agentPidPath = path.join(root, "agent.pid");
    const descendantPidPath = path.join(root, "descendant.pid");

    writeFileSync(
      descendantPath,
      `
        import { writeFileSync } from "node:fs";
        writeFileSync(${JSON.stringify(descendantPidPath)}, String(process.pid));
        process.on("SIGTERM", () => {});
        await new Promise(() => {});
      `,
      "utf-8",
    );
    writeFileSync(
      agentPath,
      `
        import { spawn } from "node:child_process";
        import { writeFileSync } from "node:fs";
        import * as readline from "node:readline";
        writeFileSync(${JSON.stringify(agentPidPath)}, String(process.pid));
        spawn("bun", [${JSON.stringify(descendantPath)}], { stdio: "ignore" });
        process.on("SIGTERM", () => process.exit(0));
        function write(message: unknown) { process.stdout.write(JSON.stringify(message) + "\\n"); }
        for await (const raw of readline.createInterface({ input: process.stdin })) {
          const message = JSON.parse(raw);
          if (message.method === "initialize") {
            write({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
          }
        }
      `,
      "utf-8",
    );

    const client = new AcpClient(callbacks(), {
      cwd: root,
      command: "bun",
      args: [agentPath],
    });
    await client.connect();
    const agentPid = Number(readFileSync(agentPidPath, "utf-8"));
    for (let attempt = 0; attempt < 50 && !existsSync(descendantPidPath); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const descendantPid = Number(readFileSync(descendantPidPath, "utf-8"));

    try {
      await client.disposeAsync();
      await waitForProcessExit(descendantPid);
      expect(processIsRunning(descendantPid)).toBe(false);
    } finally {
      try {
        process.kill(-agentPid, "SIGKILL");
      } catch {}
    }
  });

  test("forceDispose terminates ACP descendants with their launcher", async () => {
    if (process.platform === "win32") return;

    const root = tmpRoot();
    const agentPath = path.join(root, "agent.ts");
    const descendantPath = path.join(root, "descendant.ts");
    const agentPidPath = path.join(root, "agent.pid");
    const descendantPidPath = path.join(root, "descendant.pid");

    writeFileSync(
      descendantPath,
      `
        import { writeFileSync } from "node:fs";
        writeFileSync(${JSON.stringify(descendantPidPath)}, String(process.pid));
        process.on("SIGTERM", () => {});
        await new Promise(() => {});
      `,
      "utf-8",
    );
    writeFileSync(
      agentPath,
      `
        import { spawn } from "node:child_process";
        import { writeFileSync } from "node:fs";
        import * as readline from "node:readline";
        writeFileSync(${JSON.stringify(agentPidPath)}, String(process.pid));
        spawn("bun", [${JSON.stringify(descendantPath)}], { stdio: "ignore" });
        process.on("SIGTERM", () => {});
        function write(message: unknown) { process.stdout.write(JSON.stringify(message) + "\\n"); }
        for await (const raw of readline.createInterface({ input: process.stdin })) {
          const message = JSON.parse(raw);
          if (message.method === "initialize") {
            write({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
          }
        }
        await new Promise(() => {});
      `,
      "utf-8",
    );

    const client = new AcpClient(callbacks(), {
      cwd: root,
      command: "bun",
      args: [agentPath],
    });
    await client.connect();
    const agentPid = Number(readFileSync(agentPidPath, "utf-8"));
    for (let attempt = 0; attempt < 50 && !existsSync(descendantPidPath); attempt++) {
      await Bun.sleep(10);
    }
    const descendantPid = Number(readFileSync(descendantPidPath, "utf-8"));

    try {
      client.forceDispose();
      await waitForProcessExit(agentPid);
      await waitForProcessExit(descendantPid);
      expect(processIsRunning(agentPid)).toBe(false);
      expect(processIsRunning(descendantPid)).toBe(false);
      await client.disposeAsync();
    } finally {
      try {
        process.kill(-agentPid, "SIGKILL");
      } catch {}
    }
  });

  test("marks child exits before initialize as not connected", async () => {
    const root = tmpRoot();
    const agentPath = path.join(root, "agent.ts");
    const exits: AcpProcessExitEvent[] = [];

    writeFileSync(
      agentPath,
      `
        import * as readline from "node:readline";
        for await (const raw of readline.createInterface({ input: process.stdin })) {
          const message = JSON.parse(raw);
          if (message.method === "initialize") process.exit(0);
        }
      `,
      "utf-8",
    );

    const client = new AcpClient(callbacks({ onProcessExit: (event) => exits.push(event) }), {
      cwd: root,
      command: "bun",
      args: [agentPath],
    });

    try {
      await expect(client.connect()).rejects.toThrow();
      await waitForExit(exits);
      expect(exits).toEqual([expect.objectContaining({ code: 0, expected: false, connected: false })]);
    } finally {
      await client.disposeAsync();
    }
  });

  test("reports clean code 0 child exits as unexpected after connect", async () => {
    const root = tmpRoot();
    const agentPath = path.join(root, "agent.ts");
    const exits: AcpProcessExitEvent[] = [];

    writeFileSync(
      agentPath,
      `
        import * as readline from "node:readline";
        function write(message: unknown) { process.stdout.write(JSON.stringify(message) + "\\n"); }
        for await (const raw of readline.createInterface({ input: process.stdin })) {
          const message = JSON.parse(raw);
          if (message.method === "initialize") {
            write({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
            setTimeout(() => process.exit(0), 10);
          }
        }
      `,
      "utf-8",
    );

    const client = new AcpClient(callbacks({ onProcessExit: (event) => exits.push(event) }), {
      cwd: root,
      command: "bun",
      args: [agentPath],
    });

    try {
      await client.connect();
      await waitForExit(exits);
      expect(exits).toHaveLength(1);
      expect(exits[0]).toMatchObject({
        code: 0,
        expected: false,
        reason: "exit",
        transport: "stdio",
        connected: true,
      });
    } finally {
      await client.disposeAsync();
    }
  });

  test("reports external SIGTERM child exits as unexpected", async () => {
    const root = tmpRoot();
    const agentPath = path.join(root, "agent.ts");
    const pidPath = path.join(root, "agent.pid");
    const exits: AcpProcessExitEvent[] = [];

    writeFileSync(
      agentPath,
      `
        import { writeFileSync } from "node:fs";
        import * as readline from "node:readline";
        writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
        function write(message: unknown) { process.stdout.write(JSON.stringify(message) + "\\n"); }
        for await (const raw of readline.createInterface({ input: process.stdin })) {
          const message = JSON.parse(raw);
          if (message.method === "initialize") {
            write({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
          }
        }
      `,
      "utf-8",
    );

    const client = new AcpClient(callbacks({ onProcessExit: (event) => exits.push(event) }), {
      cwd: root,
      command: "bun",
      args: [agentPath],
    });

    try {
      await client.connect();
      const pid = Number(readFileSync(pidPath, "utf-8"));
      process.kill(pid, "SIGTERM");
      await waitForExit(exits);
      expect(exits).toHaveLength(1);
      expect(exits[0]).toMatchObject({
        signal: "SIGTERM",
        expected: false,
        reason: "exit",
        transport: "stdio",
        connected: true,
      });
    } finally {
      await client.disposeAsync();
    }
  });

  test("disposeAsync reports only expected child exits", async () => {
    const root = tmpRoot();
    const agentPath = path.join(root, "agent.ts");
    const exits: AcpProcessExitEvent[] = [];

    writeFileSync(
      agentPath,
      `
        import * as readline from "node:readline";
        process.on("SIGTERM", () => process.exit(0));
        function write(message: unknown) { process.stdout.write(JSON.stringify(message) + "\\n"); }
        for await (const raw of readline.createInterface({ input: process.stdin })) {
          const message = JSON.parse(raw);
          if (message.method === "initialize") {
            write({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
          }
        }
      `,
      "utf-8",
    );

    const client = new AcpClient(callbacks({ onProcessExit: (event) => exits.push(event) }), {
      cwd: root,
      command: "bun",
      args: [agentPath],
    });

    await client.connect();
    await client.disposeAsync();

    expect(exits.filter((event) => !event.expected)).toHaveLength(0);
    expect(exits).toEqual([expect.objectContaining({ code: 0, expected: true, reason: "dispose", connected: false })]);
  });

  test("scoped client disposes its ACP child process on scope exit", async () => {
    const root = tmpRoot();
    const agentPath = path.join(root, "agent.ts");
    const pidPath = path.join(root, "agent.pid");
    const markerPath = path.join(root, "agent.closed");

    writeFileSync(
      agentPath,
      `
        import { writeFileSync } from "node:fs";
        import * as readline from "node:readline";
        writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
        process.on("SIGTERM", () => {
          writeFileSync(${JSON.stringify(markerPath)}, "terminated");
          process.exit(0);
        });
        function write(message: unknown) { process.stdout.write(JSON.stringify(message) + "\\n"); }
        for await (const raw of readline.createInterface({ input: process.stdin })) {
          const message = JSON.parse(raw);
          if (message.method === "initialize") {
            write({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
          }
        }
      `,
      "utf-8",
    );

    await runTestEffect(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* AcpClient.scoped(callbacks(), {
            cwd: root,
            command: "bun",
            args: [agentPath],
          });
          expect(client.sessionId).toBeNull();
        }),
      ),
    );

    expect(existsSync(pidPath)).toBe(true);
    expect(existsSync(markerPath) ? readFileSync(markerPath, "utf-8") : "").toBe("terminated");
  });

  test("passes configured MCP servers to new and loaded sessions", async () => {
    const root = tmpRoot();
    const agentPath = path.join(root, "agent.ts");
    const transcriptPath = path.join(root, "transcript.ndjson");

    writeFileSync(
      agentPath,
      `
        import { appendFileSync } from "node:fs";
        import * as readline from "node:readline";
        const transcriptPath = ${JSON.stringify(transcriptPath)};
        function record(message: unknown) { appendFileSync(transcriptPath, JSON.stringify({ method: (message as any).method, params: (message as any).params }) + "\\n"); }
        function write(message: unknown) { process.stdout.write(JSON.stringify(message) + "\\n"); }
        for await (const raw of readline.createInterface({ input: process.stdin })) {
          const message = JSON.parse(raw);
          record(message);
          if (message.method === "initialize") {
            write({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
          } else if (message.method === "session/new") {
            write({ jsonrpc: "2.0", id: message.id, result: { sessionId: "new-session" } });
          } else if (message.method === "session/load") {
            write({ jsonrpc: "2.0", id: message.id, result: { sessionId: message.params.sessionId } });
          }
        }
      `,
      "utf-8",
    );

    const mcpServers = [{ name: "plugin-mcp", command: "plugin-mcp", args: ["--stdio"] }];
    const client = new AcpClient(callbacks(), {
      cwd: root,
      command: "bun",
      args: [agentPath],
      mcpServers,
    });

    try {
      await client.connect();
      await client.newSession(root);
      await client.loadSession("existing-session", root);

      const requests = readFileSync(transcriptPath, "utf-8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      expect(requests.map((entry) => entry.method)).toEqual(["initialize", "session/new", "session/load"]);
      const expectedMcpServers = [{ name: "plugin-mcp", command: "plugin-mcp", args: ["--stdio"], env: [] }];
      expect(requests[1].params).toEqual({ cwd: root, mcpServers: expectedMcpServers });
      expect(requests[2].params).toEqual({ sessionId: "existing-session", cwd: root, mcpServers: expectedMcpServers });
    } finally {
      await client.disposeAsync();
    }
  });

  test("passes additional directories to advertised session lifecycle requests", async () => {
    const root = tmpRoot();
    const extraRoot = path.join(root, "extra");
    const secondRoot = path.join(root, "second");
    mkdirSync(extraRoot, { recursive: true });
    mkdirSync(secondRoot, { recursive: true });
    const agentPath = path.join(root, "agent.ts");
    const transcriptPath = path.join(root, "transcript.ndjson");

    writeFileSync(
      agentPath,
      `
        import { appendFileSync } from "node:fs";
        import * as readline from "node:readline";
        const transcriptPath = ${JSON.stringify(transcriptPath)};
        function record(message: unknown) { appendFileSync(transcriptPath, JSON.stringify({ method: (message as any).method, params: (message as any).params }) + "\\n"); }
        function write(message: unknown) { process.stdout.write(JSON.stringify(message) + "\\n"); }
        for await (const raw of readline.createInterface({ input: process.stdin })) {
          const message = JSON.parse(raw);
          record(message);
          if (message.method === "initialize") {
            write({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { additionalDirectories: {}, resume: {}, fork: {} } }, authMethods: [] } });
          } else if (message.method === "session/new") {
            write({ jsonrpc: "2.0", id: message.id, result: { sessionId: "new-session" } });
          } else if (message.method === "session/load") {
            write({ jsonrpc: "2.0", id: message.id, result: { sessionId: message.params.sessionId } });
          } else if (message.method === "session/resume") {
            write({ jsonrpc: "2.0", id: message.id, result: {} });
          } else if (message.method === "session/fork") {
            write({ jsonrpc: "2.0", id: message.id, result: { sessionId: "forked-session" } });
          }
        }
      `,
      "utf-8",
    );

    const client = new AcpClient(callbacks(), { cwd: root, command: "bun", args: [agentPath] });

    try {
      await client.connect();

      expect(client.supportsAdditionalDirectories()).toBe(true);
      expect(client.supportsSessionFork()).toBe(true);
      await client.newSession(root, [extraRoot, root, extraRoot]);
      await client.loadSession("loaded-session", root, [extraRoot, secondRoot]);
      await client.resumeSession("resumed-session", root, [secondRoot]);
      await client.forkSession(root, "new-session", [extraRoot]);

      const requests = readFileSync(transcriptPath, "utf-8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      expect(requests.map((entry) => entry.method)).toEqual([
        "initialize",
        "session/new",
        "session/load",
        "session/resume",
        "session/fork",
      ]);
      expect(requests[1].params.additionalDirectories).toEqual([extraRoot]);
      expect(requests[2].params.additionalDirectories).toEqual([extraRoot, secondRoot]);
      expect(requests[3].params.additionalDirectories).toEqual([secondRoot]);
      expect(requests[4].params.additionalDirectories).toEqual([extraRoot]);
    } finally {
      await client.disposeAsync();
    }
  });

  test("omits additional directories when the agent does not advertise support", async () => {
    const root = tmpRoot();
    const extraRoot = path.join(root, "extra");
    mkdirSync(extraRoot, { recursive: true });
    const agentPath = path.join(root, "agent.ts");
    const transcriptPath = path.join(root, "transcript.ndjson");

    writeFileSync(
      agentPath,
      `
        import { appendFileSync } from "node:fs";
        import * as readline from "node:readline";
        const transcriptPath = ${JSON.stringify(transcriptPath)};
        function record(message: unknown) { appendFileSync(transcriptPath, JSON.stringify({ method: (message as any).method, params: (message as any).params }) + "\\n"); }
        function write(message: unknown) { process.stdout.write(JSON.stringify(message) + "\\n"); }
        for await (const raw of readline.createInterface({ input: process.stdin })) {
          const message = JSON.parse(raw);
          record(message);
          if (message.method === "initialize") {
            write({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
          } else if (message.method === "session/new") {
            write({ jsonrpc: "2.0", id: message.id, result: { sessionId: "new-session" } });
          }
        }
      `,
      "utf-8",
    );

    const client = new AcpClient(callbacks(), { cwd: root, command: "bun", args: [agentPath] });

    try {
      await client.connect();

      expect(client.supportsAdditionalDirectories()).toBe(false);
      await client.newSession(root, [extraRoot]);

      const requests = readFileSync(transcriptPath, "utf-8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      expect(requests.map((entry) => entry.method)).toEqual(["initialize", "session/new"]);
      expect(requests[1].params).toEqual({ cwd: root, mcpServers: [] });
    } finally {
      await client.disposeAsync();
    }
  });

  test("resumes sessions with advertised session/resume support", async () => {
    const root = tmpRoot();
    const agentPath = path.join(root, "agent.ts");
    const transcriptPath = path.join(root, "transcript.ndjson");

    writeFileSync(
      agentPath,
      `
        import { appendFileSync } from "node:fs";
        import * as readline from "node:readline";
        const transcriptPath = ${JSON.stringify(transcriptPath)};
        function record(message: unknown) { appendFileSync(transcriptPath, JSON.stringify({ method: (message as any).method, params: (message as any).params }) + "\\n"); }
        function write(message: unknown) { process.stdout.write(JSON.stringify(message) + "\\n"); }
        for await (const raw of readline.createInterface({ input: process.stdin })) {
          const message = JSON.parse(raw);
          record(message);
          if (message.method === "initialize") {
            write({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } }, authMethods: [] } });
          } else if (message.method === "session/resume") {
            write({ jsonrpc: "2.0", id: message.id, result: { modes: { currentModeId: "review", availableModes: [{ id: "review", name: "Review" }] } } });
          }
        }
      `,
      "utf-8",
    );

    const client = new AcpClient(callbacks(), { cwd: root, command: "bun", args: [agentPath] });

    try {
      await client.connect();

      expect(client.supportsSessionLoad()).toBe(false);
      expect(client.supportsSessionResume()).toBe(true);
      await expect(client.resumeSession("existing-session", root)).resolves.toEqual({
        sessionId: "existing-session",
        modes: { currentModeId: "review", availableModes: [{ id: "review", name: "Review" }] },
      });
      expect(client.sessionId).toBe("existing-session");

      const requests = readFileSync(transcriptPath, "utf-8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      expect(requests.map((entry) => entry.method)).toEqual(["initialize", "session/resume"]);
      expect(requests[1].params).toEqual({ sessionId: "existing-session", cwd: root, mcpServers: [] });
    } finally {
      await client.disposeAsync();
    }
  });

  test("closes sessions with advertised session/close support", async () => {
    const root = tmpRoot();
    const agentPath = path.join(root, "agent.ts");
    const transcriptPath = path.join(root, "transcript.ndjson");

    writeFileSync(
      agentPath,
      `
        import { appendFileSync } from "node:fs";
        import * as readline from "node:readline";
        const transcriptPath = ${JSON.stringify(transcriptPath)};
        function record(message: unknown) { appendFileSync(transcriptPath, JSON.stringify({ method: (message as any).method, params: (message as any).params }) + "\\n"); }
        function write(message: unknown) { process.stdout.write(JSON.stringify(message) + "\\n"); }
        for await (const raw of readline.createInterface({ input: process.stdin })) {
          const message = JSON.parse(raw);
          record(message);
          if (message.method === "initialize") {
            write({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: {} } }, authMethods: [] } });
          } else if (message.method === "session/new") {
            write({ jsonrpc: "2.0", id: message.id, result: { sessionId: "session-to-close" } });
          } else if (message.method === "session/close") {
            write({ jsonrpc: "2.0", id: message.id, result: {} });
          }
        }
      `,
      "utf-8",
    );

    const client = new AcpClient(callbacks(), { cwd: root, command: "bun", args: [agentPath] });

    try {
      await client.connect();
      await client.newSession(root);

      expect(client.supportsSessionClose()).toBe(true);
      await client.closeSession("session-to-close");
      expect(client.sessionId).toBeNull();

      const requests = readFileSync(transcriptPath, "utf-8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      expect(requests.map((entry) => entry.method)).toEqual(["initialize", "session/new", "session/close"]);
      expect(requests[2].params).toEqual({ sessionId: "session-to-close" });
    } finally {
      await client.disposeAsync();
    }
  });

  test("rejects invalid MCP server config before starting the agent", async () => {
    const root = tmpRoot();
    const client = new AcpClient(callbacks(), {
      cwd: root,
      command: "bun",
      args: ["missing-agent.ts"],
      mcpServers: [{ name: "plugin-mcp", command: "plugin-mcp", env: { TOKEN: 42 } }],
    });

    await expect(client.connect()).rejects.toThrow("Invalid ACP MCP server env; expected string values");
  });

  test("reads session result available commands for slash completions", async () => {
    const root = tmpRoot();
    const agentPath = path.join(root, "agent.ts");
    const commands: unknown[] = [];

    writeFileSync(
      agentPath,
      `
        import * as readline from "node:readline";
        function write(message: unknown) { process.stdout.write(JSON.stringify(message) + "\\n"); }
        for await (const raw of readline.createInterface({ input: process.stdin })) {
          const message = JSON.parse(raw);
          if (message.method === "initialize") {
            write({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
          } else if (message.method === "session/new") {
            write({ jsonrpc: "2.0", id: message.id, result: { sessionId: "new-session", availableCommands: [{ name: "real-skill", description: "agent-owned skill" }] } });
          } else if (message.method === "session/load") {
            write({ jsonrpc: "2.0", id: message.id, result: { sessionId: message.params.sessionId, availableCommands: [{ name: "/loaded-skill", description: "loaded agent-owned skill" }] } });
          }
        }
      `,
      "utf-8",
    );

    const client = new AcpClient(
      callbacks({ onAvailableCommands: (availableCommands) => commands.push(availableCommands) }),
      {
        cwd: root,
        command: "bun",
        args: [agentPath],
      },
    );

    try {
      await client.connect();
      await client.newSession(root);
      await client.loadSession("existing-session", root);

      expect(commands).toEqual([
        [agentCommand("real-skill", "agent-owned skill")],
        [agentCommand("loaded-skill", "loaded agent-owned skill")],
      ]);
    } finally {
      await client.disposeAsync();
    }
  });

  test("publishes explicit empty session result commands", async () => {
    const root = tmpRoot();
    const agentPath = path.join(root, "agent.ts");
    const commands: unknown[] = [];

    writeFileSync(
      agentPath,
      `
        import * as readline from "node:readline";
        function write(message: unknown) { process.stdout.write(JSON.stringify(message) + "\\n"); }
        for await (const raw of readline.createInterface({ input: process.stdin })) {
          const message = JSON.parse(raw);
          if (message.method === "initialize") {
            write({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
          } else if (message.method === "session/new") {
            write({ jsonrpc: "2.0", id: message.id, result: { sessionId: "new-session", availableCommands: [] } });
          }
        }
      `,
      "utf-8",
    );

    const client = new AcpClient(
      callbacks({ onAvailableCommands: (availableCommands) => commands.push(availableCommands) }),
      {
        cwd: root,
        command: "bun",
        args: [agentPath],
      },
    );

    try {
      await client.connect();
      const result = await client.newSession(root);

      expect(commands).toEqual([[]]);
      expect(result.availableCommands).toEqual([]);
    } finally {
      await client.disposeAsync();
    }
  });

  test("keeps available command updates that arrive before a narrower session result", async () => {
    const root = tmpRoot();
    const agentPath = path.join(root, "agent.ts");
    const commands: unknown[] = [];

    writeFileSync(
      agentPath,
      `
        import * as readline from "node:readline";
        function write(message: unknown) { process.stdout.write(JSON.stringify(message) + "\\n"); }
        for await (const raw of readline.createInterface({ input: process.stdin })) {
          const message = JSON.parse(raw);
          if (message.method === "initialize") {
            write({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
          } else if (message.method === "session/new") {
            write({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "new-session", update: { sessionUpdate: "available_commands_update", availableCommands: [{ name: "copy", description: "built-in command" }, { name: "registry-skill", description: "cached registry command" }] } } });
            setTimeout(() => {
              write({ jsonrpc: "2.0", id: message.id, result: { sessionId: "new-session", availableCommands: [{ name: "copy", description: "built-in command" }] } });
            }, 25);
          }
        }
      `,
      "utf-8",
    );

    const client = new AcpClient(
      callbacks({ onAvailableCommands: (availableCommands) => commands.push(availableCommands) }),
      {
        cwd: root,
        command: "bun",
        args: [agentPath],
      },
    );

    try {
      await client.connect();
      const result = await client.newSession(root);

      expect(commands).toEqual([
        [agentCommand("copy", "built-in command"), agentCommand("registry-skill", "cached registry command")],
      ]);
      expect(result.availableCommands).toEqual([
        agentCommand("copy", "built-in command"),
        agentCommand("registry-skill", "cached registry command"),
      ]);
    } finally {
      await client.disposeAsync();
    }
  });

  test("restores matching command updates after a stale update races the session result", async () => {
    const root = tmpRoot();
    const agentPath = path.join(root, "agent.ts");
    const commands: unknown[] = [];
    const updates: unknown[] = [];

    writeFileSync(
      agentPath,
      `
        import * as readline from "node:readline";
        function write(message: unknown) { process.stdout.write(JSON.stringify(message) + "\\n"); }
        for await (const raw of readline.createInterface({ input: process.stdin })) {
          const message = JSON.parse(raw);
          if (message.method === "initialize") {
            write({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
          } else if (message.method === "session/new") {
            write({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "new-session", update: { sessionUpdate: "available_commands_update", availableCommands: [{ name: "copy", description: "built-in command" }, { name: "registry-skill", description: "cached registry command" }] } } });
            write({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "old-session", update: { sessionUpdate: "available_commands_update", availableCommands: [{ name: "old-skill", description: "stale command" }] } } });
            setTimeout(() => {
              write({ jsonrpc: "2.0", id: message.id, result: { sessionId: "new-session", availableCommands: [{ name: "copy", description: "built-in command" }] } });
            }, 25);
          }
        }
      `,
      "utf-8",
    );

    const client = new AcpClient(
      callbacks({
        onSessionUpdate: (update) => updates.push(update),
        onAvailableCommands: (availableCommands) => commands.push(availableCommands),
      }),
      {
        cwd: root,
        command: "bun",
        args: [agentPath],
      },
    );

    try {
      await client.connect();
      const result = await client.newSession(root);
      const expectedCommands = [
        agentCommand("copy", "built-in command"),
        agentCommand("registry-skill", "cached registry command"),
      ];

      expect(updates).toHaveLength(1);
      expect(updates[0]).toMatchObject({
        availableCommands: [
          { name: "copy", description: "built-in command" },
          { name: "registry-skill", description: "cached registry command" },
        ],
      });
      expect(commands).not.toContainEqual([{ name: "old-skill", description: "stale command" }]);
      expect(commands[commands.length - 1]).toEqual(expectedCommands);
      expect(result.availableCommands).toEqual(expectedCommands);
    } finally {
      await client.disposeAsync();
    }
  });

  test("keeps available command updates when load returns a canonical session id", async () => {
    const root = tmpRoot();
    const agentPath = path.join(root, "agent.ts");
    const commands: unknown[] = [];

    writeFileSync(
      agentPath,
      `
        import * as readline from "node:readline";
        function write(message: unknown) { process.stdout.write(JSON.stringify(message) + "\\n"); }
        for await (const raw of readline.createInterface({ input: process.stdin })) {
          const message = JSON.parse(raw);
          if (message.method === "initialize") {
            write({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
          } else if (message.method === "session/load") {
            write({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "canonical-session", update: { sessionUpdate: "available_commands_update", availableCommands: [{ name: "canonical-skill", description: "canonical command" }] } } });
            setTimeout(() => {
              write({ jsonrpc: "2.0", id: message.id, result: { sessionId: "canonical-session" } });
            }, 25);
          }
        }
      `,
      "utf-8",
    );

    const client = new AcpClient(
      callbacks({ onAvailableCommands: (availableCommands) => commands.push(availableCommands) }),
      {
        cwd: root,
        command: "bun",
        args: [agentPath],
      },
    );

    try {
      await client.connect();
      const result = await client.loadSession("requested-session", root);

      expect(commands).toEqual([[agentCommand("canonical-skill", "canonical command")]]);
      expect(result.availableCommands).toEqual([agentCommand("canonical-skill", "canonical command")]);
    } finally {
      await client.disposeAsync();
    }
  });

  test("keeps requested-id available command updates when load returns a canonical session id", async () => {
    const root = tmpRoot();
    const agentPath = path.join(root, "agent.ts");
    const commands: unknown[] = [];

    writeFileSync(
      agentPath,
      `
        import * as readline from "node:readline";
        function write(message: unknown) { process.stdout.write(JSON.stringify(message) + "\\n"); }
        for await (const raw of readline.createInterface({ input: process.stdin })) {
          const message = JSON.parse(raw);
          if (message.method === "initialize") {
            write({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
          } else if (message.method === "session/load") {
            write({ jsonrpc: "2.0", method: "session/update", params: { sessionId: message.params.sessionId, update: { sessionUpdate: "available_commands_update", availableCommands: [{ name: "requested-skill", description: "requested command" }] } } });
            setTimeout(() => {
              write({ jsonrpc: "2.0", id: message.id, result: { sessionId: "canonical-session" } });
            }, 25);
          }
        }
      `,
      "utf-8",
    );

    const client = new AcpClient(
      callbacks({ onAvailableCommands: (availableCommands) => commands.push(availableCommands) }),
      {
        cwd: root,
        command: "bun",
        args: [agentPath],
      },
    );

    try {
      await client.connect();
      const result = await client.loadSession("requested-session", root);

      expect(commands[commands.length - 1]).toEqual([agentCommand("requested-skill", "requested command")]);
      expect(result.availableCommands).toEqual([agentCommand("requested-skill", "requested command")]);
    } finally {
      await client.disposeAsync();
    }
  });

  test("reads replayed available commands from loadSessionHistory", async () => {
    const root = tmpRoot();
    const agentPath = path.join(root, "agent.ts");
    const commands: unknown[] = [];

    writeFileSync(
      agentPath,
      `
        import * as readline from "node:readline";
        function write(message: unknown) { process.stdout.write(JSON.stringify(message) + "\\n"); }
        for await (const raw of readline.createInterface({ input: process.stdin })) {
          const message = JSON.parse(raw);
          if (message.method === "initialize") {
            write({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
          } else if (message.method === "session/load") {
            write({ jsonrpc: "2.0", id: message.id, result: { sessionId: message.params.sessionId } });
            setTimeout(() => {
              write({ jsonrpc: "2.0", method: "session/update", params: { sessionId: message.params.sessionId, update: { sessionUpdate: "available_commands_update", availableCommands: [{ name: "review", description: "review skill" }] } } });
            }, 0);
          }
        }
      `,
      "utf-8",
    );

    const client = new AcpClient(
      callbacks({ onAvailableCommands: (availableCommands) => commands.push(availableCommands) }),
      {
        cwd: root,
        command: "bun",
        args: [agentPath],
      },
    );

    try {
      await client.connect();
      const loaded = await client.loadSessionHistory("existing-session", root);

      expect(commands).toEqual([[agentCommand("review", "review skill")]]);
      expect(loaded.result.availableCommands).toEqual([agentCommand("review", "review skill")]);
    } finally {
      await client.disposeAsync();
    }
  });

  test("hands streamed history to onHistoryReady before a slow load response", async () => {
    const root = tmpRoot();
    const agentPath = path.join(root, "agent.ts");
    writeFileSync(
      agentPath,
      `
        import * as readline from "node:readline";
        function write(message: unknown) { process.stdout.write(JSON.stringify(message) + "\\n"); }
        const chunk = (sessionId: string, text: string) => ({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
        for await (const raw of readline.createInterface({ input: process.stdin })) {
          const message = JSON.parse(raw);
          if (message.method === "initialize") {
            write({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] } });
          } else if (message.method === "session/load") {
            const { sessionId } = message.params;
            write({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "available_commands_update", availableCommands: [] } } });
            await new Promise((resolve) => setTimeout(resolve, 200));
            write(chunk(sessionId, "one"));
            write(chunk(sessionId, "two"));
            setTimeout(() => {
              write(chunk(sessionId, "three"));
              write({ jsonrpc: "2.0", id: message.id, result: { sessionId } });
            }, 600);
          }
        }
      `,
      "utf-8",
    );
    const client = new AcpClient(callbacks(), { cwd: root, command: "bun", args: [agentPath] });
    const early: unknown[][] = [];
    let loaded = false;

    try {
      await client.connect();
      const result = await client.loadSessionHistory("slow-session", root, [], {
        onHistoryReady: (updates) => early.push([loaded, ...updates.map((update) => textFromUpdate(update))]),
      });
      loaded = true;

      expect(early).toEqual([[false, undefined, "one", "two"]]);
      expect(result.updates.map((update) => textFromUpdate(update))).toEqual([undefined, "one", "two", "three"]);
    } finally {
      await client.disposeAsync();
    }
  });

  test("skips onHistoryReady when the load responds before history goes quiet", async () => {
    const root = tmpRoot();
    const agentPath = path.join(root, "agent.ts");
    writeFileSync(
      agentPath,
      `
        import * as readline from "node:readline";
        function write(message: unknown) { process.stdout.write(JSON.stringify(message) + "\\n"); }
        for await (const raw of readline.createInterface({ input: process.stdin })) {
          const message = JSON.parse(raw);
          if (message.method === "initialize") {
            write({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] } });
          } else if (message.method === "session/load") {
            const { sessionId } = message.params;
            write({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "fast" } } } });
            write({ jsonrpc: "2.0", id: message.id, result: { sessionId } });
          }
        }
      `,
      "utf-8",
    );
    const client = new AcpClient(callbacks(), { cwd: root, command: "bun", args: [agentPath] });
    let earlyCalls = 0;

    try {
      await client.connect();
      const result = await client.loadSessionHistory("fast-session", root, [], { onHistoryReady: () => earlyCalls++ });
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(earlyCalls).toBe(0);
      expect(result.updates.map((update) => textFromUpdate(update))).toEqual(["fast"]);
    } finally {
      await client.disposeAsync();
    }
  });

  test("keeps replayed available commands when history load returns a canonical session id", async () => {
    const root = tmpRoot();
    const agentPath = path.join(root, "agent.ts");
    const commands: unknown[] = [];

    writeFileSync(
      agentPath,
      `
        import * as readline from "node:readline";
        function write(message: unknown) { process.stdout.write(JSON.stringify(message) + "\\n"); }
        for await (const raw of readline.createInterface({ input: process.stdin })) {
          const message = JSON.parse(raw);
          if (message.method === "initialize") {
            write({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
          } else if (message.method === "session/load") {
            write({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "canonical-session", update: { sessionUpdate: "available_commands_update", availableCommands: [{ name: "history-skill", description: "history command" }] } } });
            setTimeout(() => {
              write({ jsonrpc: "2.0", id: message.id, result: { sessionId: "canonical-session" } });
            }, 25);
          }
        }
      `,
      "utf-8",
    );

    const client = new AcpClient(
      callbacks({ onAvailableCommands: (availableCommands) => commands.push(availableCommands) }),
      {
        cwd: root,
        command: "bun",
        args: [agentPath],
      },
    );

    try {
      await client.connect();
      const loaded = await client.loadSessionHistory("requested-session", root);

      expect(commands).toEqual([[agentCommand("history-skill", "history command")]]);
      expect(loaded.result.availableCommands).toEqual([agentCommand("history-skill", "history command")]);
      expect(loaded.updates).toEqual([
        {
          sessionUpdate: "available_commands_update",
          availableCommands: [{ name: "history-skill", description: "history command" }],
        },
      ]);
    } finally {
      await client.disposeAsync();
    }
  });

  test("listSessions follows cursor pagination", async () => {
    const root = tmpRoot();
    const agentPath = path.join(root, "agent.ts");
    const transcriptPath = path.join(root, "session-list.ndjson");

    writeFileSync(
      agentPath,
      `
        import { appendFileSync } from "node:fs";
        import * as readline from "node:readline";
        const transcriptPath = ${JSON.stringify(transcriptPath)};
        function record(params: unknown) { appendFileSync(transcriptPath, JSON.stringify(params ?? {}) + "\\n"); }
        function write(message: unknown) { process.stdout.write(JSON.stringify(message) + "\\n"); }
        for await (const raw of readline.createInterface({ input: process.stdin })) {
          const message = JSON.parse(raw);
          if (message.method === "initialize") {
            write({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { list: {} } }, authMethods: [] } });
          } else if (message.method === "session/list") {
            const cursor = typeof message.params?.cursor === "string" ? message.params.cursor : null;
            record(message.params);
            if (cursor === null) {
              write({
                jsonrpc: "2.0",
                id: message.id,
                result: {
                  sessions: [{ sessionId: "page-1", title: "Page 1" }],
                  nextCursor: "page-2",
                },
              });
            } else if (cursor === "page-2") {
              write({
                jsonrpc: "2.0",
                id: message.id,
                result: {
                  sessions: [],
                  nextCursor: "page-3",
                },
              });
            } else {
              write({
                jsonrpc: "2.0",
                id: message.id,
                result: {
                  sessions: [{ sessionId: "page-3", title: "Page 3" }],
                  nextCursor: null,
                },
              });
            }
          }
        }
      `,
      "utf-8",
    );

    const client = new AcpClient(callbacks(), { cwd: root, command: "bun", args: [agentPath] });

    try {
      await client.connect();
      await expect(client.listSessions()).resolves.toEqual([
        { sessionId: "page-1", title: "Page 1" },
        { sessionId: "page-3", title: "Page 3" },
      ]);

      const listRequests = readFileSync(transcriptPath, "utf-8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      expect(listRequests).toEqual([{}, { cursor: "page-2" }, { cursor: "page-3" }]);
    } finally {
      await client.disposeAsync();
    }
  });

  test("listSessions leaves Alta session scope at the current-cwd default across pagination", async () => {
    const root = tmpRoot();
    const agentPath = path.join(root, "agent.ts");
    const transcriptPath = path.join(root, "alta-session-list.ndjson");

    writeFileSync(
      agentPath,
      `
        import { appendFileSync } from "node:fs";
        import * as readline from "node:readline";
        const transcriptPath = ${JSON.stringify(transcriptPath)};
        function write(message: unknown) { process.stdout.write(JSON.stringify(message) + "\\n"); }
        for await (const raw of readline.createInterface({ input: process.stdin })) {
          const message = JSON.parse(raw);
          if (message.method === "initialize") {
            write({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { list: {} } }, authMethods: [] } });
          } else if (message.method === "session/list") {
            appendFileSync(transcriptPath, JSON.stringify(message.params ?? {}) + "\\n");
            const cursor = typeof message.params?.cursor === "string" ? message.params.cursor : null;
            if (cursor === null) {
              write({ jsonrpc: "2.0", id: message.id, result: { sessions: [{ sessionId: "current-page", title: "Current page" }], nextCursor: "next-page" } });
            } else {
              write({ jsonrpc: "2.0", id: message.id, result: { sessions: [{ sessionId: "next-page", title: "Next page" }], nextCursor: null } });
            }
          }
        }
      `,
      "utf-8",
    );

    const client = new AcpClient(callbacks(), {
      cwd: root,
      command: "bun",
      args: [agentPath],
      agentBehaviorProfile: altaAgentBehaviorProfile,
    });

    try {
      await client.connect();
      await expect(client.listSessions()).resolves.toEqual([
        { sessionId: "current-page", title: "Current page" },
        { sessionId: "next-page", title: "Next page" },
      ]);
      const requests = readFileSync(transcriptPath, "utf-8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      expect(requests).toEqual([{}, { cursor: "next-page" }]);
    } finally {
      await client.disposeAsync();
    }
  });

  test("listSessions accepts bare array ACP responses", async () => {
    const root = tmpRoot();
    const agentPath = path.join(root, "agent.ts");

    writeFileSync(
      agentPath,
      `
        import * as readline from "node:readline";
        function write(message: unknown) { process.stdout.write(JSON.stringify(message) + "\\n"); }
        for await (const raw of readline.createInterface({ input: process.stdin })) {
          const message = JSON.parse(raw);
          if (message.method === "initialize") {
            write({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
          } else if (message.method === "session/list") {
            write({ jsonrpc: "2.0", id: message.id, result: [{ sessionId: "bare", title: "Bare" }] });
          }
        }
      `,
      "utf-8",
    );

    const client = new AcpClient(callbacks(), { cwd: root, command: "bun", args: [agentPath] });

    try {
      await client.connect();
      await expect(client.listSessions()).resolves.toEqual([{ sessionId: "bare", title: "Bare" }]);
    } finally {
      await client.disposeAsync();
    }
  });

  test("loadSession uses canonical session id returned by ACP", async () => {
    const root = tmpRoot();
    const agentPath = path.join(root, "agent.ts");

    writeFileSync(
      agentPath,
      `
        import * as readline from "node:readline";
        function write(message: unknown) { process.stdout.write(JSON.stringify(message) + "\\n"); }
        for await (const raw of readline.createInterface({ input: process.stdin })) {
          const message = JSON.parse(raw);
          if (message.method === "initialize") {
            write({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
          } else if (message.method === "session/load") {
            write({ jsonrpc: "2.0", id: message.id, result: { sessionId: "canonical-session" } });
          } else if (message.method === "session/prompt") {
            write({ jsonrpc: "2.0", id: message.id, result: {} });
          }
        }
      `,
      "utf-8",
    );

    const client = new AcpClient(callbacks(), { cwd: root, command: "bun", args: [agentPath] });

    try {
      await client.connect();
      await expect(client.loadSession("alias-session", root)).resolves.toEqual({ sessionId: "canonical-session" });
      expect(client.sessionId).toBe("canonical-session");
    } finally {
      await client.disposeAsync();
    }
  });

  test("foreground session updates from stale session ids are ignored", async () => {
    const root = tmpRoot();
    const agentPath = path.join(root, "agent.ts");
    const updates: unknown[] = [];

    writeFileSync(
      agentPath,
      `
        import * as readline from "node:readline";
        function write(message: unknown) { process.stdout.write(JSON.stringify(message) + "\\n"); }
        for await (const raw of readline.createInterface({ input: process.stdin })) {
          const message = JSON.parse(raw);
          if (message.method === "initialize") {
            write({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
          } else if (message.method === "session/new") {
            write({ jsonrpc: "2.0", id: message.id, result: { sessionId: "active-session" } });
            write({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "stale-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "stale" } } } });
            write({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "active-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "active" } } } });
          }
        }
      `,
      "utf-8",
    );

    const client = new AcpClient(
      { ...callbacks(), onSessionUpdate: (update) => updates.push(update) },
      {
        cwd: root,
        command: "bun",
        args: [agentPath],
      },
    );

    try {
      await client.connect();
      await client.newSession(root);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(updates).toHaveLength(1);
      expect(updates[0]).toMatchObject({ content: { text: "active" } });
    } finally {
      await client.disposeAsync();
    }
  });

  test("loadSession accepts replay updates for the requested session before the response resolves", async () => {
    const root = tmpRoot();
    const agentPath = path.join(root, "agent.ts");
    const updates: unknown[] = [];

    writeFileSync(
      agentPath,
      `
        import * as readline from "node:readline";
        function write(message: unknown) { process.stdout.write(JSON.stringify(message) + "\\n"); }
        for await (const raw of readline.createInterface({ input: process.stdin })) {
          const message = JSON.parse(raw);
          if (message.method === "initialize") {
            write({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
          } else if (message.method === "session/new") {
            write({ jsonrpc: "2.0", id: message.id, result: { sessionId: "old-session" } });
          } else if (message.method === "session/load") {
            write({ jsonrpc: "2.0", method: "session/update", params: { sessionId: message.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "loaded" } } } });
            setTimeout(() => write({ jsonrpc: "2.0", id: message.id, result: { sessionId: message.params.sessionId } }), 5);
          }
        }
      `,
      "utf-8",
    );

    const client = new AcpClient(
      { ...callbacks(), onSessionUpdate: (update) => updates.push(update) },
      {
        cwd: root,
        command: "bun",
        args: [agentPath],
      },
    );

    try {
      await client.connect();
      await client.newSession(root);
      await client.loadSession("loaded-session", root);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(updates).toHaveLength(1);
      expect(updates[0]).toMatchObject({ content: { text: "loaded" } });
    } finally {
      await client.disposeAsync();
    }
  });

  test("loadSession accepts replay updates for a canonical session id before the response resolves", async () => {
    const root = tmpRoot();
    const agentPath = path.join(root, "agent.ts");
    const updates: unknown[] = [];

    writeFileSync(
      agentPath,
      `
        import * as readline from "node:readline";
        function write(message: unknown) { process.stdout.write(JSON.stringify(message) + "\\n"); }
        for await (const raw of readline.createInterface({ input: process.stdin })) {
          const message = JSON.parse(raw);
          if (message.method === "initialize") {
            write({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
          } else if (message.method === "session/load") {
            write({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "canonical-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "canonical loaded" } } } });
            setTimeout(() => write({ jsonrpc: "2.0", id: message.id, result: { sessionId: "canonical-session" } }), 5);
          }
        }
      `,
      "utf-8",
    );

    const client = new AcpClient(
      { ...callbacks(), onSessionUpdate: (update) => updates.push(update) },
      {
        cwd: root,
        command: "bun",
        args: [agentPath],
      },
    );

    try {
      await client.connect();
      await client.loadSession("alias-session", root);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(updates).toHaveLength(1);
      expect(updates[0]).toMatchObject({ content: { text: "canonical loaded" } });
    } finally {
      await client.disposeAsync();
    }
  });

  test("loadSessionHistory captures canonical replay updates after the response without forwarding them live", async () => {
    const root = tmpRoot();
    const agentPath = path.join(root, "agent.ts");
    const liveUpdates: unknown[] = [];

    writeFileSync(
      agentPath,
      `
        import * as readline from "node:readline";
        function write(message: unknown) { process.stdout.write(JSON.stringify(message) + "\\n"); }
        for await (const raw of readline.createInterface({ input: process.stdin })) {
          const message = JSON.parse(raw);
          if (message.method === "initialize") {
            write({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
          } else if (message.method === "session/new") {
            write({ jsonrpc: "2.0", id: message.id, result: { sessionId: "old-session" } });
          } else if (message.method === "session/load") {
            write({ jsonrpc: "2.0", method: "session/update", params: { sessionId: message.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "requested" } } } });
            write({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "other-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "other" } } } });
            setTimeout(() => {
              write({ jsonrpc: "2.0", id: message.id, result: { sessionId: "canonical-session" } });
              setTimeout(() => {
                write({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "canonical-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "canonical" } } } });
              }, 25);
            }, 5);
          }
        }
      `,
      "utf-8",
    );

    const client = new AcpClient(
      { ...callbacks(), onSessionUpdate: (update) => liveUpdates.push(update) },
      { cwd: root, command: "bun", args: [agentPath] },
    );

    try {
      await client.connect();
      await client.newSession(root);
      const loaded = await client.loadSessionHistory("loaded-session", root);
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(loaded.result).toEqual({ sessionId: "canonical-session" });
      expect(loaded.updates).toHaveLength(2);
      expect(loaded.updates).toEqual([
        expect.objectContaining({ content: { type: "text", text: "requested" } }),
        expect.objectContaining({ content: { type: "text", text: "canonical" } }),
      ]);
      expect(liveUpdates).toHaveLength(0);
      expect(client.sessionId).toBe("canonical-session");
    } finally {
      await client.disposeAsync();
    }
  });

  test("applies prompt image policy only for selected behavior profile", async () => {
    const root = tmpRoot();
    const agentPath = path.join(root, "agent.ts");
    const promptLogPath = path.join(root, "prompts.ndjson");
    const imgPath = path.join(root, "pattern.png");
    writeFileSync(
      imgPath,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        "base64",
      ),
    );

    writeFileSync(
      agentPath,
      `
        import { appendFileSync } from "node:fs";
        import * as readline from "node:readline";
        const promptLogPath = ${JSON.stringify(promptLogPath)};
        function write(message: unknown) { process.stdout.write(JSON.stringify(message) + "\\n"); }
        for await (const raw of readline.createInterface({ input: process.stdin })) {
          const message = JSON.parse(raw);
          if (message.method === "initialize") {
            write({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                protocolVersion: 1,
                agentCapabilities: { promptCapabilities: { image: true } },
                authMethods: [],
              },
            });
          } else if (message.method === "session/new") {
            write({ jsonrpc: "2.0", id: message.id, result: { sessionId: "session-1" } });
          } else if (message.method === "session/prompt") {
            appendFileSync(promptLogPath, JSON.stringify(message.params) + "\\n");
            write({ jsonrpc: "2.0", id: message.id, result: {} });
          }
        }
      `,
      "utf-8",
    );

    const defaultProfileClient = new AcpClient(callbacks(), {
      cwd: root,
      command: "bun",
      args: [agentPath],
    });

    try {
      await defaultProfileClient.connect();
      await defaultProfileClient.newSession(root);
      await defaultProfileClient.prompt(`look @${imgPath}`);
    } finally {
      await defaultProfileClient.disposeAsync();
    }

    const altaProfileClient = new AcpClient(callbacks(), {
      cwd: root,
      command: "bun",
      args: [agentPath],
      agentBehaviorProfile: altaAgentBehaviorProfile,
    });

    try {
      await altaProfileClient.connect();
      await altaProfileClient.newSession(root);
      await altaProfileClient.prompt(`look @${imgPath}`);
    } finally {
      await altaProfileClient.disposeAsync();
    }

    type PromptLogEntry = {
      readonly prompt?: readonly {
        readonly type?: string;
        readonly text?: string;
        readonly uri?: string;
      }[];
    };
    const prompts = readFileSync(promptLogPath, "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as PromptLogEntry);
    const defaultPrompt = prompts[0]?.prompt ?? [];
    const altaPrompt = prompts[1]?.prompt ?? [];

    expect(defaultPrompt.map((block) => block.type)).toEqual(["text", "image"]);
    expect(defaultPrompt.some((block) => block.type === "text" && block.text === ALTA_IMAGE_ATTACHMENT_NOTE)).toBe(
      false,
    );
    expect(defaultPrompt[1]?.uri).toBe(`file://${imgPath}`);
    expect(altaPrompt.map((block) => block.type)).toEqual(["text", "text", "image"]);
    expect(altaPrompt[1]).toEqual({ type: "text", text: ALTA_IMAGE_ATTACHMENT_NOTE });
    expect(altaPrompt[2]?.uri).toBe(`file://${imgPath}`);
  });

  test("detects advertised Alta steering metadata without requiring the Alta profile", async () => {
    const root = tmpRoot();
    const agentPath = path.join(root, "agent.ts");
    const guidancePath = path.join(root, "active-turn-input.json");

    writeFileSync(
      agentPath,
      `
        import { writeFileSync } from "node:fs";
        import * as readline from "node:readline";
        function write(message: unknown) { process.stdout.write(JSON.stringify(message) + "\\n"); }
        for await (const raw of readline.createInterface({ input: process.stdin })) {
          const message = JSON.parse(raw);
          if (message.method === "initialize") {
            write({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                protocolVersion: 1,
                agentCapabilities: { _meta: { "alta/steer": { version: "0.1.0" } } },
                authMethods: [],
              },
            });
          } else if (message.method === "session/new") {
            write({ jsonrpc: "2.0", id: message.id, result: { sessionId: "session-1" } });
          } else if (message.method === "session/prompt") {
            writeFileSync(${JSON.stringify(guidancePath)}, JSON.stringify(message.params));
            write({ jsonrpc: "2.0", id: message.id, result: { _meta: { "alta/steer": { accepted: true } } } });
          }
        }
      `,
      "utf-8",
    );

    const client = new AcpClient(callbacks(), {
      cwd: root,
      command: "bun",
      args: [agentPath],
    });

    try {
      await client.connect();
      expect(client.supportsActiveTurnInput()).toBe(true);
      await client.newSession(root);
      await expect(client.sendActiveTurnInput("guide current turn")).resolves.toEqual({ accepted: true });
      expect(JSON.parse(readFileSync(guidancePath, "utf-8"))).toEqual({
        sessionId: "session-1",
        prompt: [{ type: "text", text: "guide current turn" }],
        _meta: { "alta/steer": {} },
      });
    } finally {
      await client.disposeAsync();
    }
  });

  test("does not enable active-turn input from the Alta profile without an advertised capability", async () => {
    const root = tmpRoot();
    const agentPath = path.join(root, "agent.ts");

    writeFileSync(
      agentPath,
      `
        import * as readline from "node:readline";
        function write(message: unknown) { process.stdout.write(JSON.stringify(message) + "\\n"); }
        for await (const raw of readline.createInterface({ input: process.stdin })) {
          const message = JSON.parse(raw);
          if (message.method === "initialize") {
            write({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                protocolVersion: 1,
                agentCapabilities: {},
                authMethods: [],
              },
            });
          } else if (message.method === "session/new") {
            write({ jsonrpc: "2.0", id: message.id, result: { sessionId: "session-1" } });
          }
        }
      `,
      "utf-8",
    );

    const client = new AcpClient(callbacks(), {
      cwd: root,
      command: "bun",
      args: [agentPath],
      agentBehaviorProfile: altaAgentBehaviorProfile,
    });

    try {
      await client.connect();
      expect(client.supportsActiveTurnInput()).toBe(false);
      await client.newSession(root);
      await expect(client.sendActiveTurnInput("profile alone should not steer")).resolves.toEqual({
        accepted: false,
        reason: "Active-turn input is not supported",
      });
    } finally {
      await client.disposeAsync();
    }
  });
});

function textFromUpdate(update: unknown): string | undefined {
  const content = (update as { content?: { text?: unknown } }).content;
  return typeof content?.text === "string" ? content.text : undefined;
}
