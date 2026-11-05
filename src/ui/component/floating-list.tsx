import { createSignal, For, onCleanup, Show, type JSX } from "solid-js";
import { getConfig, subscribeConfig } from "../../config";
import { useSharedTerminalDimensions } from "../context/terminal-dimensions";
import type { ListItem } from "../autocomplete";
import { getColors } from "../context/theme";
import { ShortcutHints, shortcutHintsText, type ShortcutHint } from "./shortcut-hints";
import { bottomOverlayReservedRows } from "../layout";
import { truncateTextEnd } from "../util/format";
import { centeredWindowStart } from "../util/list-window";

export type SlashPanelPosition = "bottom" | "top";

type DescriptionColumnLayout = {
  maxWidth?: number;
  minWidth?: number;
  align?: "left" | "right";
};

function descriptionColumnWidth(
  items: readonly ListItem<unknown>[],
  columnIndex: number,
  layout: DescriptionColumnLayout,
): number {
  const minWidth = Math.max(0, layout.minWidth ?? 0);
  const naturalWidth = Math.max(0, ...items.map((item) => item.descriptionColumns?.[columnIndex]?.length ?? 0));
  const maxWidth = Math.max(minWidth, layout.maxWidth ?? naturalWidth);
  return Math.min(maxWidth, Math.max(minWidth, naturalWidth));
}

function padDescriptionColumn(text: string, width: number, align: "left" | "right" | undefined): string {
  const truncated = truncateTextEnd(text, width);
  return align === "right" ? truncated.padStart(width) : truncated.padEnd(width);
}

export interface FloatingListProps {
  visible: () => boolean;
  items: () => ListItem<any>[];
  selectedIndex: () => number;
  layout: () => {
    labelMinWidth: number;
    labelMaxWidth: number;
    descriptionMaxWidth: number;
    viewportReservedWidth: number;
    descriptionColumns?: readonly DescriptionColumnLayout[];
    descriptionColumnGap?: string;
  };
  maxVisible: number;
  footerHints?: () => readonly ShortcutHint[];
  panelPosition?: SlashPanelPosition;
  viewportLeft?: () => number;
  viewportWidth?: () => number;
}

