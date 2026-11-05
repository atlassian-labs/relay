/**
 * Prompt submission entrypoints: user bash (`!`/`!!`), active-turn guidance,
 * and the top-level `handleSubmit` router.
 *
 * Extracted from app-root as a factory. `handleSubmit` / `handleActiveTurnInput`
 * are returned for the keyboard handler, plugin editor bridge, overlay submit,
 * and startup auto-submit; the bash runner and history helpers stay private.
 */

import { type UserBashBlock, nextBlockId, useApp } from "../state";
import type { AcpClient } from "../../acp/client";
import { promptInputText, type PromptInput } from "../../core/prompt-submission";
import type { InputUpdateSource } from "../component/composer";
import { promptHistory } from "../component/composer";
import { pasteStore } from "../paste";
import { applyTextareaTextUpdate } from "../util/paste-textarea";
import { runEffect } from "../../effect/runtime";
import type { PluginRunner, RelayUserBashEvent, RelayUserBashResult } from "../../plugins";
import { executeUserBashEffect, type UserBashResult } from "../../user-bash";
import { appendUserBashOutput, createUserBashBlock, finalizeUserBashBlock } from "../util/user-bash-block";
import { showToast } from "./toast-controller";
import { type ActiveTurnInputSubmission, validateActiveTurnInput } from "./active-turn-input";
import { currentEnv } from "../../platform/env";

type App = ReturnType<typeof useApp>;

export interface InputHandlersDeps {
  setWelcomeDismissed: (value: boolean) => void;
  setUserBashAbortController: (controller: AbortController | null) => void;
  textareaRef: () => any;
  getTextareaText: () => string;
  markInputUpdateSource: (source: InputUpdateSource, text: string) => void;
  acpClient: () => AcpClient | null;
  pluginRunner: () => PluginRunner | null;
  restoreRejectedPromptToComposerDraft?: (text: string) => boolean;
  queuePrompt: (
    input: PromptInput,
    app: App,
    placement?: "in-place" | "end",
    reason?: "queued" | "startup" | "active-turn-input-rejected" | "active-turn-input-error",
  ) => boolean;
  handleSlashCommand: (command: string, app: App) => Promise<void>;
  submitPromptToAgent: (input: PromptInput, app: App, queuePlacement?: "in-place" | "end") => Promise<void>;
}

export interface InputHandlers {
  handleSubmit: (input: PromptInput, app: App, queuePlacement?: "in-place" | "end") => void;
  handleActiveTurnInput: (submission: ActiveTurnInputSubmission, app: App) => void;
}

function isQuitTextCommand(text: string): boolean {
  return text.trim() === ":q";
}

function currentProcessEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(currentEnv())) {
    if (typeof value === "string") env[key] = value;
  }
  env.TERM = "dumb";
  return env;
}

function relayUserBashResultToUserBashResult(result: RelayUserBashResult): UserBashResult {
  return {
    output: result.output,
    exitCode: result.exitCode,
    cancelled: result.cancelled === true,
  };
}

