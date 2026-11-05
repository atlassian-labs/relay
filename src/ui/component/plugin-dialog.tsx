import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { createTextAttributes } from "@opentui/core";
import { useSharedTerminalDimensions } from "../context/terminal-dimensions";
import type { PluginDialogState } from "../app/plugin-dialogs";
import { getColors } from "../context/theme";
import {
  clampDimension,
  UI_MODAL_HORIZONTAL_MARGIN,
  UI_MODAL_MAX_WIDTH,
  UI_MODAL_MIN_HEIGHT,
  UI_MODAL_MIN_WIDTH,
  UI_MODAL_VERTICAL_MARGIN,
} from "../layout";
import { truncateTextEnd } from "../util/format";
import { centeredWindowStart, listRangeLabel } from "../util/list-window";
import { ModalFrame } from "./modal-frame";
import { ModalFooter, ModalHeader } from "./modal-layout";
import { ActionChoices } from "./action-choices";

export interface PluginDialogModalProps {
  readonly dialog: () => PluginDialogState | null;
  readonly onCancel: () => void;
}

const CURSOR = "▌";
const SELECT_VISIBLE_ROWS = 8;
const COLORED_CONFIRM_DETAIL_LABELS = new Set(["Job:", "Script:", "Cache:"]);

export function PluginDialogModal(props: PluginDialogModalProps) {
  const dims = useSharedTerminalDimensions();
  const [now, setNow] = createSignal(Date.now());

  createEffect(() => {
    const dialog = props.dialog();
    if (!dialog?.expiresAt) return;
    setNow(Date.now());
    const handle = setInterval(() => setNow(Date.now()), 250);
    onCleanup(() => clearInterval(handle));
  });

  const modalWidth = () =>
    clampDimension(
      Math.floor(dims().width * 0.78),
      Math.min(UI_MODAL_MIN_WIDTH, Math.max(1, dims().width - 2)),
      Math.min(UI_MODAL_MAX_WIDTH, Math.max(1, dims().width - UI_MODAL_HORIZONTAL_MARGIN)),
    );
  const contentWidth = () => Math.max(1, modalWidth() - 4);
  const maxHeight = () => Math.max(1, dims().height - UI_MODAL_VERTICAL_MARGIN);
  const modalHeight = () => {
    const dialog = props.dialog();
    if (!dialog) return UI_MODAL_MIN_HEIGHT;
    const width = contentWidth();
    const base = 4;
    if (dialog.kind === "confirm")
      return clampDimension(base + wrapText(dialog.message, width).length + 3, UI_MODAL_MIN_HEIGHT, maxHeight());
    if (dialog.kind === "select")
      return clampDimension(base + Math.max(1, Math.min(SELECT_VISIBLE_ROWS, dialog.items.length)) + 2, 9, maxHeight());
    if (dialog.kind === "editor") return clampDimension(Math.floor(dims().height * 0.65), 12, maxHeight());
    return clampDimension(9, UI_MODAL_MIN_HEIGHT, maxHeight());
  };
  const modalTop = () => Math.max(0, Math.floor((dims().height - modalHeight()) / 2));
  const bodyHeight = () => Math.max(1, modalHeight() - 4);
  const timeoutLabel = () => {
    const expiresAt = props.dialog()?.expiresAt;
    if (!expiresAt) return "";
    return `timeout ${Math.max(0, Math.ceil((expiresAt - now()) / 1000))}s`;
  };
  const headerRight = () => [props.dialog()?.plugin.name, timeoutLabel()].filter(Boolean).join(" · ");
  const footerHints = () => {
    const dialog = props.dialog();
    if (!dialog) return [];
    switch (dialog.kind) {
      case "confirm":
        return [["←/→"], ["enter"], ["y/n"], ["esc"]] as const;
      case "select":
        return [
          ["↑/↓", "navigate"],
          ["enter", "select"],
          ["esc", "close"],
        ] as const;
      case "input":
        return [["enter", "submit"], ["esc"]] as const;
      case "editor":
        return [["ctrl+enter", "submit"], ["esc"]] as const;
    }
  };

  return (
    <ModalFrame
      open={() => props.dialog() !== null}
      width={modalWidth}
      height={modalHeight}
      top={modalTop}
      zIndex={3100}
      onClose={props.onCancel}
    >
      <Show when={props.dialog()}>
        {(dialog) => (
          <>
            <ModalHeader title={() => dialog().title} right={headerRight} width={contentWidth} />
            <box height={1} flexShrink={0} />
            <DialogBody dialog={dialog()} width={contentWidth()} height={bodyHeight()} />
            <ModalFooter width={contentWidth} leftHints={footerHints} />
          </>
        )}
      </Show>
    </ModalFrame>
  );
}

