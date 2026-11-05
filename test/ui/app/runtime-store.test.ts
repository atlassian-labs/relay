import { describe, expect, test } from "bun:test";
import { mergeSessionCapabilities } from "../../../src/ui/app/runtime-store";

describe("mergeSessionCapabilities", () => {
  test("preserves previous capabilities only when next omits a field", () => {
    const previous = {
      configOptions: [{ id: "model" }],
      models: { currentModelId: "model-a" },
      modes: { currentModeId: "default" },
      availableCommands: [{ name: "review", description: "Review" }],
    };

    expect(mergeSessionCapabilities(previous, { configOptions: [{ id: "thought_level" }] })).toEqual({
      configOptions: [{ id: "thought_level" }],
      models: previous.models,
      modes: previous.modes,
      availableCommands: previous.availableCommands,
    });

    expect(mergeSessionCapabilities(previous, { configOptions: null, modes: null })).toEqual({
      configOptions: null,
      models: previous.models,
      modes: null,
      availableCommands: previous.availableCommands,
    });
  });
});
