import { Index, Show } from "solid-js";
import { useSharedTerminalDimensions } from "../context/terminal-dimensions";
import { QUEUE_NAVIGATION_LABEL, formatQueuedPromptPreview } from "../util/prompt-queue";
import { combineRelayLines, type EditorChromeElementResolver } from "../util/editor-chrome";
import { type QueuedPrompt, useApp } from "../state";
import { getColors } from "../context/theme";
import { queueControlHints, type QueueControlHint, UI_GUTTER_X } from "../layout";
import { RelayLineText } from "./relay-line-text";
import type { RelayLine, RelayLineSegment } from "../../plugins";

type DisplayQueueItem = {
  item: QueuedPrompt;
  queueIndex: number | null;
  editing: boolean;
};

function queueHintLine(hints: readonly QueueControlHint[], keyColor: string, actionColor: string): RelayLine {
  const segments: RelayLineSegment[] = [{ text: "  ", fg: actionColor }];
  hints.forEach(([key, label], index) => {
    if (index > 0) segments.push({ text: " · ", fg: actionColor });
    segments.push({ text: key, fg: keyColor }, { text: ` ${label}`, fg: actionColor });
  });
  return { text: segments.map((segment) => segment.text).join(""), segments };
}

export function QueueDisplay(props: {
  focusedIndex?: () => number | null;
  editingItem?: () => QueuedPrompt | null;
  editorText?: () => string;
  maxSize: number;
  marginTop?: number;
  resolveElement?: EditorChromeElementResolver;
}) {
  const app = useApp();
  const colors = getColors();
  const dims = useSharedTerminalDimensions();
  const items = () => app.state.pendingQueue;
  const editingItem = () => props.editingItem?.() ?? null;
  const editingDisplayIndex = () => {
    const editing = editingItem();
    return editing ? Math.max(0, Math.min(editing.originalIndex ?? items().length, items().length)) : -1;
  };
  const displayItems = (): DisplayQueueItem[] => {
    const queued: DisplayQueueItem[] = items().map((item, queueIndex) => ({ item, queueIndex, editing: false }));
    const editing = editingItem();
    if (!editing) return queued;
    queued.splice(editingDisplayIndex(), 0, { item: editing, queueIndex: null, editing: true });
    return queued;
  };
  const focusedIndex = () => {
    const focused = props.focusedIndex?.() ?? null;
    if (focused === null || focused < 0 || focused >= items().length) return -1;
    return focused;
  };
  const maxItemWidth = () => Math.max(24, Math.min(120, dims().width - 8));
  const element = (
    name: Parameters<EditorChromeElementResolver>[0]["element"],
    line: RelayLine,
    index?: number,
    active?: boolean,
  ): RelayLine =>
    props.resolveElement?.({
      surface: "header",
      element: name,
      line,
      ...(index === undefined ? {} : { index }),
      ...(active === undefined ? {} : { active }),
    }) ?? line;
  const titleLine = () => {
    const editing = editingItem();
    const active = focusedIndex() >= 0 || editing !== null;
    return combineRelayLines([
      element(
        "editorHeader.queueTitle",
        {
          text: `${active ? "⏸" : "◷"} Queue (${displayItems().length}/${props.maxSize})`,
          fg: active ? colors.diffRemoved : colors.textMuted,
          bold: true,
        },
        undefined,
        active,
      ),
      element(
        "editorHeader.queueHint",
        queueHintLine(
          editing
            ? [
                ["shift+enter", "newline"],
                ["enter", "save"],
                ["esc", "cancel"],
              ]
            : active
              ? queueControlHints(dims().width, QUEUE_NAVIGATION_LABEL)
              : [[QUEUE_NAVIGATION_LABEL, "browse queued prompts"]],
          colors.textLabel,
          colors.textSubtle,
        ),
        undefined,
        active,
      ),
    ]);
  };

  return (
    <Show when={displayItems().length > 0}>
      <box
        width="100%"
        paddingLeft={UI_GUTTER_X}
        paddingRight={UI_GUTTER_X}
        flexDirection="column"
        flexShrink={0}
        marginTop={props.marginTop ?? 1}
      >
        <box height={1}>
          <RelayLineText line={titleLine()} fallbackFg={colors.textMuted} />
        </box>
        <Index each={displayItems()}>
          {(entry, index) => {
            const isEditing = () => entry().editing;
            const isFocused = () =>
              isEditing() || (entry().queueIndex !== null && entry().queueIndex === focusedIndex());
            const prefix = () => ` Queued prompt #${index + 1} · `;
            const preview = () =>
              isEditing() && props.editorText
                ? props.editorText?.().replace(/\s+/gu, " ").trim() || "(empty prompt)"
                : formatQueuedPromptPreview(entry().item);
            const previewWidth = () => Math.max(12, maxItemWidth() - prefix().length);
            const truncated = () =>
              preview().length <= previewWidth() ? preview() : preview().slice(0, previewWidth() - 3) + "...";
            const indicatorLine = () =>
              element(
                "editorHeader.queueIndicator",
                {
                  text: isFocused() ? "❯" : " ",
                  fg: isFocused() ? colors.accent : colors.textMuted,
                  bold: isFocused(),
                },
                index,
                isFocused(),
              );
            const labelLine = () =>
              element(
                "editorHeader.queueItemLabel",
                { text: prefix(), fg: isFocused() ? colors.textLabel : colors.textMuted },
                index,
                isFocused(),
              );
            const itemLine = () =>
              combineRelayLines([
                indicatorLine(),
                labelLine(),
                element(
                  "editorHeader.queueItemPreview",
                  { text: truncated(), fg: isFocused() ? colors.fg : colors.textMuted },
                  index,
                  isFocused(),
                ),
              ]);
            return (
              <box height={1}>
                <RelayLineText line={itemLine()} fallbackFg={colors.textMuted} />
              </box>
            );
          }}
        </Index>
      </box>
    </Show>
  );
}