function DialogBody(props: { readonly dialog: PluginDialogState; readonly width: number; readonly height: number }) {
  switch (props.dialog.kind) {
    case "confirm":
      return <ConfirmDialogBody dialog={props.dialog} width={props.width} height={props.height} />;
    case "select":
      return <SelectDialogBody dialog={props.dialog} width={props.width} height={props.height} />;
    case "input":
      return <InputDialogBody dialog={props.dialog} width={props.width} />;
    case "editor":
      return <EditorDialogBody dialog={props.dialog} width={props.width} height={props.height} />;
  }
}

function ConfirmDialogBody(props: {
  readonly dialog: Extract<PluginDialogState, { readonly kind: "confirm" }>;
  readonly width: number;
  readonly height: number;
}) {
  const messageLines = () => wrapText(props.dialog.message, props.width).slice(0, Math.max(1, props.height - 3));
  const actions = () => [{ label: props.dialog.cancelLabel }, { label: props.dialog.confirmLabel }];
  return (
    <box flexDirection="column" width="100%" flexGrow={1}>
      <For each={messageLines()}>{(line) => <ConfirmMessageLine line={line} width={props.width} />}</For>
      <box flexGrow={1} />
      <box height={1} width="100%">
        <ActionChoices
          choices={actions()}
          selectedIndex={props.dialog.selectedIndex}
          direction="horizontal"
          align="end"
          appearance="buttons"
        />
      </box>
    </box>
  );
}

function ConfirmMessageLine(props: { readonly line: string; readonly width: number }) {
  const colors = getColors();
  const bold = createTextAttributes({ bold: true });
  const detail = confirmDetailLine(props.line);
  if (!detail) {
    return (
      <box height={1} width="100%">
        <text fg={colors.fg} wrapMode="none">
          {truncateTextEnd(props.line, props.width)}
        </text>
      </box>
    );
  }

  return (
    <box height={1} width="100%" flexDirection="row">
      <text fg={colors.textLabel} attributes={bold} wrapMode="none">
        {detail.label}
      </text>
      <text fg={colors.accent} wrapMode="none">
        {truncateTextEnd(detail.value, Math.max(1, props.width - detail.label.length))}
      </text>
    </box>
  );
}

function confirmDetailLine(line: string): { readonly label: string; readonly value: string } | null {
  const match = line.match(/^(Job:|Script:|Cache:)\s*(.*)$/);
  if (!match || !COLORED_CONFIRM_DETAIL_LABELS.has(match[1])) return null;
  return { label: `${match[1]} `, value: match[2] };
}

function SelectDialogBody(props: {
  readonly dialog: Extract<PluginDialogState, { readonly kind: "select" }>;
  readonly width: number;
  readonly height: number;
}) {
  const colors = getColors();
  const bold = createTextAttributes({ bold: true });
  const rowCount = () => Math.max(1, Math.min(SELECT_VISIBLE_ROWS, props.height - 1));
  const startIndex = () => centeredWindowStart(props.dialog.selectedIndex, props.dialog.items.length, rowCount());
  const visibleItems = () => props.dialog.items.slice(startIndex(), startIndex() + rowCount());
  const rangeLabel = () => listRangeLabel(startIndex(), rowCount(), props.dialog.items.length);
  const labelWidth = () => Math.min(32, Math.max(12, Math.floor(props.width * 0.42)));
  const descriptionWidth = () => Math.max(0, props.width - labelWidth() - 4);
  return (
    <box flexDirection="column" width="100%" flexGrow={1}>
      <Show
        when={props.dialog.items.length > 0}
        fallback={
          <box height={1}>
            <text fg={colors.textMuted} wrapMode="none">
              No options
            </text>
          </box>
        }
      >
        <For each={visibleItems()}>
          {(item, rawIndex) => {
            const index = () => startIndex() + rawIndex();
            const selected = () => index() === props.dialog.selectedIndex;
            return (
              <box height={1} width="100%" flexDirection="row">
                <text
                  fg={selected() ? colors.selected : colors.fg}
                  attributes={selected() ? bold : undefined}
                  wrapMode="none"
                >
                  {`${selected() ? "›" : " "} ${truncateTextEnd(item.label, labelWidth()).padEnd(labelWidth())}`}
                </text>
                <text fg={selected() ? colors.selected : colors.textMuted} wrapMode="none">
                  {truncateTextEnd(item.description ?? item.value, descriptionWidth())}
                </text>
              </box>
            );
          }}
        </For>
      </Show>
      <box flexGrow={1} />
      <box height={1} width="100%">
        <text fg={colors.textMuted} wrapMode="none">
          {rangeLabel()}
        </text>
      </box>
    </box>
  );
}

