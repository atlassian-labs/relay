import { describe, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import {
  addWelcomeBlocks,
  applySessionCapabilities,
  applySessionConfigOptionUpdate,
  resetSessionState,
  sessionCapabilitiesWithConfigOptionValue,
  sessionListDescription,
  sessionListDescriptionColumns,
} from "../../../src/ui/context/session";
import { createAppStateValue } from "../../../src/ui/context/app-state";
import type { ChatBlock, InfoBlock } from "../../../src/ui/state";

describe("session context helpers", () => {
  test("session descriptions include workspace name only", () => {
    expect(
      sessionListDescription({
        sessionId: "session-1",
        title: "Provider metadata",
        cwd: "/tmp/project",
        additionalDirectories: ["/tmp/other"],
        metadata: { providerMode: "debug", relay: { kind: "ignored" } },
        _meta: { "provider/source": "fixture" },
      }),
    ).toBe("project");
  });

  test("session descriptions label Alta same-project and missing-workspace sessions without raw metadata", () => {
    expect(
      sessionListDescription({
        sessionId: "session-1",
        title: "Other checkout",
        cwd: "/tmp/other-checkout",
        _meta: { "alta/session-list": { workspaceScope: "same-project", cwdExists: true } },
      }),
    ).toBe("other-checkout · same project");

    expect(
      sessionListDescription({
        sessionId: "session-2",
        title: "Missing checkout",
        cwd: "/tmp/missing-checkout",
        _meta: { "alta/session-list": { workspaceScope: "same-project", cwdExists: false } },
      }),
    ).toBe("missing-checkout · missing workspace");
  });

  test("session description columns separate age from workspace name", () => {
    expect(
      sessionListDescriptionColumns({
        sessionId: "session-1",
        title: "Provider metadata",
        cwd: "/tmp/project",
        additionalDirectories: ["/tmp/other"],
        metadata: { providerMode: "debug" },
      }),
    ).toEqual(["", "project"]);
  });

  test("applySessionCapabilities decodes unknown ACP capability values", () => {
    createRoot((dispose) => {
      const app = createAppStateValue("/tmp/project");

      applySessionCapabilities(app, {
        configOptions: [
          {
            id: "model",
            category: "model",
            type: "select",
            currentValue: "opus",
            options: [
              { value: "opus", name: "Opus", description: "Deep reasoning" },
              { id: "sonnet", name: "Sonnet", description: "Legacy id shape" },
              { value: 123, name: "invalid" },
              null,
            ],
          },
          {
            id: "custom-thinking-id",
            category: "thought_level",
            type: "select",
            currentValue: "high",
            options: [
              { value: "off", name: "Off" },
              { value: "high", name: "High", description: "More reasoning" },
              { value: "ultra", name: "Ultra" },
            ],
          },
        ],
        models: {
          currentModelId: "sonnet",
          availableModels: [
            { modelId: "sonnet", name: "Sonnet", description: "Fast" },
            { modelId: 123, name: "invalid" },
            null,
          ],
        },
        modes: {
          currentModeId: "review",
          availableModes: [
            { id: "review", name: "Review" },
            { modeId: "missing-id", name: "invalid" },
          ],
        },
        availableCommands: [
          { name: "review", description: "Review changes" },
          { name: 123, description: "invalid" },
        ],
      });

      expect(app.state.modelId).toBe("opus");
      expect(app.state.modelConfigId).toBe("model");
      expect(app.state.sessionConfigOptions).toEqual([
        expect.objectContaining({
          id: "model",
          category: "model",
          type: "select",
          currentValue: "opus",
          options: [
            { value: "opus", name: "Opus", description: "Deep reasoning" },
            { value: "sonnet", name: "Sonnet", description: "Legacy id shape" },
          ],
        }),
        expect.objectContaining({
          id: "custom-thinking-id",
          category: "thought_level",
          type: "select",
          currentValue: "high",
        }),
      ]);
      expect(app.state.availableModels).toEqual([
        { modelId: "opus", name: "Opus", description: "Deep reasoning" },
        { modelId: "sonnet", name: "Sonnet", description: "Legacy id shape" },
      ]);
      expect(app.state.thinkingConfigId).toBe("custom-thinking-id");
      expect(app.state.thinkingLevel).toBe("high");
      expect(app.state.availableThinkingLevels).toEqual([
        { id: "off", name: "Off", description: undefined },
        { id: "high", name: "High", description: "More reasoning" },
        { id: "ultra", name: "Ultra", description: undefined },
      ]);
      expect(app.state.modeId).toBe("review");
      expect(app.state.availableModes).toEqual([{ id: "review", name: "Review", description: undefined }]);
      expect(app.state.availableCommands).toEqual([{ name: "review", description: "Review changes" }]);

      dispose();
    });
  });

  test("applySessionCapabilities does not derive thinking levels from model metadata", () => {
    createRoot((dispose) => {
      const app = createAppStateValue("/tmp/project");

      applySessionCapabilities(app, {
        configOptions: [
          {
            id: "model",
            category: "model",
            type: "select",
            currentValue: "opus",
            options: [
              {
                value: "opus",
                name: "Opus",
                reasoning: true,
                thinkingLevelMap: { low: "low", ultra: "ultra", high: null },
              },
            ],
          },
        ],
        modes: {},
      });

      expect(app.state.thinkingConfigId).toBe("");
      expect(app.state.thinkingLevel).toBe("");
      expect(app.state.availableThinkingLevels).toEqual([]);
      dispose();
    });
  });

  test("applySessionCapabilities stores custom model config ids", () => {
    createRoot((dispose) => {
      const app = createAppStateValue("/tmp/project");

      applySessionCapabilities(app, {
        configOptions: [
          {
            id: "custom-model-selector",
            category: "model",
            type: "select",
            currentValue: "opus",
            options: [{ value: "opus", name: "Opus" }],
          },
        ],
      });

      expect(app.state.modelConfigId).toBe("custom-model-selector");
      expect(app.state.modelId).toBe("opus");
      dispose();
    });
  });

  test("applySessionCapabilities projects legacy thought_level ids without category", () => {
    createRoot((dispose) => {
      const app = createAppStateValue("/tmp/project");

      applySessionCapabilities(app, {
        configOptions: [
          {
            id: "thought_level",
            type: "select",
            currentValue: "high",
            options: [
              { value: "low", name: "Low" },
              { value: "high", name: "High" },
            ],
          },
        ],
      });

      expect(app.state.thinkingConfigId).toBe("thought_level");
      expect(app.state.thinkingLevel).toBe("high");
      expect(app.state.availableThinkingLevels).toEqual([
        { id: "low", name: "Low", description: undefined },
        { id: "high", name: "High", description: undefined },
      ]);
      dispose();
    });
  });

  test("applySessionCapabilities preserves unknown advertised config categories", () => {
    createRoot((dispose) => {
      const app = createAppStateValue("/tmp/project");

      applySessionCapabilities(app, {
        configOptions: [
          {
            id: "vendor-toggle",
            name: "Vendor toggle",
            category: "_vendor.toggle",
            type: "boolean",
            currentValue: true,
            _meta: { owner: "vendor" },
          },
        ],
      });

      expect(app.state.sessionConfigOptions).toEqual([
        {
          id: "vendor-toggle",
          name: "Vendor toggle",
          description: undefined,
          category: "_vendor.toggle",
          type: "boolean",
          currentValue: true,
          options: [],
          raw: {
            id: "vendor-toggle",
            name: "Vendor toggle",
            category: "_vendor.toggle",
            type: "boolean",
            currentValue: true,
            _meta: { owner: "vendor" },
          },
        },
      ]);
      expect(app.state.modelConfigId).toBe("");
      expect(app.state.thinkingConfigId).toBe("");
      dispose();
    });
  });

  test("applySessionConfigOptionUpdate refreshes first-class config option state", () => {
    createRoot((dispose) => {
      const app = createAppStateValue("/tmp/project");
      app.setState("availableModes", [{ id: "review", name: "Review" }]);

      const handled = applySessionConfigOptionUpdate(app, {
        sessionUpdate: "config_option_update",
        configOptions: [
          {
            id: "custom-model-selector",
            category: "model",
            type: "select",
            currentValue: "sonnet",
            options: [
              { value: "opus", name: "Opus" },
              { value: "sonnet", name: "Sonnet" },
            ],
          },
          {
            id: "custom-thinking-id",
            category: "thought_level",
            type: "select",
            currentValue: "high",
            options: [{ value: "high", name: "High" }],
          },
          {
            id: "vendor-mode",
            name: "Vendor mode",
            category: "_vendor.mode",
            type: "select",
            currentValue: "fast",
            options: [{ value: "fast", name: "Fast" }],
          },
        ],
      });

      expect(handled).toBe(true);
      expect(app.state.modelConfigId).toBe("custom-model-selector");
      expect(app.state.modelId).toBe("sonnet");
      expect(app.state.availableModels).toEqual([
        { modelId: "opus", name: "Opus", description: undefined },
        { modelId: "sonnet", name: "Sonnet", description: undefined },
      ]);
      expect(app.state.thinkingConfigId).toBe("custom-thinking-id");
      expect(app.state.thinkingLevel).toBe("high");
      expect(app.state.sessionConfigOptions.map((option) => option.id)).toEqual([
        "custom-model-selector",
        "custom-thinking-id",
        "vendor-mode",
      ]);
      expect(app.state.availableModes).toEqual([{ id: "review", name: "Review" }]);
      dispose();
    });
  });

  test("applySessionConfigOptionUpdate patches stored single-option values by category", () => {
    createRoot((dispose) => {
      const app = createAppStateValue("/tmp/project");

      applySessionCapabilities(app, {
        configOptions: [
          {
            id: "custom-model-selector",
            category: "model",
            type: "select",
            currentValue: "opus",
            options: [
              { value: "opus", name: "Opus" },
              { value: "sonnet", name: "Sonnet" },
            ],
          },
          {
            id: "custom-thinking-id",
            category: "thought_level",
            type: "select",
            currentValue: "low",
            options: [
              { value: "low", name: "Low" },
              { value: "high", name: "High" },
            ],
          },
        ],
      });

      expect(
        applySessionConfigOptionUpdate(app, {
          sessionUpdate: "config_option_update",
          optionId: "custom-model-selector",
          value: "sonnet",
        }),
      ).toBe(true);
      expect(
        applySessionConfigOptionUpdate(app, {
          sessionUpdate: "config_option_update",
          optionId: "custom-thinking-id",
          value: "high",
        }),
      ).toBe(true);

      expect(app.state.modelId).toBe("sonnet");
      expect(app.state.thinkingLevel).toBe("high");
      expect(app.state.sessionConfigOptions.find((option) => option.id === "custom-model-selector")).toMatchObject({
        currentValue: "sonnet",
        raw: expect.objectContaining({ currentValue: "sonnet" }),
      });
      expect(app.state.sessionConfigOptions.find((option) => option.id === "custom-thinking-id")).toMatchObject({
        currentValue: "high",
        raw: expect.objectContaining({ currentValue: "high" }),
      });
      dispose();
    });
  });

  test("sessionCapabilitiesWithConfigOptionValue updates raw options for re-projection", () => {
    createRoot((dispose) => {
      const app = createAppStateValue("/tmp/project");
      applySessionCapabilities(app, {
        configOptions: [
          {
            id: "thought_level",
            category: "thought_level",
            type: "select",
            currentValue: "low",
            options: [
              { value: "low", name: "Low" },
              { value: "high", name: "High" },
            ],
          },
        ],
      });

      const next = sessionCapabilitiesWithConfigOptionValue(
        { configOptions: app.state.sessionConfigOptions },
        "thought_level",
        "high",
      );

      expect(next).not.toBeNull();
      applySessionCapabilities(app, next ?? undefined);
      expect(app.state.thinkingLevel).toBe("high");
      expect(app.state.sessionConfigOptions[0]).toMatchObject({
        id: "thought_level",
        currentValue: "high",
        raw: expect.objectContaining({ currentValue: "high" }),
      });
      dispose();
    });
  });

  test("applySessionConfigOptionUpdate leaves unknown single-option updates for legacy handlers", () => {
    createRoot((dispose) => {
      const app = createAppStateValue("/tmp/project");

      expect(
        applySessionConfigOptionUpdate(app, {
          sessionUpdate: "config_option_update",
          optionId: "relay.ui.color_tool_names",
          value: false,
        }),
      ).toBe(false);
      dispose();
    });
  });

  test("applySessionConfigOptionUpdate gates legacy model id fallback on advertised legacy capabilities", () => {
    createRoot((dispose) => {
      const app = createAppStateValue("/tmp/project");

      expect(
        applySessionConfigOptionUpdate(app, {
          sessionUpdate: "config_option_update",
          optionId: "model",
          value: "sonnet",
        }),
      ).toBe(false);
      expect(app.state.modelId).toBe("");

      applySessionCapabilities(app, {
        models: {
          currentModelId: "opus",
          availableModels: [{ modelId: "sonnet", name: "Sonnet" }],
        },
      });

      expect(app.state.modelConfigId).toBe("model");
      expect(
        applySessionConfigOptionUpdate(app, {
          sessionUpdate: "config_option_update",
          optionId: "model",
          value: "sonnet",
        }),
      ).toBe(true);
      expect(app.state.modelId).toBe("sonnet");
      dispose();
    });
  });

  test("applySessionCapabilities preserves command callbacks when result omits commands", () => {
    createRoot((dispose) => {
      const app = createAppStateValue("/tmp/project");
      app.setState("availableCommands", [{ name: "review", description: "Review changes" }]);

      applySessionCapabilities(app, { models: {}, modes: {} });

      expect(app.state.availableCommands).toEqual([{ name: "review", description: "Review changes" }]);
      dispose();
    });
  });

  test("applySessionCapabilities keeps modes and commands when a config-only result omits them", () => {
    createRoot((dispose) => {
      const app = createAppStateValue("/tmp/project");

      // Full capabilities as delivered at session start.
      applySessionCapabilities(app, {
        configOptions: [
          {
            id: "model",
            category: "model",
            type: "select",
            currentValue: "model-a",
            options: [{ value: "model-a", name: "Model A" }],
          },
          {
            id: "thought_level",
            category: "thought_level",
            type: "select",
            currentValue: "low",
            options: [
              { value: "low", name: "Low" },
              { value: "high", name: "High" },
            ],
          },
        ],
        modes: {
          currentModeId: "review",
          availableModes: [
            { id: "review", name: "Review" },
            { id: "code", name: "Code" },
          ],
        },
        availableCommands: [{ name: "review", description: "Review changes" }],
      });

      expect(app.state.availableModes).toHaveLength(2);
      expect(app.state.availableCommands).toHaveLength(1);

      // Shape produced by client.ts sessionResult() for a SetSessionConfigOptionResponse:
      // all keys present, but modes/models/availableCommands are undefined (ACP only
      // returns configOptions here).
      applySessionCapabilities(app, {
        modes: undefined,
        models: undefined,
        availableCommands: undefined,
        configOptions: [
          {
            id: "model",
            category: "model",
            type: "select",
            currentValue: "model-a",
            options: [{ value: "model-a", name: "Model A" }],
          },
          {
            id: "thought_level",
            category: "thought_level",
            type: "select",
            currentValue: "high",
            options: [
              { value: "low", name: "Low" },
              { value: "high", name: "High" },
            ],
          },
        ],
      });

      // Modes and agent commands must survive a config-only response ...
      expect(app.state.availableModes).toEqual([
        { id: "review", name: "Review", description: undefined },
        { id: "code", name: "Code", description: undefined },
      ]);
      expect(app.state.modeId).toBe("review");
      expect(app.state.availableCommands).toEqual([{ name: "review", description: "Review changes" }]);
      // ... while the config option it did carry is applied.
      expect(app.state.thinkingLevel).toBe("high");
      dispose();
    });
  });

  test("applySessionCapabilities replace clears stale full-session capabilities", () => {
    createRoot((dispose) => {
      const app = createAppStateValue("/tmp/project");

      applySessionCapabilities(app, {
        configOptions: [
          {
            id: "thought_level",
            category: "thought_level",
            type: "select",
            currentValue: "high",
            options: [{ value: "high", name: "High" }],
          },
        ],
        models: {
          currentModelId: "opus",
          availableModels: [{ modelId: "opus", name: "Opus" }],
        },
        modes: {
          currentModeId: "review",
          availableModes: [{ id: "review", name: "Review" }],
        },
        availableCommands: [{ name: "review", description: "Review changes" }],
      });

      applySessionCapabilities(app, {}, { replace: true });

      expect(app.state.modelId).toBe("");
      expect(app.state.modelConfigId).toBe("");
      expect(app.state.availableModels).toEqual([]);
      expect(app.state.thinkingConfigId).toBe("");
      expect(app.state.thinkingLevel).toBe("");
      expect(app.state.availableThinkingLevels).toEqual([]);
      expect(app.state.sessionConfigOptions).toEqual([]);
      expect(app.state.modeId).toBe("");
      expect(app.state.availableModes).toEqual([]);
      expect(app.state.availableCommands).toEqual([]);
      dispose();
    });
  });

  test("config-only capability updates preserve legacy model capabilities", () => {
    createRoot((dispose) => {
      const app = createAppStateValue("/tmp/project");
      const thinkingOptions = [
        { value: "low", name: "Low" },
        { value: "high", name: "High" },
      ];

      applySessionCapabilities(
        app,
        {
          models: {
            currentModelId: "legacy-opus",
            availableModels: [{ modelId: "legacy-opus", name: "Legacy Opus" }],
          },
          configOptions: [
            {
              id: "thought_level",
              category: "thought_level",
              type: "select",
              currentValue: "low",
              options: thinkingOptions,
            },
          ],
        },
        { replace: true },
      );

      applySessionCapabilities(app, {
        configOptions: [
          {
            id: "thought_level",
            category: "thought_level",
            type: "select",
            currentValue: "high",
            options: thinkingOptions,
          },
        ],
      });

      expect(app.state.modelConfigId).toBe("model");
      expect(app.state.modelId).toBe("legacy-opus");
      expect(app.state.availableModels).toEqual([
        { modelId: "legacy-opus", name: "Legacy Opus", description: undefined },
      ]);
      expect(app.state.thinkingLevel).toBe("high");

      expect(
        applySessionConfigOptionUpdate(app, {
          sessionUpdate: "config_option_update",
          configOptions: [
            {
              id: "thought_level",
              category: "thought_level",
              type: "select",
              currentValue: "low",
              options: thinkingOptions,
            },
          ],
        }),
      ).toBe(true);
      expect(app.state.modelId).toBe("legacy-opus");
      expect(app.state.availableModels).toEqual([
        { modelId: "legacy-opus", name: "Legacy Opus", description: undefined },
      ]);
      expect(app.state.thinkingLevel).toBe("low");
      dispose();
    });
  });

  test("resetSessionState clears stale agent-advertised commands", () => {
    createRoot((dispose) => {
      const app = createAppStateValue("/tmp/project");
      app.setState("availableCommands", [{ name: "review", description: "Review changes" }]);
      app.setState("thinkingConfigId", "thought_level");
      app.setState("thinkingLevel", "high");
      app.setState("availableThinkingLevels", [{ id: "high", name: "High" }]);
      app.setState("sessionConfigOptions", [
        {
          id: "thought_level",
          name: "Thinking",
          category: "thought_level",
          type: "select",
          currentValue: "high",
          options: [{ value: "high", name: "High" }],
          raw: {},
        },
      ]);

      resetSessionState(app);

      expect(app.state.availableCommands).toEqual([]);
      expect(app.state.thinkingConfigId).toBe("");
      expect(app.state.thinkingLevel).toBe("");
      expect(app.state.availableThinkingLevels).toEqual([]);
      expect(app.state.sessionConfigOptions).toEqual([]);
      dispose();
    });
  });

  test("addWelcomeBlocks does not load local skill resources", () => {
    const blocks: ChatBlock[] = [];

    addWelcomeBlocks((block) => blocks.push(block), "/tmp/project");

    const resourcesBlock = blocks.find(
      (block): block is InfoBlock => block.type === "info" && block.variant === "resources",
    );
    expect(resourcesBlock).toBeUndefined();
    expect(blocks).toHaveLength(1);
  });
});
