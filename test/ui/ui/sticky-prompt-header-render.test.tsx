import { describe, expect, test } from "bun:test";
import { parseColor } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { getLayerColors } from "../../../src/config/themes";
import { StickyPromptHeader } from "../../../src/ui/component/sticky-prompt-header";
import { getColors } from "../../../src/ui/context/theme";
import type { UserBlock } from "../../../src/ui/state";
import type { StickyPromptResult } from "../../../src/ui/util/sticky-prompt";

function makeUserBlock(id: string, content: string): UserBlock {
  return { type: "user", id, content };
}

function stickyResult(block: UserBlock): StickyPromptResult {
  return { block, incomingBlock: null, positionInStickyArea: 0 };
}

describe("StickyPromptHeader rendering", () => {
  test("renders current sticky rows with surface-aware dim text", async () => {
    const colors = getColors();
    const layers = getLayerColors(colors);
    let app: Awaited<ReturnType<typeof testRender>> | undefined;

    try {
      app = await testRender(
        () => (
          <box width="100%" height="100%" backgroundColor={colors.bg}>
            <StickyPromptHeader
              stickyResult={() => stickyResult(makeUserBlock("u1", "Line 1"))}
              maxLines={() => 2}
              availableWidth={() => 40}
              onJumpToBlock={() => {}}
            />
          </box>
        ),
        { width: 40, height: 4, targetFps: 30 },
      );

      await app.renderOnce();
      const stickySpan = app
        .captureSpans()
        .lines.flatMap((line) => line.spans)
        .find((span) => span.text.includes("Line 1"));

      expect(stickySpan).toBeDefined();
      expect(stickySpan?.fg.toString()).toBe(parseColor(layers.onPanelAltDim).toString());
      expect(stickySpan?.bg.toString()).toBe(parseColor(colors.panelAlt).toString());
    } finally {
      app?.renderer.destroy();
    }
  });
});
