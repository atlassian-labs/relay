import { describe, expect, test } from "bun:test";
import {
  currentModelIdFromSessionResult,
  currentThinkingLevelFromSessionResult,
  modelConfigIdFromSessionResult,
} from "../../../src/ui/app/acp-session";

describe("ACP session result helpers", () => {
  test("reads current model from ACP configOptions model selector", () => {
    expect(
      currentModelIdFromSessionResult({
        configOptions: [
          { id: "mode", category: "mode", type: "select", currentValue: "code", options: [] },
          { id: "model", category: "model", type: "select", currentValue: "opus", options: [] },
        ],
      }),
    ).toBe("opus");
  });

  test("reads custom model config id from ACP configOptions model selector", () => {
    expect(
      modelConfigIdFromSessionResult({
        configOptions: [
          { id: "mode", category: "mode", type: "select", currentValue: "code", options: [] },
          { id: "custom-model-selector", category: "model", type: "select", currentValue: "opus", options: [] },
        ],
      }),
    ).toBe("custom-model-selector");
  });

  test("falls back to legacy model config id for legacy model capabilities", () => {
    expect(
      modelConfigIdFromSessionResult({
        models: { currentModelId: "opus" },
      }),
    ).toBe("model");
  });

  test("reads current thinking level from ACP configOptions thought-level selector", () => {
    expect(
      currentThinkingLevelFromSessionResult({
        configOptions: [
          { id: "model", category: "model", type: "select", currentValue: "opus", options: [] },
          { id: "custom-thinking-id", category: "thought_level", type: "select", currentValue: "ultra", options: [] },
        ],
      }),
    ).toBe("ultra");
  });

  test("does not classify non-thought-level options by speculative IDs", () => {
    expect(
      currentThinkingLevelFromSessionResult({
        configOptions: [{ id: "thinking", category: "custom", type: "select", currentValue: "high", options: [] }],
      }),
    ).toBeUndefined();
  });
});
