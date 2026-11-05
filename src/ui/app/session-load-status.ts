import { truncateTextEnd } from "../util/format";

const SESSION_LOAD_STATUS_MAX_LENGTH = 32;

function sessionLoadDescriptor(sessionId: string, sessionTitle?: string): string {
  const normalizedTitle = sessionTitle?.replace(/\s+/g, " ").trim();
  const normalizedId = sessionId.replace(/\s+/g, " ").trim();
  return truncateTextEnd(normalizedTitle || normalizedId || "unknown", SESSION_LOAD_STATUS_MAX_LENGTH);
}

export function sessionLoadStatus(sessionId: string, sessionTitle?: string): string {
  return `Loading session: ${sessionLoadDescriptor(sessionId, sessionTitle)}`;
}