export function createInputHandlers(deps: InputHandlersDeps): InputHandlers {
  const {
    setWelcomeDismissed,
    setUserBashAbortController,
    textareaRef,
    getTextareaText,
    markInputUpdateSource,
    acpClient,
    pluginRunner,
    restoreRejectedPromptToComposerDraft = () => false,
    queuePrompt,
    handleSlashCommand,
    submitPromptToAgent,
  } = deps;

  async function handleUserBashCommand(command: string, sendToLlm: boolean, app: App): Promise<void> {
    if (app.state.userBashRunning) {
      showToast("A bash command is already running. Press esc to cancel it first.", "warning");
      return;
    }

    setWelcomeDismissed(true);
    const excludeFromContext = !sendToLlm;
    const baseEvent: RelayUserBashEvent = {
      command,
      cwd: app.state.cwd,
      env: currentProcessEnv(),
      sendToAgent: sendToLlm,
      excludeFromContext,
    };
    const runner = pluginRunner();
    const prepared = runner ? await runner.beforeUserBashRun(baseEvent) : baseEvent;
    const block = createUserBashBlock(prepared.command, excludeFromContext);
    const blockId = block.id;
    app.addBlock(block);
    app.setState("userBashRunning", true);
    app.setState("userBashMode", false);

    const controller = new AbortController();
    setUserBashAbortController(controller);
    const appendOutput = (chunk: string) => {
      app.updateBlock(
        blockId,
        appendUserBashOutput(app.state.blocks.find((b) => b.id === blockId) as UserBashBlock | undefined, chunk),
      );
    };
    const handled = await runner?.runUserBash({ ...prepared, signal: controller.signal });
    const result = handled
      ? relayUserBashResultToUserBashResult(handled)
      : await runEffect(
          executeUserBashEffect(prepared.command, prepared.cwd, appendOutput, controller.signal, { env: prepared.env }),
        );
    setUserBashAbortController(null);
    app.setState("userBashRunning", false);

    app.updateBlock(blockId, finalizeUserBashBlock(result.output, result.exitCode, result.cancelled));

    // !! requests are attached to the next manual prompt; they never dispatch immediately.
    if (sendToLlm && !result.cancelled) {
      app.setState(
        "pendingUserBashResults",
        (prev: Array<{ command: string; output: string; exitCode: number | undefined }>) => [
          ...prev,
          { command: prepared.command, output: result.output, exitCode: result.exitCode },
        ],
      );
    }
  }

  function restorePromptInput(text: string): void {
    const _textareaRef = textareaRef();
    if (!_textareaRef) return;
    const currentText = getTextareaText();
    const nextText = currentText.trim() && currentText !== text ? `${text}\n\n${currentText}` : text;
    markInputUpdateSource("queue", nextText);
    applyTextareaTextUpdate(_textareaRef, nextText, nextText.length);
  }

  function addPromptToHistory(text: string, pasteMappings?: Record<number, string>): void {
    const trimmedText = text.trim();
    if (!trimmedText) return;
    promptHistory.add(
      trimmedText,
      pasteMappings ?? pasteStore.getPasteMappingsForText(trimmedText),
      acpClient()?.sessionId,
    );
  }

  function recordActiveTurnInputHistory(submission: ActiveTurnInputSubmission): void {
    addPromptToHistory(submission.historyText, submission.pasteMappings);
  }

  function handleActiveTurnInput(submission: ActiveTurnInputSubmission, app: App): void {
    const client = acpClient();
    const validation = validateActiveTurnInput(submission, {
      running: Boolean(client && app.state.running),
      supportsActiveTurnInput: Boolean(client?.supportsActiveTurnInput()),
    });
    if (!validation.ok) {
      if (validation.reason === "empty") return;
      showToast(validation.message ?? "Could not add to current turn", "warning");
      restorePromptInput(submission.text);
      return;
    }
    if (!client) return;

    client
      .sendActiveTurnInput(submission.text)
      .then((result) => {
        if (result.accepted) {
          recordActiveTurnInputHistory(submission);
          app.addBlock({
            type: "user",
            id: nextBlockId(),
            content: submission.text,
            delivery: "current-turn-guidance",
            origin: "local",
          });
          showToast("Added to current turn");
          return;
        }
        if (queuePrompt(submission.text, app, "end", "active-turn-input-rejected")) {
          recordActiveTurnInputHistory(submission);
        } else if (!restoreRejectedPromptToComposerDraft(submission.text)) {
          restorePromptInput(submission.text);
        }
      })
      .catch(() => {
        if (queuePrompt(submission.text, app, "end", "active-turn-input-error")) {
          recordActiveTurnInputHistory(submission);
        } else if (!restoreRejectedPromptToComposerDraft(submission.text)) {
          restorePromptInput(submission.text);
        }
      });
  }

  function handleSubmit(input: PromptInput, app: App, queuePlacement: "in-place" | "end" = "in-place"): void {
    const text = promptInputText(input);
    if (app.state.userBashRunning) {
      showToast("Bash command still running. Press esc to cancel it first.", "warning");
      return;
    }

    // Handle bash commands (! local-only, !! attached to the next manual prompt)
    if (text.startsWith("!")) {
      const sendToLlm = text.startsWith("!!");
      const command = (sendToLlm ? text.slice(2) : text.slice(1)).trim();
      if (!command) {
        showToast("Type a command after ! or !! to run bash.", "warning");
        return;
      }
      void handleUserBashCommand(command, sendToLlm, app);
      return;
    }

    if (isQuitTextCommand(text)) {
      void handleSlashCommand("/quit", app);
      return;
    }

    // Handle slash commands
    if (text.startsWith("/")) {
      void handleSlashCommand(text, app);
      return;
    }

    void submitPromptToAgent(input, app, queuePlacement);
  }

  return { handleSubmit, handleActiveTurnInput };
}
