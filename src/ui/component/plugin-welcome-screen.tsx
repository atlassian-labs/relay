import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { useSharedTerminalDimensions } from "../context/terminal-dimensions";
import { getColors } from "../context/theme";
import { openUrl as openExternalUrl } from "../util/links";
import { handleRelayLineMouseAction } from "../util/relay-line-click";
import { RelayLineText } from "./relay-line-text";
import { normalizeRelayLines, type RelayLine, type RelayModalCorner } from "../../plugins";
import type { RelayWidgetEntry } from "../../plugins/slots";

function widgetCornerLine(entry: RelayWidgetEntry, corner: RelayModalCorner): RelayLine | null {
  const value = entry.widget.modalCorners?.[corner];
  if (!value) return null;
  return typeof value === "string" ? { text: value } : value;
}

export function PluginWelcomeScreen(props: {
  widgets: () => readonly RelayWidgetEntry[];
  openUrl?: (url: string) => void;
}) {
  const colors = getColors();
  const dims = useSharedTerminalDimensions();
  const [frame, setFrame] = createSignal(0);
  const activeEntry = () =>
    props.widgets().toSorted((a, b) => (a.widget.priority ?? 0) - (b.widget.priority ?? 0) || a.order - b.order)[0] ??
    null;

  createEffect(() => {
    const intervalMs = activeEntry()?.widget.intervalMs;
    if (typeof intervalMs !== "number" || intervalMs <= 0) return;
    // effect-shape-allow: welcome widget refresh timer is scoped to Solid cleanup.
    const handle = setInterval(() => setFrame((value) => value + 1), intervalMs);
    onCleanup(() => clearInterval(handle));
  });

  const contentWidth = () => Math.max(0, dims().width - 6);
  const contentLines = (entry: RelayWidgetEntry) => {
    frame();
    return normalizeRelayLines(
      entry.widget.render({
        placement: "welcome",
        width: contentWidth(),
        height: Math.max(1, dims().height - 4),
        focused: entry.focused,
        colors,
      }),
    );
  };
  const hasHeader = (entry: RelayWidgetEntry) =>
    Boolean(entry.widget.title || widgetCornerLine(entry, "topLeft") || widgetCornerLine(entry, "topRight"));
  const hasFooter = (entry: RelayWidgetEntry) =>
    Boolean(widgetCornerLine(entry, "bottomLeft") || widgetCornerLine(entry, "bottomRight"));
  const headerLeftLine = (entry: RelayWidgetEntry): RelayLine | null =>
    widgetCornerLine(entry, "topLeft") ?? (entry.widget.title ? { text: entry.widget.title, bold: true } : null);
  const openLineUrl = (line: RelayLine, event: unknown) =>
    handleRelayLineMouseAction(line, event, props.openUrl ?? openExternalUrl);

  return (
    <Show when={activeEntry()}>
      {(entry) => (
        <box flexGrow={1} flexShrink={1} minHeight={0} width="100%" paddingLeft={1} paddingRight={1}>
          <box
            flexDirection="column"
            flexGrow={1}
            flexShrink={1}
            minHeight={0}
            width="100%"
            borderStyle="single"
            border={["top", "bottom", "left", "right"] as never}
            borderColor={colors.border}
            backgroundColor={colors.bg}
            paddingLeft={1}
            paddingRight={1}
          >
            <Show when={hasHeader(entry())}>
              <box height={1} width="100%" flexDirection="row" justifyContent="space-between">
                <Show when={headerLeftLine(entry())} fallback={<text wrapMode="none" />}>
                  {(line) => <RelayLineText line={line()} fallbackFg={colors.fg} />}
                </Show>
                <Show when={widgetCornerLine(entry(), "topRight")}>
                  {(line) => <RelayLineText line={line()} fallbackFg={colors.fg} />}
                </Show>
              </box>
              <box height={1} width="100%">
                <text fg={colors.border}>{"─".repeat(contentWidth())}</text>
              </box>
            </Show>
            <scrollbox
              flexGrow={1}
              flexShrink={1}
              minHeight={0}
              width="100%"
              scrollbarOptions={{ visible: false } as never}
            >
              <For each={contentLines(entry())}>
                {(line) => (
                  <box height={1} onMouseDown={(event) => openLineUrl(line, event)}>
                    <RelayLineText line={line} fallbackFg={colors.fg} />
                  </box>
                )}
              </For>
            </scrollbox>
            <Show when={hasFooter(entry())}>
              <box height={1} width="100%" flexDirection="row" justifyContent="space-between">
                <Show when={widgetCornerLine(entry(), "bottomLeft")} fallback={<text wrapMode="none" />}>
                  {(line) => <RelayLineText line={line()} fallbackFg={colors.fg} />}
                </Show>
                <Show when={widgetCornerLine(entry(), "bottomRight")}>
                  {(line) => <RelayLineText line={line()} fallbackFg={colors.fg} />}
                </Show>
              </box>
            </Show>
          </box>
        </box>
      )}
    </Show>
  );
}
