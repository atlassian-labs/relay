import { describe, expect, test } from "bun:test";
import {
  RELAY_CLIENT_CAPABILITY_SUPPORT,
  agentLifecycleCapabilitiesForInitializeResult,
  authMethodsForInitializeResult,
  relayAdvertisedClientCapabilityIds,
  relayClientCapabilities,
  supportsAuthLogoutForInitializeResult,
} from "../../src/acp/capabilities";

describe("ACP capabilities", () => {
  test("advertises only implemented client capabilities", () => {
    const capabilities = relayClientCapabilities();

    expect(capabilities).toEqual({
      auth: { terminal: true },
      elicitation: { form: {} },
      _meta: { "terminal-auth": true, "alta/subagent": { liveStreaming: true } },
    });
    expect(capabilities).not.toHaveProperty("fs");
    expect(capabilities).not.toHaveProperty("terminal");
    expect(capabilities).not.toHaveProperty("session");
    expect(capabilities).not.toHaveProperty("plan");
    expect(capabilities).not.toHaveProperty("nes");
  });

  test("gates Alta subagent live streaming metadata advertisement", () => {
    expect(relayClientCapabilities({ altaSubagentLiveStreaming: false })).toEqual({
      auth: { terminal: true },
      elicitation: { form: {} },
      _meta: { "terminal-auth": true },
    });
    expect(relayClientCapabilities({ altaSubagentLiveStreaming: true })).toEqual({
      auth: { terminal: true },
      elicitation: { form: {} },
      _meta: { "terminal-auth": true, "alta/subagent": { liveStreaming: true } },
    });
  });

  test("tracks handlers and UX paths for every advertised client capability", () => {
    const advertisedCapabilityIds = [...relayAdvertisedClientCapabilityIds()];
    const supportedCapabilityIds: string[] = RELAY_CLIENT_CAPABILITY_SUPPORT.map((entry) => entry.capabilityId);

    expect(advertisedCapabilityIds).toEqual(["auth.terminal", "elicitation.form"]);
    expect(supportedCapabilityIds).toEqual(advertisedCapabilityIds);
    expect(RELAY_CLIENT_CAPABILITY_SUPPORT).toEqual([
      {
        capabilityId: "auth.terminal",
        requestHandler: "authenticateWithAcpMethod terminal auth runner",
        uxPath: "src/ui/util/terminal-auth.ts",
      },
      {
        capabilityId: "elicitation.form",
        requestHandler: "AcpClientCallbacks.onElicitationRequest",
        uxPath: "src/ui/app/elicitation.ts",
      },
    ]);
  });

  test("normalizes advertised auth methods without enabling unsupported client auth types", () => {
    const initializeResult = {
      agentCapabilities: { auth: { logout: {} } },
      authMethods: [
        { id: "oauth", name: "OAuth", description: "Browser login" },
        {
          type: "env_var",
          id: "api-key",
          name: "API key",
          vars: [{ name: "API_KEY" }],
          link: "https://example.com/key",
        },
        { type: "terminal", id: "terminal", name: "Terminal login" },
        { id: 42, name: "malformed" },
      ],
    };

    expect(authMethodsForInitializeResult(initializeResult)).toEqual([
      {
        id: "oauth",
        name: "OAuth",
        description: "Browser login",
        type: "agent",
        supported: true,
      },
      {
        id: "api-key",
        name: "API key",
        type: "env_var",
        link: "https://example.com/key",
        vars: [{ name: "API_KEY", secret: true, optional: false }],
        supported: false,
        unsupportedReason: "Relay cannot pass new environment variables to an already-running ACP agent.",
      },
      {
        id: "terminal",
        name: "Terminal login",
        type: "terminal",
        supported: false,
        unsupportedReason: "Relay cannot run this terminal ACP auth method because no command was advertised.",
      },
    ]);
    expect(supportsAuthLogoutForInitializeResult(initializeResult)).toBe(true);
    expect(supportsAuthLogoutForInitializeResult({ agentCapabilities: { auth: {} } })).toBe(false);
  });

  test("normalizes ACP and opencode terminal auth commands", () => {
    const initializeResult = {
      authMethods: [
        {
          type: "terminal",
          id: "terminal",
          name: "Terminal login",
          args: ["auth", "login"],
          env: { RELAY_AUTH_TEST: "1", IGNORED: 2 },
        },
        {
          id: "opencode-login",
          name: "Login with opencode",
          _meta: {
            "terminal-auth": {
              command: "opencode",
              args: ["auth", "login"],
              env: { OPENCODE_AUTH_TEST: "1" },
              label: "OpenCode Login",
            },
          },
        },
      ],
    };

    expect(
      authMethodsForInitializeResult(initializeResult, { command: "agent", args: ["--acp"], env: { BASE: "1" } }),
    ).toEqual([
      {
        id: "terminal",
        name: "Terminal login",
        type: "terminal",
        terminal: { command: "agent", args: ["--acp", "auth", "login"], env: { BASE: "1", RELAY_AUTH_TEST: "1" } },
        supported: true,
      },
      {
        id: "opencode-login",
        name: "Login with opencode",
        type: "terminal",
        terminal: {
          command: "opencode",
          args: ["auth", "login"],
          env: { OPENCODE_AUTH_TEST: "1" },
          label: "OpenCode Login",
        },
        supported: true,
      },
    ]);
  });

  test("detects advertised session/resume capability", () => {
    expect(
      agentLifecycleCapabilitiesForInitializeResult({
        agentCapabilities: { sessionCapabilities: { resume: {} } },
      }).resumeSession,
    ).toBe(true);
    expect(
      agentLifecycleCapabilitiesForInitializeResult({
        agentCapabilities: { sessionCapabilities: { resume: false } },
      }).resumeSession,
    ).toBe(false);
  });

  test("detects advertised session/close capability", () => {
    expect(
      agentLifecycleCapabilitiesForInitializeResult({
        agentCapabilities: { sessionCapabilities: { close: {} } },
      }).closeSession,
    ).toBe(true);
    expect(
      agentLifecycleCapabilitiesForInitializeResult({
        agentCapabilities: { sessionCapabilities: { close: false } },
      }).closeSession,
    ).toBe(false);
  });

  test("detects advertised additionalDirectories capability", () => {
    expect(
      agentLifecycleCapabilitiesForInitializeResult({
        agentCapabilities: { sessionCapabilities: { additionalDirectories: {} } },
      }).additionalDirectories,
    ).toBe(true);
    expect(
      agentLifecycleCapabilitiesForInitializeResult({
        agentCapabilities: { sessionCapabilities: { additionalDirectories: false } },
      }).additionalDirectories,
    ).toBe(false);
  });

  test("detects advertised session/fork capability", () => {
    expect(
      agentLifecycleCapabilitiesForInitializeResult({
        agentCapabilities: { sessionCapabilities: { fork: {} } },
      }).forkSession,
    ).toBe(true);
    expect(
      agentLifecycleCapabilitiesForInitializeResult({
        agentCapabilities: { sessionCapabilities: { fork: true } },
      }).forkSession,
    ).toBe(true);
    expect(
      agentLifecycleCapabilitiesForInitializeResult({
        agentCapabilities: { sessionCapabilities: { fork: false } },
      }).forkSession,
    ).toBe(false);
    expect(
      agentLifecycleCapabilitiesForInitializeResult({
        agentCapabilities: { sessionCapabilities: { fork: null } },
      }).forkSession,
    ).toBe(false);
    expect(
      agentLifecycleCapabilitiesForInitializeResult({
        agentCapabilities: { sessionCapabilities: { fork: "yes" } },
      }).forkSession,
    ).toBe(false);
  });
});
