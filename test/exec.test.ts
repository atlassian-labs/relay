import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { runExec } from "../src/exec";
import { runTestEffect } from "./lib/effect";

const tmpRoots: string[] = [];

function tmpRoot(): string {
  const root = path.join(tmpdir(), `relay-exec-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(root, { recursive: true });
  tmpRoots.push(root);
  return root;
}

afterEach(() => {
  while (tmpRoots.length > 0) rmSync(tmpRoots.pop()!, { recursive: true, force: true });
});

function writeExecAgent(agentPath: string, transcriptPath: string): void {
  writeFileSync(
    agentPath,
    `
      import * as readline from "node:readline";
      import { appendFileSync } from "node:fs";
      const transcriptPath = ${JSON.stringify(transcriptPath)};
      function send(message) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n"); }
      function record(message) { appendFileSync(transcriptPath, JSON.stringify(message) + "\\n"); }
      for await (const line of readline.createInterface({ input: process.stdin })) {
        const message = JSON.parse(line);
        if (message.method === "initialize") {
          send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
        } else if (message.method === "session/new") {
          send({
            id: message.id,
            result: {
              sessionId: "exec-session",
              configOptions: [
                {
                  id: "model",
                  category: "model",
                  type: "select",
                  currentValue: "model-a",
                  options: [{ value: "model-a" }, { value: "model-b" }],
                },
                {
                  id: "thought_level",
                  category: "thought_level",
                  type: "select",
                  currentValue: "low",
                  options: [{ value: "low" }, { value: "high" }],
                },
              ],
            },
          });
        } else if (message.method === "session/set_config_option") {
          record({ method: message.method, params: message.params });
          send({ id: message.id, result: {} });
        } else if (message.method === "session/prompt") {
          record({ method: message.method, params: message.params });
          send({
            method: "session/update",
            params: {
              sessionId: "exec-session",
              update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello " } },
            },
          });
          send({
            method: "session/update",
            params: {
              sessionId: "exec-session",
              update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "world" } },
            },
          });
          send({ id: message.id, result: { stopReason: "end_turn" } });
        }
      }
    `,
    "utf-8",
  );
}

describe("runExec", () => {
  test("runs an ACP turn, applies model and thinking overrides, and prints only agent text", async () => {
    const root = tmpRoot();
    const agentPath = path.join(root, "agent.ts");
    const transcriptPath = path.join(root, "transcript.ndjson");
    writeExecAgent(agentPath, transcriptPath);
    const stdout: string[] = [];
    const stderr: string[] = [];
    let telemetryFlushes = 0;

    await runTestEffect(
      runExec(
        {
          cwd: root,
          prompt: "test prompt",
          acpCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(agentPath)}`,
          model: "model-b",
          thinkingLevel: "high",
        },
        {
          writeStdout: (text) => stdout.push(text),
          writeStderr: (text) => stderr.push(text),
          flushTelemetry: async () => {
            telemetryFlushes += 1;
          },
          installSignalHandlers: false,
        },
      ),
    );

    expect(stdout.join("")).toBe("hello world\n");
    expect(stderr).toEqual([]);
    expect(telemetryFlushes).toBe(1);
    const transcript = readFileSync(transcriptPath, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(transcript.slice(0, 2).map((entry) => entry.params)).toEqual([
      { sessionId: "exec-session", configId: "model", value: "model-b" },
      { sessionId: "exec-session", configId: "thought_level", value: "high" },
    ]);
    expect(transcript[2].method).toBe("session/prompt");
  });

  test("rejects an unavailable explicit model before prompting", async () => {
    const root = tmpRoot();
    const agentPath = path.join(root, "agent.ts");
    const transcriptPath = path.join(root, "transcript.ndjson");
    writeExecAgent(agentPath, transcriptPath);
    let telemetryFlushes = 0;

    await expect(
      runTestEffect(
        runExec(
          {
            cwd: root,
            prompt: "test prompt",
            acpCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(agentPath)}`,
            model: "missing-model",
          },
          {
            flushTelemetry: async () => {
              telemetryFlushes += 1;
            },
            installSignalHandlers: false,
          },
        ),
      ),
    ).rejects.toThrow('Model "missing-model" is not available. Available values: model-a, model-b');
    expect(telemetryFlushes).toBe(1);
  });
});
