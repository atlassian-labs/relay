import { describe, expect, test } from "bun:test";
import { applyAcpSessionUpdate, finalizeAcpPrompt } from "../../src/application/acp-mapping";
import type { ToolBlock } from "../../src/ui/state";
import { createMappingFixture } from "../lib/acp-mapping-fixture";
import {
  acpAgentMessageChunk,
  acpPromptResponse,
  acpThinkingChunk,
  acpToolCallStart,
  acpToolCallUpdate,
} from "../lib/acp-events";
import { createFauxAcpAgent } from "../lib/faux-acp-agent";

describe("FauxAcpAgent + ACP mapping integration", () => {
  test("scripted prompt streams through callbacks into app state", async () => {
    const app = createMappingFixture("/tmp/project");
    const seenActivities: string[] = [];
    const faux = createFauxAcpAgent({ chunkSize: { max: 4 } });
    const client = faux.attach({
      onSessionUpdate: (update) => {
        applyAcpSessionUpdate(update, {
          ...app,
          onActivity: (activity) => seenActivities.push(`${activity.kind}:${activity.label}`),
        });
      },
      onPermissionRequest: () => {},
    });

    await client.connect();
    await client.newSession(app.state.cwd);
    faux.script(
      [
        acpThinkingChunk("Plan."),
        acpToolCallStart({ toolCallId: "tc_1", toolName: "Read", rawInput: { file_path: "/tmp/project/README.md" } }),
        acpToolCallUpdate({ toolCallId: "tc_1", status: "success", rawOutput: "contents" }),
        acpAgentMessageChunk("Done."),
      ],
      acpPromptResponse({ inputTokens: 2, outputTokens: 3 }),
    );

    app.setState("running", true);
    app.setState("spinnerActive", true);
    const response = await client.prompt("summarize");
    finalizeAcpPrompt(app, response);

    expect(faux.prompts).toEqual(["summarize"]);
    expect(app.state.blocks).toHaveLength(3);
    expect(app.state.blocks[0]).toMatchObject({ type: "thinking", content: "Plan.", finalized: true });
    expect(app.state.blocks[1]).toMatchObject({
      type: "tool",
      toolCallId: "tc_1",
      status: "success",
      details: "contents",
    });
    expect((app.state.blocks[1] as ToolBlock).display).toBe("file_path: README.md");
    expect(app.state.blocks[2]).toMatchObject({ type: "content", content: "Done.", finalized: true });
    expect(seenActivities).toContain("reasoning:");
    expect(seenActivities).toContain("tool:Read");
    expect(app.state.running).toBe(false);
    expect(app.state.spinnerActive).toBe(false);
    expect(app.state.totalUsage).toMatchObject({ input_tokens: 2, output_tokens: 3 });
  });
});
