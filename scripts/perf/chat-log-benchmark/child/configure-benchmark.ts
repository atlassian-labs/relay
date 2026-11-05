import { MockTreeSitterClient } from "@opentui/core/testing";
import { Config, setConfig } from "../../../../src/config";
import { installTreeSitterClientOverride } from "../../../../src/ui/util/tree-sitter-client";
import { BENCHMARK_UI_SETTINGS } from "../protocol/settings";

export function configureBenchmark(): void {
  // Syntax parsing is a process-global OpenTUI service. The benchmark creates
  // diagnostic renderers alongside the measured renderer, so use the same
  // deterministic mock as UI tests instead of starting and tearing down workers.
  installTreeSitterClientOverride(new MockTreeSitterClient());
  setConfig(
    new Config({
      ui: {
        tool_result_preview_lines: BENCHMARK_UI_SETTINGS.toolResultPreviewLines,
        thinking_preview_lines: BENCHMARK_UI_SETTINGS.thinkingPreviewLines,
        show_thinking: BENCHMARK_UI_SETTINGS.showThinking,
        succinct_tool_results: BENCHMARK_UI_SETTINGS.succinctToolResults,
        sticky_prompt_header_lines: BENCHMARK_UI_SETTINGS.stickyPromptHeaderLines,
      },
      plugins: { enabled: false },
      notifications: { terminal_enabled: false, sound_enabled: false },
    }),
  );
}
