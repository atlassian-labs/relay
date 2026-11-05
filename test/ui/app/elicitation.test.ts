import { describe, expect, test } from "bun:test";
import type { ElicitationBlock } from "../../../src/ui/state";
import { elicitationOptionCount, submitElicitationText } from "../../../src/ui/app/elicitation";

function altaChoiceBlock(overrides: Partial<ElicitationBlock> = {}): ElicitationBlock {
  return {
    type: "elicitation",
    id: "elicitation-1",
    mode: "form",
    message: "Choose an approach",
    status: "pending",
    fields: [
      {
        key: "suggestedApproach",
        type: "string",
        title: "Suggested approach",
        required: true,
        choices: [
          { value: "canary", title: "Canary" },
          { value: "rolling", title: "Rolling" },
        ],
      },
    ],
    currentFieldIndex: 0,
    answers: {},
    allowCustomEnumInput: true,
    ...overrides,
  };
}

function recordingApp() {
  const updates: Array<Partial<ElicitationBlock>> = [];
  return {
    updates,
    app: {
      updateBlock: (_id: string, update: Partial<ElicitationBlock>) => updates.push(update),
    } as unknown as Parameters<typeof submitElicitationText>[0],
  };
}

describe("Alta custom enum elicitation", () => {
  test("adds the inline custom input to keyboard option navigation", () => {
    const block = altaChoiceBlock();
    expect(elicitationOptionCount(block, block.fields[0]!)).toBe(3);
    expect(elicitationOptionCount({ ...block, allowCustomEnumInput: false }, block.fields[0]!)).toBe(2);
  });

  test("submits custom text as the Alta enum field value", () => {
    const { app, updates } = recordingApp();
    submitElicitationText(
      app,
      altaChoiceBlock({ editingCustomFieldKey: "suggestedApproach" }),
      "Blue-green deployment",
      () => undefined,
    );
    expect(updates).toEqual([
      {
        answers: { suggestedApproach: "Blue-green deployment" },
        currentFieldIndex: 1,
        editingCustomFieldKey: undefined,
      },
    ]);
  });
});
