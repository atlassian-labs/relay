import type { AcpSessionInfo } from "./client";
import type { PromptContentPolicy } from "./prompt-content";
import { altaAgentBehaviorProfile } from "./profiles/alta";
import { claudeAgentBehaviorProfile } from "./profiles/claude";
import { codexAgentBehaviorProfile } from "./profiles/codex";
import { defaultAgentBehaviorProfile } from "./profiles/default";
import { rovodevAgentBehaviorProfile } from "./profiles/rovodev";

/** Provider-normalized lifecycle data consumed by outer plugin and telemetry adapters. */
export type AgentLifecycleEvent = {
  readonly type: "agent:lifecycle";
  readonly agent: string;
  readonly name: string;
  readonly phase?: string;
  readonly payload: unknown;
  readonly raw: unknown;
};

export interface SessionListPolicy {
  isInternalSessionTitle?: (title: string | undefined) => boolean;
  isJunkSession?: (session: AcpSessionInfo) => boolean;
  normalizeSession?: (session: AcpSessionInfo) => AcpSessionInfo;
}

export interface LifecycleEventNormalizer {
  readonly normalize: (update: unknown) => AgentLifecycleEvent | null;
}

export interface ElicitationPolicy {
  /** Compatibility extension for agents whose question UI accepts custom values for enum fields. */
  readonly allowCustomEnumInput?: boolean;
}

// -----------------------------------------------------------------------------
// Temporary Rovo Dev ACP compatibility
// Remove this facade surface once Rovo advertises native session/list and
// session/fork and supports session/set_config_option for model selection.
// -----------------------------------------------------------------------------

export interface SessionListFacadeContext {
  readonly cwd?: string;
  readonly agentEnv?: Readonly<Record<string, string>>;
}

export type SessionListFacade = (
  context: SessionListFacadeContext,
) => readonly AcpSessionInfo[] | Promise<readonly AcpSessionInfo[]>;

export interface SessionForkFacadeContext extends SessionListFacadeContext {
  readonly cwd: string;
  readonly sessionId: string;
}

export interface SessionForkFacadeResult {
  readonly sessionId: string;
}

export type SessionForkFacade = (
  context: SessionForkFacadeContext,
) => SessionForkFacadeResult | Promise<SessionForkFacadeResult>;

export interface SessionLifecycleFacade {
  readonly listSessions?: SessionListFacade;
  readonly forkSession?: SessionForkFacade;
  /** Forced legacy method for agents that do not support session/set_config_option. */
  readonly legacySetModelMethod?: string;
}

export interface AgentBehaviorProfile {
  readonly id: string;
  readonly sessionListPolicy?: SessionListPolicy;
  /** Local compatibility for agents missing optional ACP session lifecycle methods. */
  readonly sessionLifecycleFacade?: SessionLifecycleFacade;
  readonly promptContentPolicy?: PromptContentPolicy;
  readonly lifecycleEventNormalizer?: LifecycleEventNormalizer;
  readonly elicitationPolicy?: ElicitationPolicy;
}

export interface AgentBehaviorProfileOptions {
  readonly internalSessionTitleAliases?: readonly string[];
}

const AGENT_BEHAVIOR_PROFILES: Record<string, AgentBehaviorProfile> = {
  default: defaultAgentBehaviorProfile,
  alta: altaAgentBehaviorProfile,
  codex: codexAgentBehaviorProfile,
  claude: claudeAgentBehaviorProfile,
  rovodev: rovodevAgentBehaviorProfile,
};

function normalizeInternalTitleAlias(alias: string): string | null {
  const normalized = alias.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(normalized)) return null;
  return normalized;
}

function withInternalSessionTitleAliases(
  profile: AgentBehaviorProfile,
  aliases: readonly string[],
): AgentBehaviorProfile {
  const normalizedAliases = new Set(aliases.map(normalizeInternalTitleAlias).filter((alias) => alias !== null));
  if (normalizedAliases.size === 0) return profile;
  const basePolicy = profile.sessionListPolicy ?? {};
  const isInternalAlias = (title: string | undefined): boolean => {
    const normalizedTitle = title ? normalizeInternalTitleAlias(title) : null;
    return normalizedTitle !== null && normalizedAliases.has(normalizedTitle);
  };

  return {
    ...profile,
    sessionListPolicy: {
      ...basePolicy,
      isInternalSessionTitle: (title) =>
        isInternalAlias(title) || (basePolicy.isInternalSessionTitle?.(title) ?? false),
      isJunkSession: (session) => isInternalAlias(session.title) || (basePolicy.isJunkSession?.(session) ?? false),
    },
  };
}

export function resolveAgentBehaviorProfile(
  profile?: string | null,
  options: AgentBehaviorProfileOptions = {},
): AgentBehaviorProfile {
  const normalized = (profile ?? "").trim().toLowerCase();
  const behaviorProfile = normalized
    ? (AGENT_BEHAVIOR_PROFILES[normalized] ?? defaultAgentBehaviorProfile)
    : defaultAgentBehaviorProfile;
  if (behaviorProfile.id !== "alta") return behaviorProfile;
  return withInternalSessionTitleAliases(behaviorProfile, options.internalSessionTitleAliases ?? []);
}
