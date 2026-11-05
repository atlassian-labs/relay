import type { AgentBehaviorProfile } from "../acp/agent-profile";
import type { AgentLifecycleEvent } from "./types";

export function normalizeAgentLifecycleEvent(
  update: unknown,
  profile?: AgentBehaviorProfile | null,
): AgentLifecycleEvent | null {
  return profile?.lifecycleEventNormalizer?.normalize(update) ?? null;
}
