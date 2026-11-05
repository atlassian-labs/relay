export const UI_GUTTER_X = 1;
export const UI_PANEL_PADDING_X = 2;
export const UI_BLOCK_GAP = 1;
export const UI_RESULT_INDENT = 2;

export const UI_COMPOSER_MIN_HEIGHT = 2;
export const UI_COMPOSER_MAX_HEIGHT_RATIO = 0.3;
export const UI_COMPOSER_COMPACT_WIDTH = 72;
export const UI_INFO_BAR_HEIGHT = 2;
export const UI_STATUS_LINE_HEIGHT = 1;

export const UI_MODAL_MIN_WIDTH = 36;
export const UI_MODAL_MAX_WIDTH = 112;
export const UI_MODAL_HORIZONTAL_MARGIN = 4;
export const UI_MODAL_MIN_HEIGHT = 8;
export const UI_MODAL_VERTICAL_MARGIN = 4;

export function clampDimension(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function composerPaddingX(width: number): number {
  return width < UI_COMPOSER_COMPACT_WIDTH ? UI_GUTTER_X : UI_PANEL_PADDING_X;
}

export function composerReservedRows(_width: number, _disabled = false): number {
  return UI_COMPOSER_MIN_HEIGHT;
}

export function bottomOverlayReservedRows(width: number, disabled = false): number {
  return UI_INFO_BAR_HEIGHT + UI_STATUS_LINE_HEIGHT + composerReservedRows(width, disabled);
}

export function shouldSplitModalHeader(contentWidth: number, title: string, summary: string): boolean {
  return contentWidth >= title.length + summary.length + 2;
}

export type QueueControlHint = readonly [key: string, label: string];

export function queueControlHints(width: number, navigationLabel: string): readonly QueueControlHint[] {
  if (width < 100)
    return [
      [navigationLabel, "select"],
      ["enter", "edit"],
      ["esc", "close"],
    ];
  return [
    ["↑/↓", "select"],
    ["enter", "edit"],
    [`shift+${navigationLabel}`, "move"],
    ["tab", "steer"],
    ["del", "remove"],
    ["esc", "close"],
  ];
}

export function queueControlsLabel(width: number, navigationLabel: string): string {
  return queueControlHints(width, navigationLabel)
    .map(([key, label]) => `${key} ${label}`)
    .join(" · ");
}

export function modalFooterLabels(contentWidth: number): { primary: string; secondary: string | null } {
  const primary = contentWidth >= 44 ? "Click outside or esc close" : "esc close";
  const secondary = "review before exit";
  return {
    primary,
    secondary: contentWidth >= primary.length + secondary.length + 2 ? secondary : null,
  };
}
