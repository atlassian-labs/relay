import { describe, expect, test } from "bun:test";
import type { AcpClient } from "../../../src/acp/client";
import { AcpRequestError } from "../../../src/effect/errors";
import {
  applyPreferredModelForNewSession,
  applyPreferredThinkingLevelForNewSession,
} from "../../../src/ui/app/acp-client-controller";
import { mergeSessionCapabilities, store } from "../../../src/ui/app/runtime-store";
import type { useApp } from "../../../src/ui/state";

type App = ReturnType<typeof useApp>;

function configValue(result: { configOptions?: unknown }, optionId: string): unknown {
  const options = Array.isArray(result.configOptions) ? result.configOptions : [];
  return options.find((option) => option && typeof option === "object" && "id" in option && option.id === optionId)
    ?.currentValue;
}

describe("preferred session config application", () => {
  test("retries a transient internal error when applying the preferred model", async () => {
    const calls: unknown[] = [];
    const client = {
      sessionId: "session-1",
      async setSessionModel(modelId: string, configId?: string, sessionId?: string) {
        calls.push({ modelId, configId, sessionId });
        if (calls.length === 1) {
          throw new AcpRequestError({
            message: "Internal error",
            code: -32603,
            data: { details: "Internal error. Read the server logs for more details." },
          });
        }
        return {};
      },
    } as unknown as AcpClient;
    const app = { state: {} } as App;
    const initial = {
      sessionId: "session-1",
      configOptions: [
        {
          id: "model",
          category: "model",
          type: "select",
          currentValue: "model-a",
          options: [
            { value: "model-a", name: "Model A" },
            { value: "model-b", name: "Model B" },
          ],
        },
      ],
    };

    const result = await applyPreferredModelForNewSession(app, client, "faux", initial, "model-b", "session-1", {
      updateAppState: false,
    });

    expect(calls).toEqual([
      { modelId: "model-b", configId: "model", sessionId: "session-1" },
      { modelId: "model-b", configId: "model", sessionId: "session-1" },
    ]);
    expect(configValue(result ?? {}, "model")).toBe("model-b");
  });

  test("synthesizes config options when setters return an empty response", async () => {
    store.launchThinkingLevelOverride = "";
    const calls: unknown[] = [];
    const client = {
      sessionId: "session-1",
      async setSessionModel(modelId: string, configId?: string, sessionId?: string) {
        calls.push({ type: "model", modelId, configId, sessionId });
        return {};
      },
      async setSessionThinkingLevel(thinkingLevel: string, configId: string, sessionId?: string) {
        calls.push({ type: "thinking", thinkingLevel, configId, sessionId });
        return {};
      },
    } as unknown as AcpClient;
    const app = { state: {} } as App;
    const initial = {
      sessionId: "session-1",
      configOptions: [
        {
          id: "model",
          category: "model",
          type: "select",
          currentValue: "model-a",
          options: [
            { value: "model-a", name: "Model A" },
            { value: "model-b", name: "Model B" },
          ],
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
    };

    const modelResult = await applyPreferredModelForNewSession(app, client, "faux", initial, "model-b", "session-1", {
      updateAppState: false,
    });
    const latest = modelResult ? mergeSessionCapabilities(initial, modelResult) : initial;
    const thinkingResult = await applyPreferredThinkingLevelForNewSession(
      app,
      client,
      "faux",
      latest,
      "high",
      "session-1",
      { updateAppState: false },
    );
    const finalResult = thinkingResult ? mergeSessionCapabilities(latest, thinkingResult) : latest;

    expect(calls).toEqual([
      { type: "model", modelId: "model-b", configId: "model", sessionId: "session-1" },
      { type: "thinking", thinkingLevel: "high", configId: "thought_level", sessionId: "session-1" },
    ]);
    expect(configValue(finalResult, "model")).toBe("model-b");
    expect(configValue(finalResult, "thought_level")).toBe("high");
  });
});
