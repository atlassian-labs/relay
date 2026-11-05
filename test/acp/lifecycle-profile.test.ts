import { describe, expect, test } from "bun:test";
import { resolveAgentBehaviorProfile } from "../../src/acp/agent-profile";
import { defaultAgentBehaviorProfile } from "../../src/acp/profiles/default";
import { altaAgentBehaviorProfile, normalizeAltaAgentLifecycleEvent } from "../../src/acp/profiles/alta";
import { normalizeAgentLifecycleEvent } from "../../src/plugins/lifecycle";

describe("agent lifecycle profile normalization", () => {
  test("resolves built-in profiles with Alta-only custom enum input", () => {
    expect(resolveAgentBehaviorProfile("codex").id).toBe("codex");
    expect(resolveAgentBehaviorProfile("claude").id).toBe("claude");
    expect(resolveAgentBehaviorProfile("alta").elicitationPolicy?.allowCustomEnumInput).toBe(true);
    expect(resolveAgentBehaviorProfile("default").elicitationPolicy?.allowCustomEnumInput).not.toBe(true);
  });

  test("default profile does not normalize provider lifecycle markers", () => {
    const update = {
      sessionUpdate: "agent_lifecycle_event",
      agent: "alta",
      event: { name: "turn_start", phase: "start", payload: { turn: 1 } },
    };

    expect(normalizeAgentLifecycleEvent(update, defaultAgentBehaviorProfile)).toBeNull();
  });

  test("unknown provider lifecycle markers are not treated as Alta events", () => {
    const update = {
      sessionUpdate: "agent_lifecycle_event",
      agent: "example",
      _meta: { vendor: "example.agent" },
      event: { name: "turn_start", phase: "start" },
    };

    expect(normalizeAgentLifecycleEvent(update, altaAgentBehaviorProfile)).toBeNull();
    expect(normalizeAltaAgentLifecycleEvent(update)).toBeNull();
  });

  test("Alta profile normalizes Alta lifecycle events", () => {
    const update = {
      sessionUpdate: "agent_lifecycle_event",
      agent: "alta",
      event: { name: "turn_start", phase: "start", payload: { turn: 1 } },
    };

    expect(normalizeAgentLifecycleEvent(update, altaAgentBehaviorProfile)).toEqual({
      type: "agent:lifecycle",
      agent: "alta",
      name: "turn_start",
      phase: "start",
      payload: { turn: 1 },
      raw: update,
    });
  });

  test("Alta vendor marker defaults missing agent name to alta", () => {
    const update = {
      sessionUpdate: "agent_lifecycle_event",
      _meta: { vendor: "atlassian.alta" },
      event: { name: "message_update" },
    };

    expect(normalizeAgentLifecycleEvent(update, altaAgentBehaviorProfile)).toMatchObject({
      type: "agent:lifecycle",
      agent: "alta",
      name: "message_update",
    });
  });
});
