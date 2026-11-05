import { describe, expect, test } from "bun:test";
import { ApprovalResponse } from "../../src/core/events";
import { createFauxAcpAgent } from "./faux-acp-agent";
import { acpAgentMessageChunk, acpPromptResponse } from "./acp-events";

describe("createFauxAcpAgent", () => {
  test("records sessions and prompts while emitting scripted updates", async () => {
    const faux = createFauxAcpAgent({ chunkSize: { max: 3 } });
    const updates: unknown[] = [];
    const client = faux.attach({
      onSessionUpdate: (update) => updates.push(update),
      onPermissionRequest: () => {},
    });

    await client.connect();
    await client.newSession("/tmp/project");
    faux.script([acpAgentMessageChunk("hello")], acpPromptResponse({ inputTokens: 1 }));
    const response = await client.prompt("hi");

    expect(faux.newSessions).toEqual([{ cwd: "/tmp/project" }]);
    expect(faux.prompts).toEqual(["hi"]);
    expect(updates).toEqual([
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hel" } },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "lo" } },
    ]);
    expect(response).toMatchObject({ usage: { inputTokens: 1 } });
  });

  test("requires explicit fork support for session forks", async () => {
    const unsupported = createFauxAcpAgent();
    const supported = createFauxAcpAgent({ capabilities: { sessionFork: true } });

    expect(unsupported.client.supportsSessionFork()).toBe(false);
    expect(supported.client.supportsSessionFork()).toBe(true);
  });

  test("permission requests resolve through the callback response", async () => {
    const faux = createFauxAcpAgent();
    faux.attach({
      onSessionUpdate: () => {},
      onPermissionRequest: (request) => request.respond(ApprovalResponse.APPROVE),
    });

    await expect(faux.requestPermission({ toolCallId: "tc", toolName: "Write" })).resolves.toBe(
      ApprovalResponse.APPROVE,
    );
  });

  test("cancel interrupts scripted streaming", async () => {
    const faux = createFauxAcpAgent({ tokensPerSecond: 1000 });
    const updates: unknown[] = [];
    const client = faux.attach({
      onSessionUpdate: (update) => updates.push(update),
      onPermissionRequest: () => {},
    });
    await client.connect();
    await client.newSession("/tmp/project");
    faux.script([acpAgentMessageChunk("slow")]);

    const prompt = client.prompt("hi");
    await client.cancel();
    await prompt;

    expect(faux.cancellations).toBe(1);
    expect(updates).not.toContainEqual(expect.objectContaining({ sessionUpdate: "stop_turn" }));
  });
});
