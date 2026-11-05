import { createEffect, For, Show } from "solid-js";
import { createSignal } from "solid-js";
import { createTextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import { useSharedTerminalDimensions } from "../context/terminal-dimensions";
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
import { ModalFrame } from "./modal-frame";
import { ModalFooter, ModalHeader } from "./modal-layout";

interface KeyboardEventLike {
  name?: string;
  preventDefault?: () => void;
  stopPropagation?: () => void;
}

type ShortcutEntry = readonly [key: string, description: string];

const shortcutGroups: readonly { readonly title: string; readonly rows: readonly ShortcutEntry[] }[] = [
  {
    title: "Global",
    rows: [
      ["?", "Show shortcuts and tips"],
      ["/", "Slash commands"],
      ["@", "Attach files"],
      ["tab", "Complete path or accept item"],
      ["shift+tab", "Cycle modes"],
      ["ctrl+l", "Open links"],
      ["ctrl+m", "Next model listing"],
      ["ctrl+shift+m", "Previous model listing"],
      ["ctrl+t", "Next thinking level"],
      ["ctrl+shift+t", "Previous thinking level"],
      ["ctrl+b", "Focus or hide thread sidebar"],
      ["ctrl+g", "Expand or compact thread sidebar"],
      ["ctrl+p", "Return to parent session"],
    ],
  },
  {
    title: "Editor",
    rows: [
      ["enter", "Send prompt"],
      ["shift+enter", "Newline"],
      ["option+enter", "Add to current turn (steer)"],
      ["ctrl/option+v", "Paste image from clipboard"],
      ["↑ / ↓", "Prompt history at boundaries"],
      ["ctrl+r", "Search prompt history"],
      ["f2 / ctrl+x", "Open external editor"],
      ["!cmd", "Run local bash only"],
      ["!!cmd", "Attach bash output to next prompt"],
      ["ctrl+c", "Clear input"],
    ],
  },
  {
    title: "Lists & chat",
    rows: [
      ["↑ / ↓", "Move selection"],
      ["enter", "Select item"],
      ["esc", "Close or cancel"],
      ["ctrl+c", "Interrupt or exit"],
      ["alt+↑/↓", "Move through chat and queue"],
      ["enter", "Edit selected queue item"],
      ["shift+alt+↑/↓", "Move selected queue item"],
      ["tab", "Steer selected queue item"],
      ["ctrl+enter", "Send selected queue item now"],
      ["delete", "Remove selected queue item"],
      ["j/k or ↑/↓", "Select transcript block"],
      ["enter/space/→", "Show block details (or double-click)"],
      ["esc/←", "Close details or selection"],
    ],
  },
] as const;

const SHORTCUT_KEY_WIDTH = 16;
const SHORTCUT_COLUMN_GAP = 3;

export interface TipModalRow {
  readonly prefix: string;
  readonly text: string;
}

type ShortcutModalLine =
  | { readonly kind: "heading"; readonly text: string }
  | { readonly kind: "shortcut-row"; readonly entries: readonly [ShortcutEntry, ShortcutEntry?] }
  | { readonly kind: "tip"; readonly row: TipModalRow }
  | { readonly kind: "empty"; readonly text: string };

function pairShortcutRows(rows: readonly ShortcutEntry[]): readonly ShortcutModalLine[] {
  const lines: ShortcutModalLine[] = [];
  for (let index = 0; index < rows.length; index += 2) {
    const first = rows[index];
    if (!first) continue;
    lines.push({ kind: "shortcut-row", entries: [first, rows[index + 1]] });
  }
  return lines;
}

function wrapText(text: string, width: number): readonly string[] {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (normalized.length === 0) return [""];
  const rows: string[] = [];
  let current = "";

  for (const word of normalized.split(" ")) {
    let remaining = word;
    while (remaining.length > width) {
      if (current) {
        rows.push(current);
        current = "";
      }
      rows.push(remaining.slice(0, width));
      remaining = remaining.slice(width);
    }
    if (!remaining) continue;
    if (!current) {
      current = remaining;
      continue;
    }
    if (current.length + remaining.length + 1 <= width) {
      current = `${current} ${remaining}`;
      continue;
    }
    rows.push(current);
    current = remaining;
  }

  if (current) rows.push(current);
  return rows.length > 0 ? rows : [""];
}

export function wrapTipRows(tips: readonly string[], contentWidth: number): readonly TipModalRow[] {
  const normalizedTips = tips.map((tip) => tip.trim()).filter((tip) => tip.length > 0);
  const prefixWidth = Math.max(3, `${normalizedTips.length}. `.length);
  const textWidth = Math.max(1, contentWidth - prefixWidth);
  const rows: TipModalRow[] = [];

  normalizedTips.forEach((tip, tipIndex) => {
    const prefix = `${tipIndex + 1}.`;
    wrapText(tip, textWidth).forEach((text, rowIndex) => {
      rows.push({ prefix: rowIndex === 0 ? prefix : "", text });
    });
  });

  return rows;
}

function shortcutLines(tips: readonly string[], contentWidth: number): readonly ShortcutModalLine[] {
  const lines: ShortcutModalLine[] = [{ kind: "empty", text: "" }];
  shortcutGroups.forEach((group) => {
    lines.push({ kind: "heading", text: group.title });
    lines.push(...pairShortcutRows(group.rows));
    lines.push({ kind: "empty", text: "" });
  });

  lines.push({ kind: "heading", text: "Tips" });
  const tipRows = wrapTipRows(tips, contentWidth);
  if (tipRows.length > 0) lines.push(...tipRows.map((row) => ({ kind: "tip" as const, row })));
  else lines.push({ kind: "empty", text: "No tips available" });
  return lines;
}

export function ShortcutReferenceModal(props: {
  open: () => boolean;
  onClose: () => void;
  tips: () => readonly string[];
}) {
  const dims = useSharedTerminalDimensions();
  const colors = getColors();
  const [scrollOffset, setScrollOffset] = createSignal(0);
  const tips = () =>
    props
      .tips()
      .map((tip) => tip.trim())
      .filter((tip) => tip.length > 0);
  const modalWidth = () =>
    clampDimension(
      Math.floor(dims().width * 0.86),
      Math.min(UI_MODAL_MIN_WIDTH, Math.max(1, dims().width - 2)),
      Math.min(UI_MODAL_MAX_WIDTH + 16, Math.max(1, dims().width - UI_MODAL_HORIZONTAL_MARGIN)),
    );
  const contentWidth = () => Math.max(0, modalWidth() - 4);
  const lines = () => shortcutLines(tips(), contentWidth());
  const modalHeight = () =>
    clampDimension(
      Math.min(Math.floor(dims().height * 0.86), lines().length + 5),
      Math.min(UI_MODAL_MIN_HEIGHT, Math.max(1, dims().height - 2)),
      Math.max(1, dims().height - UI_MODAL_VERTICAL_MARGIN),
    );
  const modalTop = () => Math.max(0, Math.floor((dims().height - modalHeight()) / 2));
  const maxBodyRows = () => Math.max(1, modalHeight() - 4);
  const maxScrollOffset = () => Math.max(0, lines().length - maxBodyRows());
  const visibleLines = () => lines().slice(scrollOffset(), scrollOffset() + maxBodyRows());
  const rangeLabel = () => {
    if (lines().length <= maxBodyRows()) return "";
    return `${scrollOffset() + 1}-${Math.min(lines().length, scrollOffset() + maxBodyRows())}/${lines().length}`;
  };
  const footerHints = () => (rangeLabel() ? ([["↑/↓", "scroll"], ["pgup/pgdn"]] as const) : []);
  const shortcutColumnWidth = () => Math.max(1, Math.floor((contentWidth() - SHORTCUT_COLUMN_GAP) / 2));
  const tipPrefixWidth = () => Math.max(3, `${tips().length}. `.length);
  const scrollBy = (delta: number) => {
    setScrollOffset((current) => Math.min(maxScrollOffset(), Math.max(0, current + delta)));
  };
  const consumeKey = (event: KeyboardEventLike) => {
    event.preventDefault?.();
    event.stopPropagation?.();
  };

  createEffect(() => {
    props.open();
    setScrollOffset(0);
  });

  createEffect(() => {
    setScrollOffset((current) => Math.min(current, maxScrollOffset()));
  });

  useKeyboard((event: KeyboardEventLike) => {
    if (!props.open()) return;
    if (event.name === "escape") {
      props.onClose();
      consumeKey(event);
      return;
    }
    if (event.name === "down") scrollBy(1);
    else if (event.name === "up") scrollBy(-1);
    else if (event.name === "pagedown") scrollBy(maxBodyRows());
    else if (event.name === "pageup") scrollBy(-maxBodyRows());
    else if (event.name === "end") setScrollOffset(maxScrollOffset());
    else if (event.name === "home") setScrollOffset(0);
    else return;
    consumeKey(event);
  });

  const renderShortcutEntry = (entry: ShortcutEntry | undefined, includeGap: boolean) => (
    <box width={includeGap ? shortcutColumnWidth() + SHORTCUT_COLUMN_GAP : shortcutColumnWidth()} flexDirection="row">
      <Show when={entry}>
        {(shortcut) => (
          <>
            <text
              fg={colors.textLabel}
              width={Math.min(SHORTCUT_KEY_WIDTH, shortcutColumnWidth())}
              wrapMode="none"
              truncate
            >
              {shortcut()[0]}
            </text>
            <text
              fg={colors.textSubtle}
              width={Math.max(0, shortcutColumnWidth() - SHORTCUT_KEY_WIDTH)}
              wrapMode="none"
              truncate
            >
              {shortcut()[1]}
            </text>
          </>
        )}
      </Show>
      <Show when={includeGap}>
        <text width={SHORTCUT_COLUMN_GAP} wrapMode="none">
          {""}
        </text>
      </Show>
    </box>
  );

  return (
    <ModalFrame
      open={props.open}
      width={modalWidth}
      height={modalHeight}
      top={modalTop}
      zIndex={3000}
      onClose={props.onClose}
    >
      <ModalHeader title="Keyboard shortcuts" right="esc" width={contentWidth} />
      <For each={visibleLines()}>
        {(line) => (
          <box height={1} width="100%" flexDirection="row">
            <Show when={line.kind === "shortcut-row"}>
              {renderShortcutEntry(line.kind === "shortcut-row" ? line.entries[0] : undefined, true)}
              {renderShortcutEntry(line.kind === "shortcut-row" ? line.entries[1] : undefined, false)}
            </Show>
            <Show when={line.kind === "heading"}>
              <text fg={colors.accent} attributes={createTextAttributes({ bold: true })} wrapMode="none">
                {line.kind === "heading" ? line.text : ""}
              </text>
            </Show>
            <Show when={line.kind === "tip"}>
              <text fg={colors.textLabel} width={tipPrefixWidth()} wrapMode="none">
                {line.kind === "tip" ? line.row.prefix : ""}
              </text>
              <text fg={colors.fg} wrapMode="none">
                {truncateTextEnd(
                  line.kind === "tip" ? line.row.text : "",
                  Math.max(0, contentWidth() - tipPrefixWidth()),
                )}
              </text>
            </Show>
            <Show when={line.kind === "empty"}>
              <text fg={colors.textMuted} wrapMode="none">
                {line.kind === "empty" ? line.text : ""}
              </text>
            </Show>
          </box>
        )}
      </For>
      <box flexGrow={1} />
      <ModalFooter width={contentWidth} left={rangeLabel} rightHints={footerHints} />
    </ModalFrame>
  );
}
