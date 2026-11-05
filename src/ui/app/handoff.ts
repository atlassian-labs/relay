import type { AcpClient, AcpSessionResult } from "../../acp/client";
import type { CreateChildSessionInput } from "../../core/live-sessions";
import { renderPromptTemplate } from "../../core/prompt-template";
import { additionalDirectoriesForThread, type ThreadInfo } from "../../core/threads";
import { getPromptTemplate } from "../../prompt-templates";
import type { RelayCommandContext, RelayPluginStatus } from "../../plugins";
import type { useApp } from "../state";
import { nextBlockId } from "../state";
import { currentThread } from "./thread-metadata";

export const HANDOFF_COMMAND = "handoff";
export const HANDOFF_STATUS_KEY = "handoff";

type App = ReturnType<typeof useApp>;

export interface HandoffControllerDeps {
  readonly showToast: (message: string, variant?: "info" | "warning" | "error", durationMs?: number) => void;
  readonly setNativeStatus: (key: string, value: RelayPluginStatus | undefined) => void;
  readonly ensureThreadSession: (
    app: App,
    thread: ThreadInfo,
  ) => Promise<{ readonly client: AcpClient; readonly result?: AcpSessionResult }>;
  readonly runHiddenPrompt: (sessionId: string, text: string, app: App) => Promise<string>;
  readonly createChildSession: (input: CreateChildSessionInput) => Promise<ThreadInfo>;
}

export interface HandoffController {
  readonly runCommand: (app: App, args: string, ctx: RelayCommandContext) => Promise<void>;
}

function addWarning(app: App, message: string): void {
  app.addBlock({ type: "info", id: nextBlockId(), content: message, variant: "warning" });
}

async function cleanupScratchSession(client: AcpClient, sessionId: string): Promise<void> {
  if (client.supportsSessionDelete()) {
    await client.deleteSession(sessionId).catch(() => undefined);
    return;
  }
  if (client.supportsSessionClose()) await client.closeSession(sessionId).catch(() => undefined);
}

export function createHandoffController(deps: HandoffControllerDeps): HandoffController {
  return {
    async runCommand(app, args, ctx) {
      const goal = args.trim();
      if (!goal) {
        addWarning(app, "Usage: /handoff <new thread goal>");
        return;
      }
      if (ctx.running) {
        addWarning(
          app,
          "Cannot create a summarized handoff while the agent is running. Use relay start session instead.",
        );
        return;
      }
      const parent = currentThread(app);
      if (!parent) {
        addWarning(app, "No active thread to hand off.");
        return;
      }

      deps.setNativeStatus(HANDOFF_STATUS_KEY, { text: "Creating handoff...", spinner: true });
      try {
        const source = await deps.ensureThreadSession(app, parent);
        const sourceSessionId = source.client.sessionId ?? source.result?.sessionId ?? parent.sessionId;
        if (!sourceSessionId) throw new Error("No active ACP session to hand off"); // effect-shape-allow: slash command reports missing session.
        if (!source.client.supportsSessionFork()) throw new Error("This ACP agent did not advertise session/fork"); // effect-shape-allow: slash command reports unsupported capability.
        const scratch = await source.client.forkSession(
          parent.cwd,
          sourceSessionId,
          additionalDirectoriesForThread(parent, app.state.threads),
        );
        if (!scratch.sessionId) throw new Error("ACP session/fork response missing sessionId"); // effect-shape-allow: slash command validates ACP response.
        let openingPrompt = "";
        try {
          openingPrompt = (
            await deps.runHiddenPrompt(
              scratch.sessionId,
              renderPromptTemplate(getPromptTemplate("handoff"), { goal }),
              app,
            )
          ).trim();
        } finally {
          await cleanupScratchSession(source.client, scratch.sessionId);
        }
        if (!openingPrompt) throw new Error("Handoff prompt was empty"); // effect-shape-allow: slash command validates generated prompt.
        const child = await deps.createChildSession({
          parentSessionId: parent.relaySessionId ?? parent.id,
          task: goal,
          openingPrompt,
          relation: "handoff",
        });
        deps.showToast(`Handoff started: ${child.title}`, "info", 2500);
      } catch (error) {
        deps.showToast(`Handoff failed: ${error instanceof Error ? error.message : String(error)}`, "error", 6000);
      } finally {
        deps.setNativeStatus(HANDOFF_STATUS_KEY, undefined);
      }
    },
  };
}