export function FloatingList(props: FloatingListProps) {
  const colors = getColors();
  const dims = useSharedTerminalDimensions();
  const [selectionMarker, setSelectionMarker] = createSignal(getConfig().ui.selection_marker);
  const unsubscribeConfig = subscribeConfig((change) => setSelectionMarker(change.config.ui.selection_marker));
  onCleanup(unsubscribeConfig);

  const isTop = () => (props.panelPosition ?? "bottom") === "top";
  const viewportLeft = () => Math.max(0, Math.min(props.viewportLeft?.() ?? 0, dims().width - 1));
  const viewportWidth = () =>
    Math.max(1, Math.min(props.viewportWidth?.() ?? dims().width - viewportLeft(), dims().width - viewportLeft()));
  const listContentHeight = () => {
    if (!props.visible()) return 0;
    return props.maxVisible + 1;
  };

  const listHeight = () => listContentHeight() + (isTop() ? 2 : 0);

  return (
    <Show when={props.visible()}>
      <box
        width={isTop() ? viewportWidth() : "100%"}
        height={listHeight()}
        flexDirection="column"
        paddingLeft={isTop() ? 0 : viewportLeft() + 1}
        paddingRight={isTop() ? 0 : 1}
        flexShrink={0}
        {...(isTop()
          ? {
              position: "absolute" as const,
              bottom: bottomOverlayReservedRows(viewportWidth()),
              left: viewportLeft(),
              backgroundColor: colors.panel,
            }
          : {})}
      >
        {(() => {
          const allItems = props.items();
          const selIdx = props.selectedIndex();
          const total = allItems.length;
          const windowSize = Math.min(total, props.maxVisible);
          const start = centeredWindowStart(selIdx, total, windowSize);
          const visible = allItems.slice(start, start + windowSize);
          const fillerRows = Math.max(0, props.maxVisible - visible.length);

          const layout = props.layout();
          const panelBg = isTop() ? colors.panel : undefined;
          const secondaryFg = colors.textSubtle;
          const fillWidth = Math.max(0, viewportWidth() - 2);
          const descriptionColumnLayouts = layout.descriptionColumns ?? [];
          const hasStructuredDescription =
            descriptionColumnLayouts.length > 0 &&
            allItems.some((item) => item.descriptionColumns?.some((value) => value.length > 0));
          const descriptionColumnGap = layout.descriptionColumnGap ?? " · ";
          const descriptionColumnWidths = descriptionColumnLayouts.map((column, columnIndex) =>
            descriptionColumnWidth(allItems, columnIndex, column),
          );
          const visibleDescriptionColumnIndexes = descriptionColumnWidths
            .map((width, index) => ({ width, index }))
            .filter((column) => column.width > 0)
            .map((column) => column.index);
          const structuredDescriptionWidth = hasStructuredDescription
            ? visibleDescriptionColumnIndexes.reduce(
                (sum, columnIndex) => sum + (descriptionColumnWidths[columnIndex] ?? 0),
                Math.max(0, visibleDescriptionColumnIndexes.length - 1) * descriptionColumnGap.length,
              )
            : 0;
          const anyActive = allItems.some((item) => item.active);
          const rowPrefix = selectionMarker() ? `${selectionMarker()} ` : "";
          const activeMarkerReserveWidth = anyActive ? (structuredDescriptionWidth > 0 ? 2 : 1) : 0;
          const rowPrefixWidth = rowPrefix.length;
          const fixedOverhead = 8;
          const hasDescription = hasStructuredDescription
            ? structuredDescriptionWidth > 0
            : layout.descriptionMaxWidth > 0 && allItems.some((item) => item.description.length > 0);
          const maxLabelWidthFromViewport = Math.max(
            layout.labelMinWidth,
            viewportWidth() - fixedOverhead - layout.viewportReservedWidth,
          );
          const labelWidth = hasStructuredDescription
            ? Math.max(0, fillWidth - rowPrefixWidth - 3 - structuredDescriptionWidth - activeMarkerReserveWidth)
            : Math.min(
                layout.labelMaxWidth,
                Math.max(
                  layout.labelMinWidth,
                  Math.min(maxLabelWidthFromViewport, Math.max(...allItems.map((item) => item.label.length))),
                ),
              );
          const currentIndex = total === 0 ? 0 : selIdx + 1;
          const currentIndexLabel = total > 9 && currentIndex < 10 ? `0${currentIndex}` : String(currentIndex);
          const border = () => (
            <box height={1} width="100%" backgroundColor={panelBg}>
              <text fg={colors.textMuted} bg={panelBg} wrapMode="none">
                {"─".repeat(viewportWidth())}
              </text>
            </box>
          );
          const fillers = (
            <For each={Array.from({ length: fillerRows })}>
              {() => (
                <box height={1} width="100%" backgroundColor={panelBg}>
                  <text bg={panelBg}>{fillWidth > 0 ? " ".repeat(fillWidth) : ""}</text>
                </box>
              )}
            </For>
          );
          const rows = (
            <>
              <Show when={total === 0}>
                <box height={1} width="100%" backgroundColor={panelBg}>
                  <text fg={secondaryFg} bg={panelBg}>
                    {"  No matches".padEnd(fillWidth)}
                  </text>
                </box>
              </Show>
              <For each={visible}>
                {(item, rawIdx) => {
                  const idx = () => rawIdx() + start;
                  const isSelected = () => idx() === selIdx;
                  const labelText = truncateTextEnd(item.label, labelWidth);
                  const labelContentWidth = labelWidth + 3;
                  const paddedLabelText = labelText.padEnd(labelContentWidth);
                  const tonePrefixLength = Math.max(0, Math.min(item.tonePrefixLength ?? 0, paddedLabelText.length));
                  const activeMarker = item.active ? "✓" : "";
                  const structuredDescriptionText = hasStructuredDescription
                    ? visibleDescriptionColumnIndexes
                        .map((columnIndex) =>
                          padDescriptionColumn(
                            item.descriptionColumns?.[columnIndex] ?? "",
                            descriptionColumnWidths[columnIndex] ?? 0,
                            descriptionColumnLayouts[columnIndex]?.align,
                          ),
                        )
                        .join(descriptionColumnGap)
                    : "";
                  const activeSeparatorWidth =
                    !hasStructuredDescription && item.active && item.description.length > 0 ? 1 : 0;
                  const descriptionAvailableWidth = Math.max(
                    0,
                    fillWidth - rowPrefixWidth - labelContentWidth - activeMarker.length - activeSeparatorWidth,
                  );
                  const descriptionText = hasStructuredDescription
                    ? structuredDescriptionText
                    : truncateTextEnd(item.description || "", descriptionAvailableWidth);
                  const activeSeparator = activeMarker && descriptionText.trimEnd().length > 0 ? " " : "";
                  const descContent =
                    hasDescription || item.active ? descriptionText + activeSeparator + activeMarker : "";
                  const contentLen = rowPrefixWidth + labelContentWidth + descContent.length;
                  const trailing = fillWidth > 0 ? " ".repeat(Math.max(0, fillWidth - contentLen)) : "";
                  const toneFg = () => {
                    if (item.tone === "accent") return colors.accent;
                    if (item.tone === "success") return colors.success;
                    if (item.tone === "error") return colors.error;
                    if (item.tone === "muted") return secondaryFg;
                    return undefined;
                  };
                  const rowFg = () => (isSelected() ? colors.selected : colors.fg);
                  const labelFg = () => toneFg() ?? rowFg();
                  const rowSecondaryFg = () =>
                    item.tonePrefixLength === undefined
                      ? (toneFg() ?? (isSelected() ? colors.selected : secondaryFg))
                      : secondaryFg;
                  return (
                    <box height={1} width="100%" backgroundColor={panelBg}>
                      <text fg={rowFg()} bg={panelBg} attributes={undefined}>
                        {isSelected() ? rowPrefix : " ".repeat(rowPrefixWidth)}
                        <Show
                          when={item.tonePrefixLength !== undefined}
                          fallback={
                            <span style={{ fg: labelFg(), bg: panelBg, bold: isSelected() } as any}>
                              {paddedLabelText}
                            </span>
                          }
                        >
                          <span style={{ fg: toneFg(), bg: panelBg, bold: isSelected() } as any}>
                            {paddedLabelText.slice(0, tonePrefixLength)}
                          </span>
                          <span style={{ fg: colors.fg, bg: panelBg, bold: isSelected() } as any}>
                            {paddedLabelText.slice(tonePrefixLength)}
                          </span>
                        </Show>
                        <Show when={hasDescription || item.active}>
                          <span
                            style={
                              {
                                fg: rowSecondaryFg(),
                                bg: panelBg,
                                bold: isSelected(),
                              } as any
                            }
                          >
                            {descContent}
                          </span>
                        </Show>
                        {trailing}
                      </text>
                    </box>
                  );
                }}
              </For>
              <box height={1} width="100%" backgroundColor={panelBg}>
                {(() => {
                  const footerHints =
                    props.footerHints?.() ??
                    ([
                      ["↑/↓", "navigate"],
                      ["enter", "select"],
                      ["esc", "close"],
                    ] as const);
                  const footerPrefix = `${" ".repeat(rowPrefixWidth)}(${currentIndexLabel}/${total})  `;
                  const footerText = footerPrefix + shortcutHintsText(footerHints);
                  const trailing = " ".repeat(Math.max(0, fillWidth - footerText.length));
                  return (
                    <text fg={secondaryFg} bg={panelBg}>
                      {footerPrefix}
                      <ShortcutHints hints={footerHints} />
                      {trailing}
                    </text>
                  );
                })()}
              </box>
            </>
          );

          return (isTop()
            ? [
                border(),
                <box width="100%" flexDirection="column" paddingLeft={1} paddingRight={1}>
                  {fillers}
                  {rows}
                </box>,
                border(),
              ]
            : [rows, fillers]) as unknown as JSX.Element;
        })()}
      </box>
    </Show>
  );
}
