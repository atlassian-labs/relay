import type { AcpSessionInfo } from "../../acp/client";
import type { SessionListPolicy } from "../../acp/agent-profile";
import type { ListItem } from "../autocomplete";
import { sessionListDescription, sessionListDescriptionColumns, sessionListLabel } from "../context/session";
import { buildResumeHierarchy, type ResumeHierarchyNode, type ResumeSessionRelation } from "./resume-hierarchy";

export type { SessionListPolicy } from "../../acp/agent-profile";

export const RESUME_PICKER_LAYOUT = {
  labelMinWidth: 0,
  labelMaxWidth: Number.MAX_SAFE_INTEGER,
  descriptionMaxWidth: 80,
  viewportReservedWidth: 0,
  descriptionColumns: [{ align: "left" }, { maxWidth: 18, align: "left" }],
} as const;

export function sortSessionsByRecent(sessions: AcpSessionInfo[]): AcpSessionInfo[] {
  return [...sessions].sort((a, b) => {
    const aTs = a.updatedAt ? Date.parse(a.updatedAt) : 0;
    const bTs = b.updatedAt ? Date.parse(b.updatedAt) : 0;
    return (Number.isFinite(bTs) ? bTs : 0) - (Number.isFinite(aTs) ? aTs : 0);
  });
}

export function isInternalSessionTitle(title: string | undefined, policy: SessionListPolicy = {}): boolean {
  return policy.isInternalSessionTitle?.(title) ?? false;
}

function isJunkSession(session: AcpSessionInfo, policy: SessionListPolicy): boolean {
  return policy.isJunkSession?.(session) ?? false;
}

function normalizeSession(session: AcpSessionInfo, policy: SessionListPolicy): AcpSessionInfo {
  return policy.normalizeSession?.(session) ?? session;
}

export function filterInternalSessions(sessions: AcpSessionInfo[], policy: SessionListPolicy = {}): AcpSessionInfo[] {
  return sessions.filter((session) => !isJunkSession(session, policy));
}

function sanitizeSessionForResumeList(session: AcpSessionInfo, policy: SessionListPolicy): AcpSessionInfo {
  // Hide unsafe provider-internal titles if a profile marks them internal but not junk.
  if (!isInternalSessionTitle(session.title, policy) && !isJunkSession(session, policy)) return session;
  return { ...session, title: undefined };
}

export function resumableSessions(sessions: AcpSessionInfo[], policy: SessionListPolicy = {}): AcpSessionInfo[] {
  return sortSessionsByRecent(filterInternalSessions(sessions, policy))
    .map((session) => normalizeSession(session, policy))
    .map((session) => sanitizeSessionForResumeList(session, policy));
}

export function sessionSelectionItems(
  sessions: AcpSessionInfo[],
  activeSessionId?: string | null,
): ListItem<AcpSessionInfo>[] {
  return sessions.map((session) => ({
    value: session,
    label: sessionListLabel(session),
    description: sessionListDescription(session),
    descriptionColumns: sessionListDescriptionColumns(session),
    active: session.sessionId === activeSessionId,
  }));
}

function appendHierarchyNode(
  items: ListItem<AcpSessionInfo>[],
  node: ResumeHierarchyNode<AcpSessionInfo>,
  activeSessionId: string | null | undefined,
  labelPrefix: string,
  childPrefix: string,
): void {
  const plainLabel = sessionListLabel(node.value);
  items.push({
    value: node.value,
    label: `${labelPrefix}${plainLabel}`,
    searchLabel: plainLabel,
    description: sessionListDescription(node.value),
    descriptionColumns: sessionListDescriptionColumns(node.value),
    active: node.value.sessionId === activeSessionId,
  });

  for (const child of node.children) {
    appendHierarchyNode(items, child, activeSessionId, `${childPrefix} L `, `${childPrefix}   `);
  }
}

export function hierarchicalSessionSelectionItems(
  sessions: AcpSessionInfo[],
  activeSessionId: string | null | undefined,
  relations: readonly ResumeSessionRelation[],
): ListItem<AcpSessionInfo>[] {
  const forest = buildResumeHierarchy(sessions, (session) => session.sessionId, relations);
  const items: ListItem<AcpSessionInfo>[] = [];
  for (const root of forest) appendHierarchyNode(items, root, activeSessionId, "", "");
  return items;
}

export function resumableSessionSelectionItems(
  sessions: AcpSessionInfo[],
  activeSessionId?: string | null,
  policy: SessionListPolicy = {},
  relations: readonly ResumeSessionRelation[] = [],
): ListItem<AcpSessionInfo>[] {
  const resumable = resumableSessions(sessions, policy);
  return relations.length > 0
    ? hierarchicalSessionSelectionItems(resumable, activeSessionId, relations)
    : sessionSelectionItems(resumable, activeSessionId);
}
