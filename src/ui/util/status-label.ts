import type { AppState } from "../state";
import { formatDuration } from "./format";

export function statusLabel(state: AppState): string {
  if (state.spinnerLabel) return state.spinnerLabel;
  if (state.connecting) return `Connecting to ${state.connectingAgentName}...`;

  if (state.running || state.spinnerActive) return "Working...";

  if (state.elapsedSeconds > 0) return `${formatDuration(state.elapsedSeconds)} • ${state.toolCallCount} tool calls`;
  return "";
}
