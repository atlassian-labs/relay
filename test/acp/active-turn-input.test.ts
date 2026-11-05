import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { activeTurnInputResult, resolveActiveTurnInputAdapter, steerMetaResult } from "../../src/acp/active-turn-input";
import { runTestEffect } from "../lib/effect";

interface RecordedCall {
  readonly kind: "prompt" | "custom";
  readonly method?: string;
  readonly params: unknown;
}

function recordingConnection(response: unknown) {
  const calls: RecordedCall[] = [];
  return {
    calls,
    connection: {
      prompt(params: unknown) {
        calls.push({ kind: "prompt", params });
        return Effect.succeed(response);
      },
      sendCustomRequest(method: string, params: Record<string, unknown>) {
        calls.push({ kind: "custom", method, params });
        return Effect.succeed(response);
      },
    },
  };
}

describe("active turn input extensions", () => {
  test("unknown extensions do not enable active-turn input", () => {
    expect(resolveActiveTurnInputAdapter({ agentCapabilities: { extensions: { "example/other": {} } } })).toBeNull();
    expect(resolveActiveTurnInputAdapter({ agentCapabilities: {} })).toBeNull();
    expect(resolveActiveTurnInputAdapter({ agentCapabilities: { _meta: { "example/other": {} } } })).toBeNull();
  });

  test("legacy ext adapter sends active-turn input through its custom ACP request", async () => {
    const adapter = resolveActiveTurnInputAdapter({
      agentCapabilities: { extensions: { "_alta/session/steer": { version: "0.1.0" } } },
    });

    expect(adapter).not.toBeNull();
    const { calls, connection } = recordingConnection({ accepted: true });

    await expect(
      runTestEffect(adapter!.send({ connection, sessionId: "session-1", text: "guide current turn" })),
    ).resolves.toEqual({ accepted: true });
    expect(calls).toEqual([
      {
        kind: "custom",
        method: "_alta/session/steer",
        params: { sessionId: "session-1", prompt: [{ type: "text", text: "guide current turn" }] },
      },
    ]);
  });

  test("steer-meta adapter steers through session/prompt with `alta/steer` _meta", async () => {
    const adapter = resolveActiveTurnInputAdapter({
      agentCapabilities: { _meta: { "alta/steer": { version: "0.1.0" } } },
    });

    expect(adapter).not.toBeNull();
    const { calls, connection } = recordingConnection({
      stopReason: "end_turn",
      _meta: { "alta/steer": { accepted: true, steeringId: "steer-1" } },
    });

    await expect(
      runTestEffect(adapter!.send({ connection, sessionId: "session-1", text: "guide current turn" })),
    ).resolves.toEqual({ accepted: true });
    expect(calls).toEqual([
      {
        kind: "prompt",
        params: {
          sessionId: "session-1",
          prompt: [{ type: "text", text: "guide current turn" }],
          _meta: { "alta/steer": {} },
        },
      },
    ]);
  });

  test("steer-meta adapter surfaces rejection reason from the prompt response", async () => {
    const adapter = resolveActiveTurnInputAdapter({
      agentCapabilities: { _meta: { "alta/steer": { version: "0.1.0" } } },
    });
    const { connection } = recordingConnection({
      stopReason: "end_turn",
      _meta: { "alta/steer": { accepted: false, reason: "turn-completing" } },
    });

    await expect(
      runTestEffect(adapter!.send({ connection, sessionId: "session-1", text: "late steer" })),
    ).resolves.toEqual({ accepted: false, reason: "turn-completing" });
  });

  test("steer-meta capability takes priority over the legacy ext method", async () => {
    const adapter = resolveActiveTurnInputAdapter({
      agentCapabilities: {
        _meta: { "alta/steer": { version: "0.1.0" } },
        extensions: { "_alta/session/steer": { version: "0.1.0" } },
      },
    });

    expect(adapter).not.toBeNull();
    const { calls, connection } = recordingConnection({
      stopReason: "end_turn",
      _meta: { "alta/steer": { accepted: true } },
    });

    await runTestEffect(adapter!.send({ connection, sessionId: "session-1", text: "steer me" }));
    expect(calls).toEqual([
      {
        kind: "prompt",
        params: {
          sessionId: "session-1",
          prompt: [{ type: "text", text: "steer me" }],
          _meta: { "alta/steer": {} },
        },
      },
    ]);
  });

  test("malformed legacy active-turn input responses are rejected safely", () => {
    expect(activeTurnInputResult({ accepted: false, reason: "turn-completing" })).toEqual({
      accepted: false,
      reason: "turn-completing",
    });
    expect(activeTurnInputResult({ steeringId: "missing-accepted" })).toEqual({
      accepted: false,
      reason: "Invalid active-turn input response",
    });
  });

  test("malformed steer-meta responses are rejected safely", () => {
    expect(steerMetaResult({ _meta: { "alta/steer": { accepted: true, steeringId: "s-1" } } })).toEqual({
      accepted: true,
    });
    expect(steerMetaResult({ _meta: { "alta/steer": { accepted: false, reason: "busy" } } })).toEqual({
      accepted: false,
      reason: "busy",
    });
    expect(steerMetaResult({ _meta: { "alta/steer": { steeringId: "missing-accepted" } } })).toEqual({
      accepted: false,
      reason: "Invalid active-turn input response",
    });
    expect(steerMetaResult({ stopReason: "end_turn" })).toEqual({
      accepted: false,
      reason: "Invalid active-turn input response",
    });
  });
});