function InputDialogBody(props: {
  readonly dialog: Extract<PluginDialogState, { readonly kind: "input" }>;
  readonly width: number;
}) {
  const colors = getColors();
  const display = () => inputDisplay(props.dialog.value, props.dialog.cursorOffset, props.dialog.placeholder);
  return (
    <box flexDirection="column" width="100%" flexGrow={1}>
      <box height={1} />
      <box
        height={1}
        width="100%"
        borderStyle="single"
        border={["top", "bottom", "left", "right"] as never}
        borderColor={colors.border}
        paddingLeft={1}
        paddingRight={1}
      >
        <text fg={props.dialog.value.length > 0 ? colors.fg : colors.textMuted} wrapMode="none">
          {truncateTextEnd(display(), Math.max(1, props.width - 4))}
        </text>
      </box>
    </box>
  );
}

function EditorDialogBody(props: {
  readonly dialog: Extract<PluginDialogState, { readonly kind: "editor" }>;
  readonly width: number;
  readonly height: number;
}) {
  const colors = getColors();
  const editorHeight = () => Math.max(3, props.height - 1);
  const lines = () =>
    editorDisplayLines(props.dialog.value, props.dialog.cursorOffset, props.width - 2, editorHeight());
  return (
    <box
      flexDirection="column"
      width="100%"
      height={editorHeight()}
      borderStyle="single"
      border={["top", "bottom", "left", "right"] as never}
      borderColor={colors.border}
      paddingLeft={1}
      paddingRight={1}
    >
      <For each={lines()}>
        {(line) => (
          <box height={1} width="100%">
            <text fg={colors.fg} wrapMode="none">
              {truncateTextEnd(line, Math.max(1, props.width - 4))}
            </text>
          </box>
        )}
      </For>
    </box>
  );
}

function wrapText(text: string, width: number): string[] {
  const safeWidth = Math.max(1, width);
  const lines: string[] = [];
  for (const rawLine of text.split("\n")) {
    if (rawLine.length === 0) {
      lines.push("");
      continue;
    }
    let remaining = rawLine;
    while (remaining.length > safeWidth) {
      lines.push(remaining.slice(0, safeWidth));
      remaining = remaining.slice(safeWidth);
    }
    lines.push(remaining);
  }
  return lines.length > 0 ? lines : [""];
}

function inputDisplay(value: string, cursorOffset: number, placeholder: string): string {
  const cursor = Math.max(0, Math.min(value.length, cursorOffset));
  if (value.length === 0) return `${CURSOR}${placeholder}`;
  return `${value.slice(0, cursor)}${CURSOR}${value.slice(cursor)}`;
}

function editorDisplayLines(value: string, cursorOffset: number, width: number, height: number): readonly string[] {
  const cursor = Math.max(0, Math.min(value.length, cursorOffset));
  const before = value.slice(0, cursor);
  const cursorLine = before.split("\n").length - 1;
  const withCursor = `${before}${CURSOR}${value.slice(cursor)}`;
  const rawLines = withCursor.split("\n");
  const start = centeredWindowStart(cursorLine, rawLines.length, height);
  const visible = rawLines.slice(start, start + height).map((line) => truncateTextEnd(line, Math.max(1, width)));
  while (visible.length < height) visible.push("");
  return visible;
}
