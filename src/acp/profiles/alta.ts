import type { AcpSessionInfo } from "../client";
import type { AgentBehaviorProfile, AgentLifecycleEvent, SessionListPolicy } from "../agent-profile";
import type { PromptContentPolicy } from "../prompt-content";

// Alta's local dev queue store caps a prompt message at 128 KiB. Fit each
// encoded image below that limit and leave room for text plus the JSON-RPC
// envelope around the assembled prompt.
// TODO(alta-image-size-limit): remove these Alta-specific image/prompt
// budgets once Alta lifts the prompt-size limit; generic ACP prompt building
// should remain unconstrained unless another provider needs a policy.
export const ALTA_IMAGE_BYTE_BUDGET = 96 * 1024;
export const ALTA_PROMPT_BYTE_BUDGET = 120 * 1024;
export const ALTA_SESSION_LIST_META_KEY = "alta/session-list";
export type AltaSessionWorkspaceScope = "current-cwd" | "same-project" | "other-project" | "unknown";

export interface AltaSessionListMeta {
  readonly cwdExists?: boolean | undefined;
  readonly workspaceScope?: AltaSessionWorkspaceScope | undefined;
}

// The user's original text still contains the image path (for example,
// `@/tmp/pic.png`). Alta agents tend to call a file-read tool for that path even
// when Relay has already embedded the image content, so the Alta profile keeps
// the existing provider-specific nudge near attached path-backed images.
export const ALTA_IMAGE_ATTACHMENT_NOTE =
  "The image(s) referenced in this message are attached directly below as image content — view them inline and do not use a file-reading tool to open local image paths.";

const ALTA_CACHE_AGENT_PATH_PATTERNS = ["/.cache/alta/agents/", "/.alta/cache/agents/"] as const;
const ALTA_SOURCE_ONLY_META_KEYS = new Set(["altaSourceStatus", "altaAgentSource", ALTA_SESSION_LIST_META_KEY]);

function isYamlPathTitle(title: string | undefined): boolean {
  return title !== undefined && title.startsWith("/") && /\.ya?ml$/iu.test(title);
}

export function isAltaInternalSessionTitle(title: string | undefined): boolean {
  return isYamlPathTitle(title) && ALTA_CACHE_AGENT_PATH_PATTERNS.some((pattern) => title?.includes(pattern) ?? false);
}

function isAltaSourceOnlyMeta(session: AcpSessionInfo): boolean {
  if (session.metadata && Object.keys(session.metadata).some((key) => key !== "relay")) return false;
  const meta = session._meta;
  if (!meta) return false;
  const keys = Object.keys(meta);
  return keys.length > 0 && keys.every((key) => ALTA_SOURCE_ONLY_META_KEYS.has(key));
}

function altaPromptPreviewTitle(session: AcpSessionInfo): string | null {
  const firstPromptPreview = session._meta?.altaFirstUserPromptPreview;
  const title = typeof firstPromptPreview === "string" ? firstPromptPreview.trim() : "";
  return title || null;
}

function decodeAltaWorkspaceScope(value: unknown): AltaSessionWorkspaceScope | undefined {
  if (value === "current-cwd" || value === "same-project" || value === "other-project") return value;
  return typeof value === "string" ? "unknown" : undefined;
}

export function readAltaSessionListMeta(session: AcpSessionInfo): AltaSessionListMeta | null {
  const meta = session._meta?.[ALTA_SESSION_LIST_META_KEY];
  if (!isRecord(meta)) return null;
  const cwdExists = typeof meta.cwdExists === "boolean" ? meta.cwdExists : undefined;
  const workspaceScope = decodeAltaWorkspaceScope(meta.workspaceScope);
  return {
    ...(cwdExists === undefined ? {} : { cwdExists }),
    ...(workspaceScope === undefined ? {} : { workspaceScope }),
  };
}

function isNonCurrentAltaWorkspaceSession(session: AcpSessionInfo): boolean {
  const meta = readAltaSessionListMeta(session);
  if (meta?.cwdExists === false) return true;
  return meta?.workspaceScope !== undefined && meta.workspaceScope !== "current-cwd";
}

function titleMatchesAltaAgentSource(session: AcpSessionInfo): boolean {
  const source = isRecord(session._meta?.altaAgentSource) ? session._meta.altaAgentSource : null;
  const sourcePath = typeof source?.path === "string" ? source.path : "";
  return sourcePath !== "" && sourcePath === session.title;
}

function isAltaJunkSession(session: AcpSessionInfo): boolean {
  if (isNonCurrentAltaWorkspaceSession(session)) return true;
  if (isAltaInternalSessionTitle(session.title)) return true;
  if (session.updatedAt == null && isYamlPathTitle(session.title)) return true;
  return isYamlPathTitle(session.title) && titleMatchesAltaAgentSource(session) && isAltaSourceOnlyMeta(session);
}

function normalizeAltaSession(session: AcpSessionInfo): AcpSessionInfo {
  if (!isYamlPathTitle(session.title) || !titleMatchesAltaAgentSource(session)) return session;
  const title = altaPromptPreviewTitle(session);
  return title === null ? session : { ...session, title };
}

export const altaSessionListPolicy: SessionListPolicy = {
  isInternalSessionTitle: isAltaInternalSessionTitle,
  isJunkSession: isAltaJunkSession,
  normalizeSession: normalizeAltaSession,
};

export const altaPromptContentPolicy: PromptContentPolicy = {
  imageByteBudget: ALTA_IMAGE_BYTE_BUDGET,
  promptByteBudget: ALTA_PROMPT_BYTE_BUDGET,
  pathImageAttachmentNote: ALTA_IMAGE_ATTACHMENT_NOTE,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeAltaAgentLifecycleEvent(update: unknown): AgentLifecycleEvent | null {
  if (!isRecord(update)) return null;
  if (update.sessionUpdate !== "agent_lifecycle_event") return null;
  const agent = typeof update.agent === "string" ? update.agent : "";
  const meta = isRecord(update._meta) ? update._meta : {};
  const vendor = typeof meta.vendor === "string" ? meta.vendor : "";
  if (agent !== "alta" && vendor !== "atlassian.alta") return null;
  const event = isRecord(update.event) ? update.event : {};
  const name = typeof event.name === "string" ? event.name : "";
  if (!name) return null;
  return {
    type: "agent:lifecycle",
    agent: agent || "alta",
    name,
    phase: typeof event.phase === "string" ? event.phase : undefined,
    payload: event.payload,
    raw: update,
  };
}

export const altaAgentBehaviorProfile: AgentBehaviorProfile = {
  id: "alta",
  sessionListPolicy: altaSessionListPolicy,
  promptContentPolicy: altaPromptContentPolicy,
  lifecycleEventNormalizer: {
    normalize: normalizeAltaAgentLifecycleEvent,
  },
  elicitationPolicy: {
    // Alta's ask_user_questions UI treats enum values as suggestions and accepts a custom answer.
    allowCustomEnumInput: true,
  },
};
