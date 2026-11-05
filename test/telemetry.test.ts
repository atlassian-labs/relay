import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { agentLabelForLaunch, isToolCallUpdate, TelemetryState } from "../src/telemetry";
import { VERSION } from "../src/version";

const tmpRoots: string[] = [];
const originalCaptureFile = process.env.RELAY_TELEMETRY_CAPTURE_FILE;
const originalDoNotTrack = process.env.DO_NOT_TRACK;
const originalRelayDisabled = process.env.RELAY_TELEMETRY_DISABLED;
const originalHome = process.env.HOME;
const originalConfigDir = process.env.RELAY_CONFIG_DIR;

/**
 * Telemetry is opt-in, so a capture test has to record consent first. Without
 * it the runtime is a no-op and nothing is written.
 */
function grantTelemetryConsent(dir: string): void {
  writeFileSync(path.join(dir, "telemetry-consent"), "true", "utf-8");
  setEnv("RELAY_CONFIG_DIR", dir);
}

function tmpRoot(): string {
  const dir = path.join(tmpdir(), `relay-telemetry-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  tmpRoots.push(dir);
  return dir;
}

function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

afterEach(() => {
  setEnv("RELAY_TELEMETRY_CAPTURE_FILE", originalCaptureFile);
  setEnv("DO_NOT_TRACK", originalDoNotTrack);
  setEnv("RELAY_TELEMETRY_DISABLED", originalRelayDisabled);
  setEnv("HOME", originalHome);
  setEnv("RELAY_CONFIG_DIR", originalConfigDir);
  while (tmpRoots.length > 0) rmSync(tmpRoots.pop()!, { recursive: true, force: true });
});

describe("telemetry", () => {
  test("hourly capture contains aggregate usage only", async () => {
    const dir = tmpRoot();
    const capture = path.join(dir, "capture.jsonl");
    setEnv("HOME", dir);
    setEnv("RELAY_TELEMETRY_CAPTURE_FILE", capture);
    setEnv("DO_NOT_TRACK", undefined);
    setEnv("RELAY_TELEMETRY_DISABLED", undefined);
    grantTelemetryConsent(dir);

    const state = new TelemetryState(dir);
    state.startRuntime("runtime-1", "Rovo Dev");
    state.recordMessage("runtime-1");
    state.recordSessionUpdate("runtime-1", { sessionUpdate: "tool_call", toolCallId: "tool-1" });
    state.recordSessionUpdate("runtime-1", { sessionUpdate: "tool_call_update", toolCallId: "tool-1" });
    state.recordSlashCommand("/model gpt-5");
    state.recordSlashCommand("model gpt-5");
    state.recordSlashCommand("/plugins");
    state.finishRuntime("runtime-1", "normal");
    await state.flushPending();

    const line = readFileSync(capture, "utf-8").trim();
    const batch: unknown = JSON.parse(line);
    expect(isRecord(batch)).toBe(true);
    const events = isRecord(batch) && Array.isArray(batch.batch) ? batch.batch : [];
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(isRecord(event)).toBe(true);
    if (!isRecord(event)) return;
    expect(event.event).toBe("relay_hourly_usage summarized");
    expect(typeof event.messageId).toBe("string");
    const properties = isRecord(event.properties) ? event.properties : {};
    const attributes = isRecord(properties.attributes) ? properties.attributes : {};
    expect(properties.product).toBe("rovodev");
    const context = isRecord(event.context) ? event.context : {};
    const library = isRecord(context.library) ? context.library : {};
    expect(library.name).toBe("analytics.js");
    expect(library.version).toBe(VERSION);
    expect(attributes.relayVersion).toBe(VERSION);
    expect(attributes.messageCount).toBe(1);
    expect(attributes.toolCallCount).toBe(1);
    expect(attributes.slashCommandCount).toBe(3);
    expect(attributes.slashCommandUsage).toEqual([
      { command: "model", count: 2 },
      { command: "plugins", count: 1 },
    ]);
    expect(attributes.endedNormalCount).toBe(1);
    expect(attributes.primaryAgent).toBe("Rovo Dev");
    expect(attributes.prompt).toBeUndefined();
    expect(attributes.response).toBeUndefined();
    expect(attributes.toolArgs).toBeUndefined();
    expect(attributes.sessionId).toBeUndefined();
    expect(attributes.accountId).toBeUndefined();
    expect(attributes.anonymousId).toBeUndefined();
    expect(existsSync(path.join(dir, "telemetry-pending.json"))).toBe(false);
  });

  test("detects only tool call start updates", () => {
    expect(isToolCallUpdate({ sessionUpdate: "tool_call" })).toBe(true);
    expect(isToolCallUpdate({ sessionUpdate: "tool_call_update" })).toBe(false);
    expect(isToolCallUpdate(null)).toBe(false);
  });

  test("normalizes agent labels from launch metadata", () => {
    expect(agentLabelForLaunch({ agentName: "Alta" })).toBe("Alta");
    expect(agentLabelForLaunch({ command: "acli", args: ["rovodev", "acp"] })).toBe("Rovo Dev");
    expect(agentLabelForLaunch({ command: "/opt/bin/claude-code" })).toBe("Claude");
    expect(agentLabelForLaunch({ transport: "websocket" })).toBe("websocket");
  });
});
