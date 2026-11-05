import { describe, expect, test } from "bun:test";
import { webAgentSlashSkillInvocationEcho } from "../../src/web/server";
import { createInitialState } from "../../src/ui/state";

describe("web slash command handling", () => {
  test("disabled native preferred commands can still render agent slash echoes", () => {
    const state = createInitialState("/tmp/relay-web");
    state.availableCommands = [{ name: "model", description: "Agent model command" }];
    state.availableModels = [{ modelId: "native-model", name: "Native model" }];

    expect(webAgentSlashSkillInvocationEcho("/model custom", state)).toBeNull();
    expect(webAgentSlashSkillInvocationEcho("/model custom", state, ["model"])).toEqual({
      name: "model",
      userMessage: "custom",
    });
    expect(webAgentSlashSkillInvocationEcho("/model custom", state, ["models"])).toEqual({
      name: "model",
      userMessage: "custom",
    });
  });
});
