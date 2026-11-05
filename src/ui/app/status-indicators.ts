import { getConfig } from "../../config";
import { WELCOME_TIPS } from "../component/welcome-screen";
import { getPluginRunner } from "./plugin-runtime";

export type StartupTipSetter = (key: "startupTip", value: string) => void;
export type StatusHintSetter = (key: "statusHint", value: { key: string; label: string } | null) => void;
type AppStatusSetter = StartupTipSetter & StatusHintSetter;

type StartupTipHost = Pick<{ setState: StartupTipSetter }, "setState">;

let startupTipTimer: ReturnType<typeof setInterval> | null = null;
let startupTipIndex = 0;
let startupTipsDismissed = false;
let appSetState: AppStatusSetter | null = null;

export function setStatusIndicatorStateSetter(setter: AppStatusSetter | null): void {
  appSetState = setter;
}

export function resetStartupTipsDismissal(): void {
  startupTipsDismissed = false;
  startupTipIndex = 0;
}

export function stopStartupTips(app?: StartupTipHost, dismiss = true): void {
  if (startupTipTimer) {
    clearInterval(startupTipTimer);
    startupTipTimer = null;
  }
  if (dismiss) startupTipsDismissed = true;
  if (app) app.setState("startupTip", "");
  else appSetState?.("startupTip", "");
}

export function activeStartupTips(): readonly string[] {
  const runner = getPluginRunner();
  if (!runner) return [...WELCOME_TIPS];
  const pluginTips = runner.tips.active((plugin, error) =>
    runner.recordError(plugin, "Plugin tip predicate failed", error),
  );
  return [...WELCOME_TIPS, ...pluginTips.map((tip) => tip.text)];
}

function randomWelcomeTip(): string {
  const tips = activeStartupTips();
  return tips[Math.floor(Math.random() * tips.length)] ?? "";
}

export function setTurnTip(app: StartupTipHost): void {
  app.setState("startupTip", getConfig().ui.show_tips ? randomWelcomeTip() : "");
}

export function shouldResetIdleStartupTip(input: {
  readonly connecting: boolean;
  readonly running: boolean;
  readonly elapsedSeconds: number;
}): boolean {
  return !input.connecting && !input.running && input.elapsedSeconds <= 0;
}

export function startStartupTips(app: StartupTipHost): void {
  // Preserve the existing behavior: the startup tip slot is reset while the
  // agent is idle before any turn status is visible. Completed turn tips stay
  // paired with the elapsed/tool-call status until the next turn replaces them.
  void startupTipIndex;
  void startupTipsDismissed;
  app.setState("startupTip", "");
}

/** Show a temporary hint on the right side of the status line. */
export function showStatusHint(key: string, label: string): void {
  appSetState?.("statusHint", { key, label });
}

/** Clear the status hint. */
export function hideStatusHint(): void {
  appSetState?.("statusHint", null);
}
