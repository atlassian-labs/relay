import * as path from "node:path";
import { uuid } from "../../platform/crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "../../platform/fs";
import { currentEnv, getHomeEnv } from "../../platform/env";
import type { AcpSessionInfo } from "../client";
import type {
  AgentBehaviorProfile,
  SessionForkFacadeContext,
  SessionForkFacadeResult,
  SessionListFacadeContext,
} from "../agent-profile";

// -----------------------------------------------------------------------------
// Temporary Rovo Dev ACP compatibility
// Remove this module once Rovo advertises native session/list and session/fork
// and supports session/set_config_option for model selection.
// -----------------------------------------------------------------------------

type RovoSessionMetadata = {
  readonly title?: string;
  readonly workspace_path?: string;
};

type RovoSessionContext = {
  readonly id?: string;
  readonly deps?: {
    readonly artifacts?: {
      readonly "metadata.json"?: RovoSessionMetadata;
    };
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rovoSessionMetadata(value: unknown): RovoSessionMetadata | null {
  if (!isRecord(value)) return null;
  const title = typeof value.title === "string" ? value.title : undefined;
  const workspacePath = typeof value.workspace_path === "string" ? value.workspace_path : undefined;
  return title === undefined && workspacePath === undefined ? null : { title, workspace_path: workspacePath };
}

function rovoSessionContext(value: unknown): RovoSessionContext | null {
  if (!isRecord(value)) return null;
  const deps = isRecord(value.deps) ? value.deps : null;
  const artifacts = deps && isRecord(deps.artifacts) ? deps.artifacts : null;
  return {
    id: typeof value.id === "string" ? value.id : undefined,
    deps: artifacts
      ? {
          artifacts: {
            "metadata.json": rovoSessionMetadata(artifacts["metadata.json"]) ?? undefined,
          },
        }
      : undefined,
  };
}

function jsonFile(pathname: string): unknown | null {
  try {
    return JSON.parse(readFileSync(pathname, "utf-8")) as unknown;
  } catch {
    return null;
  }
}

function rovoStoragePath(context: SessionListFacadeContext): string | null {
  const env = { ...currentEnv(), ...context.agentEnv };
  const configuredPath = env.ROVODEV_USER_DIR?.trim();
  if (configuredPath) return path.resolve(configuredPath);
  const home = env.HOME?.trim() || env.USERPROFILE?.trim() || getHomeEnv();
  return home && path.isAbsolute(home) ? path.join(home, ".rovo") : null;
}

function rovoWorkspaceRoot(workspacePath: string): string {
  const resolved = path.resolve(workspacePath);
  const segments = resolved.split(path.sep);
  for (let index = 0; index + 1 < segments.length; index += 1) {
    if (segments[index] !== ".rovodev" || segments[index + 1] !== "worktrees") continue;
    const root = segments.slice(0, index).join(path.sep);
    return root || path.parse(resolved).root;
  }
  return resolved;
}

function matchesWorkspace(metadata: RovoSessionMetadata | undefined, cwd: string | undefined): boolean {
  if (!cwd) return true;
  return !!metadata?.workspace_path && rovoWorkspaceRoot(metadata.workspace_path) === rovoWorkspaceRoot(cwd);
}

function safeSessionId(sessionId: string): boolean {
  return !!sessionId && sessionId !== "." && sessionId !== ".." && path.basename(sessionId) === sessionId;
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  // effect-shape-allow: synchronous persisted-session facade validates untrusted disk data for its Effect caller.
  if (!isRecord(value)) throw new Error(`Invalid Rovo session: ${label} must be an object`);
  return value;
}

function serializedJson(value: unknown): string {
  return `${JSON.stringify(value, null, 4)}\n`;
}

/**
 * Lists the on-disk sessions Rovo Dev would otherwise expose through ACP
 * session/list. Rovo currently supports session/load but does not advertise
 * or implement session/list, even though it persists sessions locally.
 */
export function listRovodevSessions(context: SessionListFacadeContext): AcpSessionInfo[] {
  const storagePath = rovoStoragePath(context);
  if (!storagePath) return [];
  const sessionsPath = path.join(storagePath, "sessions");
  if (!existsSync(sessionsPath)) return [];

  try {
    const sessions: AcpSessionInfo[] = [];
    for (const entry of readdirSync(sessionsPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const sessionPath = path.join(sessionsPath, entry.name);
      const contextPath = path.join(sessionPath, "session_context.json");
      const sessionContext = rovoSessionContext(jsonFile(contextPath));
      const sessionId = sessionContext?.id?.trim();
      if (!sessionId) continue;

      const metadata =
        rovoSessionMetadata(jsonFile(path.join(sessionPath, "metadata.json"))) ??
        sessionContext?.deps?.artifacts?.["metadata.json"];
      if (!matchesWorkspace(metadata, context.cwd)) continue;
      const updatedAt = statSync(contextPath).mtime.toISOString();
      sessions.push({
        sessionId,
        ...(metadata?.title?.trim() ? { title: metadata.title.trim() } : {}),
        ...(metadata?.workspace_path?.trim() ? { cwd: metadata.workspace_path } : {}),
        updatedAt,
      });
    }
    return sessions;
  } catch {
    // A concurrent Rovo session write must not make the resume picker fail.
    return [];
  }
}

/**
 * Creates a full-history Rovo fork using the same persisted shape as Rovo's
 * fork_session helper, then lets the agent's existing session/load support
 * hydrate it. The temporary directory prevents Rovo from seeing a partial fork.
 */
export function forkRovodevSession(context: SessionForkFacadeContext): SessionForkFacadeResult {
  // effect-shape-allow: synchronous session facade rejects unsafe disk path input for its Effect caller.
  if (!safeSessionId(context.sessionId)) throw new Error("Invalid Rovo source session ID");
  const storagePath = rovoStoragePath(context);
  // effect-shape-allow: synchronous session facade reports unresolved provider storage to its Effect caller.
  if (!storagePath) throw new Error("Unable to resolve Rovo storage directory");

  const sessionsPath = path.join(storagePath, "sessions");
  const sourcePath = path.join(sessionsPath, context.sessionId);
  const sourceContextPath = path.join(sourcePath, "session_context.json");
  const sourceContext = requiredRecord(jsonFile(sourceContextPath), "session_context.json");
  // effect-shape-allow: synchronous session facade validates persisted provider identity for its Effect caller.
  if (sourceContext.id !== context.sessionId) throw new Error("Rovo session ID does not match its storage directory");
  if (!Array.isArray(sourceContext.message_history)) {
    // effect-shape-allow: synchronous session facade validates persisted provider history for its Effect caller.
    throw new Error("Invalid Rovo session: message_history must be an array");
  }

  const deps = requiredRecord(sourceContext.deps, "deps");
  const artifacts = requiredRecord(deps.artifacts, "deps.artifacts");
  const embeddedMetadata = artifacts["metadata.json"];
  const sidecarMetadata = jsonFile(path.join(sourcePath, "metadata.json"));
  const sourceMetadata = isRecord(sidecarMetadata)
    ? { ...sidecarMetadata }
    : isRecord(embeddedMetadata)
      ? { ...embeddedMetadata }
      : {};
  const workspacePath =
    typeof sourceMetadata.workspace_path === "string"
      ? sourceMetadata.workspace_path
      : typeof sourceContext.workspace_path === "string"
        ? sourceContext.workspace_path
        : "";
  if (!workspacePath || rovoWorkspaceRoot(workspacePath) !== rovoWorkspaceRoot(context.cwd)) {
    // effect-shape-allow: synchronous session facade prevents cross-workspace disk forks for its Effect caller.
    throw new Error("Rovo source session does not belong to the current workspace");
  }

  const newSessionId = uuid();
  const sourceTitle =
    typeof sourceMetadata.title === "string" && sourceMetadata.title.trim()
      ? sourceMetadata.title.trim()
      : "Untitled Session";
  const forkMetadata: Record<string, unknown> = {
    ...sourceMetadata,
    title: `Fork of ${sourceTitle}`,
    workspace_path: workspacePath,
    is_manual_title: false,
    fork_data: {
      parent_session_id: context.sessionId,
      fork_point: sourceContext.message_history.length,
    },
  };

  sourceContext.id = newSessionId;
  sourceContext.prompts = [];
  sourceContext.initial_prompt = "";
  sourceContext.deferred_results = null;
  artifacts["metadata.json"] = forkMetadata;

  mkdirSync(sessionsPath, { recursive: true });
  const destinationPath = path.join(sessionsPath, newSessionId);
  const temporaryPath = path.join(storagePath, `.relay-fork-${newSessionId}-${uuid()}`);
  // effect-shape-allow: synchronous session facade reports an atomic-fork destination collision to its Effect caller.
  if (existsSync(destinationPath)) throw new Error("Generated Rovo fork session already exists");

  try {
    mkdirSync(temporaryPath, { recursive: false });
    writeFileSync(path.join(temporaryPath, "session_context.json"), serializedJson(sourceContext), "utf-8");
    writeFileSync(path.join(temporaryPath, "metadata.json"), serializedJson(forkMetadata), "utf-8");
    renameSync(temporaryPath, destinationPath);
  } catch (error) {
    rmSync(temporaryPath, { recursive: true, force: true });
    // effect-shape-allow: synchronous session facade preserves the original atomic filesystem failure.
    throw error;
  }

  return { sessionId: newSessionId };
}

// TODO(rovo-acp-elicitation): Rovo's ask_user_questions tool raises CallDeferred,
// but its ACP server currently renders it as a generic tool call instead of an
// elicitation/create request. A profile can render metadata but cannot submit
// DeferredToolResults back to Rovo, so this requires an Acra-side bridge.
// That bridge should map question choices to an ACP form, await the response,
// resume the same agent turn with the deferred result, and handle cancel/decline.
// Cover exit_plan_mode too: it uses the same deferred-tool mechanism.
// Once Rovo emits elicitation requests, add Rovo-specific parent-card polish here.
export const rovodevAgentBehaviorProfile: AgentBehaviorProfile = {
  id: "rovodev",
  sessionLifecycleFacade: {
    listSessions: listRovodevSessions,
    forkSession: forkRovodevSession,
    legacySetModelMethod: "session/set_model",
  },
};
