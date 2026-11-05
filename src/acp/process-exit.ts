import type { AcpProcessExitEvent } from "./transport";

const CONNECTION_CLOSED_ERROR_PATTERN =
  /AcpConnectionClosedError|ACP connection closed|ACP websocket (?:closed|is not open)/iu;

export const ACP_PROCESS_EXIT_STARTUP_SETTLE_MS = 50;
export const ACP_PROCESS_EXIT_PROMPT_GRACE_MS = 250;

export function formatUnexpectedProcessExitMessage(event: AcpProcessExitEvent): string {
  if (event.transport === "websocket") {
    return `${event.message ?? "ACP websocket closed unexpectedly"}. Start a new prompt to reconnect.`;
  }
  const detail = event.signal
    ? `signal ${event.signal}`
    : typeof event.code === "number"
      ? `code ${event.code}`
      : event.message;
  const suffix = detail ? ` (${detail})` : "";
  return `ACP agent process exited unexpectedly${suffix}. Start a new prompt to reconnect.`;
}

export function isConnectionClosedPromptError(message: string): boolean {
  return CONNECTION_CLOSED_ERROR_PATTERN.test(message);
}

export function promptErrorRaceDelay(message: string): Promise<void> {
  return Bun.sleep(isConnectionClosedPromptError(message) ? ACP_PROCESS_EXIT_PROMPT_GRACE_MS : 0);
}

export function startupProcessExitSettle(): Promise<void> {
  return Bun.sleep(ACP_PROCESS_EXIT_STARTUP_SETTLE_MS);
}
