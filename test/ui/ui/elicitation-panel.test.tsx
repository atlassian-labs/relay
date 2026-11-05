import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { ElicitationPanel } from "../../../src/ui/component/elicitation-panel";
import { AppContext, type ElicitationBlock, useApp } from "../../../src/ui/state";

function customChoiceBlock(editing = false): ElicitationBlock {
  return {
    type: "elicitation",
    id: "elicitation-1",
    mode: "form",
    message: "Choose an approach",
    status: "pending",
    fields: [
      {
        key: "approach",
        type: "string",
        title: "Approach",
        choices: [
          { value: "canary", title: "Canary" },
          { value: "rolling", title: "Rolling" },
        ],
      },
    ],
    currentFieldIndex: 0,
    answers: {},
    allowCustomEnumInput: true,
    ...(editing ? { editingCustomFieldKey: "approach" } : {}),
  };
}

async function renderPanel(block: ElicitationBlock, optionIndex: number): Promise<string> {
  const contextValue = {
    state: { blocks: [block] },
    updateBlock: () => undefined,
  } as unknown as ReturnType<typeof useApp>;
  const app = await testRender(
    () => (
      <AppContext.Provider value={contextValue}>
        <ElicitationPanel block={block} optionIndex={() => optionIndex} />
      </AppContext.Provider>
    ),
    { width: 100, height: 20, targetFps: 30 },
  );

  try {
    await app.renderOnce();
    return app.captureCharFrame();
  } finally {
    app.renderer.destroy();
  }
}

describe("elicitation panel", () => {
  test("renders without panel borders", async () => {
    const frame = await renderPanel(customChoiceBlock(), 0);

    expect(frame).not.toContain("━");
  });

  test("aligns the custom-answer prefix with the choice prefixes", async () => {
    const lines = (await renderPanel(customChoiceBlock(), 0)).split("\n");
    const canary = lines.find((line) => line.includes("Canary"));
    const rolling = lines.find((line) => line.includes("Rolling"));
    const custom = lines.find((line) => line.includes("Type your own answer…"));

    expect(canary).toBeDefined();
    expect(rolling).toBeDefined();
    expect(custom).toBeDefined();
    expect(rolling!.indexOf("○")).toBe(canary!.indexOf("○"));
    expect(custom!.indexOf("○")).toBe(canary!.indexOf("○"));
  });

  test("keeps a blank line after the selected custom-answer input", async () => {
    const lines = (await renderPanel(customChoiceBlock(true), 2)).split("\n");
    const inputLine = lines.findIndex((line) => line.includes("Type your own answer…"));
    const helpLine = lines.findIndex((line) => line.includes("enter continue"));

    expect(inputLine).toBeGreaterThanOrEqual(0);
    expect(helpLine).toBe(inputLine + 2);
    expect(lines[inputLine + 1]?.trim()).toBe("");
  });

  test("shows 64 question characters before truncating review labels", async () => {
    const block = customChoiceBlock();
    const titlePrefix = "q".repeat(64);
    block.fields[0]!.title = `${titlePrefix}SENTINEL`;
    block.currentFieldIndex = block.fields.length;
    block.answers = { approach: "canary" };

    const frame = await renderPanel(block, 0);

    expect(frame).toContain(`${titlePrefix}...`);
    expect(frame).not.toContain("SENTINEL");
  });
});
