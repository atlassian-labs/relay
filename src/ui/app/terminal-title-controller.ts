import { createEffect, createSignal, onCleanup } from "solid-js";
import { getConfig, subscribeConfig } from "../../config";
import type { AppState } from "../state";
import {
  createTerminalTitleActivityTracker,
  createTerminalTitleManager,
  hasPendingTerminalTitleAction,
  shouldAnimateTerminalTitleSpinner,
  type TerminalTitleOutput,
} from "../util/terminal-title";
import { getSpinnerChar } from "./spinner";

export function useManagedTerminalTitle(output: TerminalTitleOutput, state: AppState): void {
  if (output.isTTY !== true) return;

  const terminalTitleManager = createTerminalTitleManager(output);
  const activityTracker = createTerminalTitleActivityTracker();
  const [terminalTitlePromptSource, setTerminalTitlePromptSource] = createSignal(
    getConfig().ui.terminal_title_prompt_source,
  );
  const [activityClock, setActivityClock] = createSignal(Date.now());
  let activityClockTimer: ReturnType<typeof setTimeout> | undefined;
  let lastSpinnerFrame = "";
  const unsubscribeConfig = subscribeConfig((change) =>
    setTerminalTitlePromptSource(change.config.ui.terminal_title_prompt_source),
  );

  createEffect(() => {
    const nowMs = activityClock();
    const actionRequired = hasPendingTerminalTitleAction(state.blocks);
    const turnActive = Boolean(state.running || state.spinnerActive);
    const active =
      state.connecting ||
      activityTracker.isActive({
        nowMs,
        scopeKey: state.cwd,
        active: turnActive,
        actionRequired,
        activitySequence: state.lastAcpActivitySequence,
      });
    const animateSpinner =
      active &&
      shouldAnimateTerminalTitleSpinner({
        actionRequired,
        connecting: state.connecting,
        running: state.running,
        spinnerActive: state.spinnerActive,
      });
    let spinnerFrame = "";
    if (animateSpinner) {
      spinnerFrame = getSpinnerChar();
      lastSpinnerFrame = spinnerFrame;
    } else if (active && !actionRequired) {
      spinnerFrame = lastSpinnerFrame;
    } else if (!active) {
      lastSpinnerFrame = "";
    }
    terminalTitleManager.update({
      cwd: state.cwd,
      connecting: state.connecting,
      running: state.running,
      spinnerActive: state.spinnerActive,
      active,
      spinnerFrame,
      blocks: state.blocks,
      actionRequired,
      latestPromptTitleIntent: state.latestPromptTitleIntent,
      sessionTitle: state.threads.find((thread) => thread.id === state.activeThreadId)?.title,
      terminalTitlePromptSource: terminalTitlePromptSource(),
    });

    if (activityClockTimer !== undefined) {
      clearTimeout(activityClockTimer);
      activityClockTimer = undefined;
    }
    if (active && !state.connecting && !turnActive && !actionRequired) {
      activityClockTimer = setTimeout(() => setActivityClock(Date.now()), 2_050);
    }
  });
  onCleanup(() => {
    unsubscribeConfig();
    if (activityClockTimer !== undefined) clearTimeout(activityClockTimer);
    activityTracker.reset();
    terminalTitleManager.clear();
  });
}
