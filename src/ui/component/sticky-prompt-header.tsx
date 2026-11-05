import { createMemo, For, Show } from "solid-js";
import { getLayerColors } from "../../config/themes";
import { getColors } from "../context/theme";
import { UI_GUTTER_X } from "../layout";
import { formatStickyPromptLines } from "../util/sticky-prompt";
import type { StickyPromptResult } from "../util/sticky-prompt";

const PADDING_ROWS = 2; // Mirrors the user block paddingTop + paddingBottom rows.
const makeBlank = (): StickyPromptHeaderRow => ({ text: "" });

export type StickyPromptHeaderRow = {
  text: string;
  dim?: boolean;
};

/**
 * Build the rendered sticky header rows for the current scroll position.
 *
 * Transition behavior is intentionally row based. While the incoming prompt is
 * moving through the sticky area, we keep rendering the current prompt but slice
 * rows from its front. Once the incoming prompt reaches the sticky area's top,
 * we switch to the incoming prompt. This keeps the header height stable without
 * formatting both prompts on every scroll frame.
 */
export function buildStickyPromptHeaderLines(options: {
  stickyResult: StickyPromptResult;
  maxLines: number;
  availableWidth: number;
}): StickyPromptHeaderRow[] {
  const { block, incomingBlock, positionInStickyArea } = options.stickyResult;
  if (!block || options.maxLines <= 0) return [];

  const stickyHeight = options.maxLines + PADDING_ROWS;
  const contentWidth = Math.max(0, options.availableWidth - UI_GUTTER_X * 2);

  if (incomingBlock && positionInStickyArea >= stickyHeight) {
    const incomingLines = formatStickyPromptLines(incomingBlock, options.maxLines, contentWidth);
    return rowsForLines(incomingLines);
  }

  // Before the incoming prompt reaches the top, only current rows can render.
  // Format the incoming prompt lazily after the switch above.
  const currentLines = formatStickyPromptLines(block, options.maxLines, contentWidth);
  const currentRows = rowsForLines(currentLines, true);
  if (!incomingBlock) return currentRows;

  const sliceSize = Math.max(0, stickyHeight - positionInStickyArea);
  const sliceStart = Math.max(0, currentRows.length - sliceSize);
  return currentRows.slice(sliceStart);
}

function rowsForLines(lines: readonly string[], dim = false): StickyPromptHeaderRow[] {
  const rows: StickyPromptHeaderRow[] = [makeBlank()];
  for (const text of lines) {
    rows.push(dim ? { text, dim: true } : { text });
  }
  rows.push(makeBlank());
  return rows;
}

export function StickyPromptHeader(props: {
  stickyResult: () => StickyPromptResult;
  maxLines: () => number;
  availableWidth: () => number;
  onJumpToBlock: () => void;
}) {
  const colors = getColors();
  const layers = getLayerColors(colors);
  const maxLines = props.maxLines;

  const lines = createMemo<StickyPromptHeaderRow[]>(() =>
    buildStickyPromptHeaderLines({
      stickyResult: props.stickyResult(),
      maxLines: maxLines(),
      availableWidth: props.availableWidth(),
    }),
  );

  return (
    <Show when={lines().length > 0}>
      <box
        width="100%"
        position="absolute"
        maxHeight={maxLines() + PADDING_ROWS}
        paddingTop={0}
        paddingBottom={0}
        flexShrink={0}
        flexDirection="column"
        justifyContent="flex-start"
        onMouseDown={() => props.onJumpToBlock()}
      >
        <For each={lines()}>
          {({ text, dim }) => (
            <box width="100%" paddingLeft={UI_GUTTER_X} paddingRight={UI_GUTTER_X} backgroundColor={colors.panelAlt}>
              <text fg={dim ? layers.onPanelAltDim : colors.fg} height={1}>
                {text}
              </text>
            </box>
          )}
        </For>
      </box>
    </Show>
  );
}
