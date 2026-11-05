import type { BuiltinSkill } from "../../builtin-skills/types";
import type { RelayCommandContext } from "../../plugins";
import type { useApp } from "../state";
import type { PromptSubmissionOptions } from "./submit-controller";

export type App = ReturnType<typeof useApp>;

export interface BuiltinSkillControllerDeps {
  readonly submitPromptToAgent: (
    text: string,
    app: App,
    queuePlacement?: "in-place" | "end",
    options?: PromptSubmissionOptions,
  ) => Promise<void>;
}

export interface BuiltinSkillController {
  readonly runCommand: (app: App, skill: BuiltinSkill, args: string, ctx: RelayCommandContext) => Promise<void>;
}

export function createBuiltinSkillController(deps: BuiltinSkillControllerDeps): BuiltinSkillController {
  async function runCommand(app: App, skill: BuiltinSkill, args: string, ctx: RelayCommandContext): Promise<void> {
    const userMessage = args.trim();
    const prompt = await skill.createPrompt(args, ctx);
    await deps.submitPromptToAgent(prompt, app, "in-place", {
      source: "plugin",
      localEchoSkillInvocation: {
        name: skill.name,
        ...(userMessage ? { userMessage } : {}),
      },
    });
  }

  return { runCommand };
}
