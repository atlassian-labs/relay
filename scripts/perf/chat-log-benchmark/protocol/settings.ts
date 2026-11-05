export const BENCHMARK_TARGET_FPS = 30;
export const BENCHMARK_PROFILE = "default";
export const FORCED_GC_AVAILABLE = typeof Bun.gc === "function";

export const BENCHMARK_UI_SETTINGS = {
  toolResultPreviewLines: 1,
  thinkingPreviewLines: 3,
  showThinking: true,
  succinctToolResults: false,
  stickyPromptHeaderLines: 3,
} as const;
