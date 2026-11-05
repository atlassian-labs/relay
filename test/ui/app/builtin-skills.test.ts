import { afterEach, describe, expect, test } from "bun:test";
import {
  clearReviewContextProvidersForTests,
  reviewBuiltinSkill,
  registerReviewContextProvider,
  type ReviewContext,
} from "../../../src/builtin-skills/review";
import { relayPluginsBuiltinSkill } from "../../../src/builtin-skills/relay-plugins";
import { createBuiltinSkillController, type App } from "../../../src/ui/app/builtin-skills";
import type { PromptSubmissionOptions } from "../../../src/ui/app/submit-controller";

function reviewContext(overrides: Partial<ReviewContext> = {}): ReviewContext {
  return {
    cwd: "/tmp/relay-review",
    sessionId: "session-1",
    threadId: "thread-1",
    userMessageCount: 1,
    running: false,
    waitForIdle: () => Promise.resolve(),
    toast: () => undefined,
    ...overrides,
  };
}

describe("built-in skill controller", () => {
  afterEach(() => {
    clearReviewContextProvidersForTests();
  });

  test("submits the generic review prompt when no provider supplies context", async () => {
    const submitted: Array<{ readonly text: string; readonly options?: PromptSubmissionOptions }> = [];
    const controller = createBuiltinSkillController({
      submitPromptToAgent: async (text, _app, _queuePlacement, options) => {
        submitted.push({ text, options });
      },
    });

    await controller.runCommand({} as App, reviewBuiltinSkill, "", reviewContext());

    expect(submitted).toHaveLength(1);
    expect(submitted[0].text).toContain('<skill name="review" location="relay://builtin-skills/review">');
    expect(submitted[0].text).toContain("Review all uncommitted changes");
    expect(submitted[0].text).toContain("## Overall correctness");
    expect(submitted[0].text).not.toContain("Bitbucket Pull Request Context");
    expect(submitted[0].options).toEqual({
      source: "plugin",
      localEchoSkillInvocation: { name: "review" },
    });
  });

  test("injects provider context into the native review prompt", async () => {
    registerReviewContextProvider({
      id: "test-provider",
      canResolve(args) {
        return args.trim() === "#214";
      },
      resolve() {
        return { title: "Provider Context", content: "diff --git a/file.ts b/file.ts" };
      },
    });
    const submitted: Array<{ readonly text: string; readonly options?: PromptSubmissionOptions }> = [];
    const controller = createBuiltinSkillController({
      submitPromptToAgent: async (text, _app, _queuePlacement, options) => {
        submitted.push({ text, options });
      },
    });

    await controller.runCommand({} as App, reviewBuiltinSkill, "#214", reviewContext());

    expect(submitted).toHaveLength(1);
    expect(submitted[0].text).toContain("## Provider Context");
    expect(submitted[0].text).toContain("diff --git a/file.ts b/file.ts");
    expect(submitted[0].text).toContain("Input: #214");
    expect(submitted[0].options).toEqual({
      source: "plugin",
      localEchoSkillInvocation: { name: "review", userMessage: "#214" },
    });
  });

  test("submits bundled plugin guidance with a compact skill echo", async () => {
    const submitted: Array<{ readonly text: string; readonly options?: PromptSubmissionOptions }> = [];
    const controller = createBuiltinSkillController({
      submitPromptToAgent: async (text, _app, _queuePlacement, options) => {
        submitted.push({ text, options });
      },
    });

    await controller.runCommand({} as App, relayPluginsBuiltinSkill, "add a command", reviewContext());

    expect(submitted).toHaveLength(1);
    expect(submitted[0].text).toContain('<skill name="relay-plugins" location="relay://builtin-skills/relay-plugins">');
    expect(submitted[0].text).toContain("Create plugins against Relay's public plugin SDK");
    expect(submitted[0].text).toContain("# Bundled Relay Extensions Reference");
    expect(submitted[0].text).toContain("\n\nadd a command");
    expect(submitted[0].options).toEqual({
      source: "plugin",
      localEchoSkillInvocation: { name: "relay-plugins", userMessage: "add a command" },
    });
  });
});
