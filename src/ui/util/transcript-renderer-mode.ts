import { runtimeEnvironment } from "../../platform/environment";

export type TranscriptRendererMode = "legacy" | "windowed";

export const TRANSCRIPT_RENDERER_ROLLOUT_DEFAULT: TranscriptRendererMode = "windowed";

/**
 * Resolves the transcript renderer from an environment override with a safe rollout fallback.
 *
 * @param env - Environment values containing the optional renderer override.
 * @param rolloutDefault - Renderer mode used when the override is absent or invalid.
 * @param warn - Callback invoked when an unsupported override is encountered.
 * @returns The validated transcript renderer mode.
 */
export function resolveTranscriptRendererMode(
  env: Readonly<Record<string, string | undefined>> = runtimeEnvironment(),
  rolloutDefault: TranscriptRendererMode = TRANSCRIPT_RENDERER_ROLLOUT_DEFAULT,
  warn: (message: string) => void = (message) => console.warn(message),
): TranscriptRendererMode {
  const value = env.RELAY_TRANSCRIPT_RENDERER;
  if (value === undefined || value === "") return rolloutDefault;
  if (value === "legacy" || value === "windowed") return value;
  warn(`Invalid RELAY_TRANSCRIPT_RENDERER="${value}"; using ${rolloutDefault}.`);
  return rolloutDefault;
}
