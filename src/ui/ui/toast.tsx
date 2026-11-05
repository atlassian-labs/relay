import { For, Show, createMemo, createSignal, onCleanup } from "solid-js";
import { createTextAttributes } from "@opentui/core";
import { useSharedTerminalDimensions } from "../context/terminal-dimensions";
import { createSimpleContext } from "../context/helper";
import type { ColorsConfig } from "../../config/themes";
import { truncateTextEnd } from "../util/format";

export type ToastVariant = "info" | "warning" | "error";

export interface ToastMessage {
  text: string;
  variant: ToastVariant;
}

export interface ToastContextValue {
  message: () => ToastMessage | null;
  show: (text: string, variant?: ToastVariant, duration?: number) => void;
  clear: () => void;
}

export function createToastValue(): ToastContextValue {
  const [message, setMessage] = createSignal<ToastMessage | null>(null);
  let timeout: ReturnType<typeof setTimeout> | null = null;

  function clearTimer() {
    if (timeout) clearTimeout(timeout);
    timeout = null;
  }

  function clear() {
    clearTimer();
    setMessage(null);
  }

  function show(text: string, variant: ToastVariant = "info", duration = 2000) {
    setMessage({ text, variant });
    clearTimer();
    timeout = setTimeout(() => setMessage(null), duration);
  }

  onCleanup(clearTimer);

  return { message, show, clear };
}

export const ToastContext = createSimpleContext<ToastContextValue>({
  name: "Toast",
  init: createToastValue,
});

export const ToastProvider = ToastContext.provider;
export const useToast = ToastContext.use;

const TOAST_COMPACT_MAX_WIDTH = 84;
const TOAST_WIDE_MAX_WIDTH = 120;
const TOAST_WIDE_TERMINAL_MIN_WIDTH = 120;
const TOAST_MIN_WIDTH = 18;
const TOAST_OUTER_MARGIN = 2;
const TOAST_PADDING_X = 1;
export const TOAST_INFO_SYMBOL = "※";
export const TOAST_WARNING_SYMBOL = "⚠";
export const TOAST_ERROR_SYMBOL = "■";
const TOAST_ACCENT_GAP = " ";
const TOAST_LABEL_GAP = "  ";
const TOAST_MIN_MESSAGE_WIDTH_WITH_LABEL = 8;
const TOAST_MAX_LINES = 5;

function toastTextMeasure(text: string): number {
  return Math.max(0, ...text.split("\n").map((line) => line.length));
}

function wrapToastText(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const rawLine of text.split("\n")) {
    let remaining = rawLine;
    if (remaining.length === 0) {
      lines.push("");
      continue;
    }
    while (remaining.length > width) {
      const slice = remaining.slice(0, width + 1);
      const breakAt = Math.max(slice.lastIndexOf(" "), slice.lastIndexOf("/"), slice.lastIndexOf("-"));
      const index = breakAt > Math.floor(width * 0.45) ? breakAt + 1 : width;
      lines.push(remaining.slice(0, index).trimEnd());
      remaining = remaining.slice(index).trimStart();
    }
    lines.push(remaining);
  }
  if (lines.length <= TOAST_MAX_LINES) return lines;
  const visible = lines.slice(0, TOAST_MAX_LINES);
  visible[visible.length - 1] = truncateTextEnd(visible[visible.length - 1], Math.max(1, width));
  return visible;
}

function toastLabel(variant: ToastVariant): string | null {
  if (variant === "error") return "Error";
  if (variant === "warning") return "Warning";
  return null;
}

function toastAccentColor(colors: ColorsConfig, variant: ToastVariant): string {
  if (variant === "error") return colors.error;
  if (variant === "warning") return colors.notice;
  return colors.accent;
}

function toastAccentSymbol(variant: ToastVariant): string {
  if (variant === "error") return TOAST_ERROR_SYMBOL;
  if (variant === "warning") return TOAST_WARNING_SYMBOL;
  return TOAST_INFO_SYMBOL;
}

function toastPrefixWidth(label: string | null): number {
  return TOAST_INFO_SYMBOL.length + TOAST_ACCENT_GAP.length + (label ? label.length + TOAST_LABEL_GAP.length : 0);
}

function visibleToastLabel(message: ToastMessage, width: number): string | null {
  const label = toastLabel(message.variant);
  if (!label) return null;
  const labeledMessageWidth = width - toastPrefixWidth(label) - TOAST_PADDING_X * 2;
  return labeledMessageWidth >= Math.min(toastTextMeasure(message.text), TOAST_MIN_MESSAGE_WIDTH_WITH_LABEL)
    ? label
    : null;
}

export function Toast(props: { colors: ColorsConfig }) {
  const dims = useSharedTerminalDimensions();
  const toast = useToast();
  const labelAttributes = createTextAttributes({ bold: true });
  const terminalWidth = createMemo(() => dims().width);
  const availableWidth = () => Math.max(1, terminalWidth() - TOAST_OUTER_MARGIN * 2);
  const maxFrameWidth = () =>
    Math.min(
      terminalWidth() >= TOAST_WIDE_TERMINAL_MIN_WIDTH ? TOAST_WIDE_MAX_WIDTH : TOAST_COMPACT_MAX_WIDTH,
      availableWidth(),
    );
  const minFrameWidth = () => Math.min(TOAST_MIN_WIDTH, maxFrameWidth());
  const frameWidth = (message: ToastMessage) => {
    const naturalWidth =
      toastPrefixWidth(toastLabel(message.variant)) + toastTextMeasure(message.text) + TOAST_PADDING_X * 2;
    return Math.min(maxFrameWidth(), Math.max(minFrameWidth(), naturalWidth));
  };

  return (
    <Show when={toast.message()}>
      {(current) => {
        const message = createMemo(() => current());
        const width = createMemo(() => frameWidth(message()));
        const label = createMemo(() => visibleToastLabel(message(), width()));
        const textWidth = createMemo(() => Math.max(1, width() - toastPrefixWidth(label()) - TOAST_PADDING_X * 2));
        const lines = createMemo(() => wrapToastText(message().text, textWidth()));
        const accentColor = createMemo(() => toastAccentColor(props.colors, message().variant));
        const backgroundColor = props.colors.bg;
        return (
          <box
            position="absolute"
            zIndex={3000}
            top={1}
            right={TOAST_OUTER_MARGIN}
            width={width()}
            height={lines().length}
            flexDirection="row"
            backgroundColor={backgroundColor}
            paddingLeft={TOAST_PADDING_X}
            paddingRight={TOAST_PADDING_X}
          >
            <text fg={accentColor()} bg={backgroundColor} wrapMode="none">
              {toastAccentSymbol(message().variant)}
            </text>
            <text fg={props.colors.textMuted} bg={backgroundColor} wrapMode="none">
              {TOAST_ACCENT_GAP}
            </text>
            <Show when={label()}>
              {(labelText) => (
                <>
                  <text fg={accentColor()} bg={backgroundColor} attributes={labelAttributes} wrapMode="none">
                    {labelText()}
                  </text>
                  <text fg={props.colors.textMuted} bg={backgroundColor} wrapMode="none">
                    {TOAST_LABEL_GAP}
                  </text>
                </>
              )}
            </Show>
            <box flexDirection="column" width={textWidth()} height={lines().length}>
              <For each={lines()}>
                {(line) => (
                  <text fg={props.colors.fg} bg={backgroundColor} wrapMode="none">
                    {line}
                  </text>
                )}
              </For>
            </box>
          </box>
        );
      }}
    </Show>
  );
}
