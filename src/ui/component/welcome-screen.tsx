import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { createTextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import { useSharedTerminalDimensions } from "../context/terminal-dimensions";
import { useApp, type InfoBlock } from "../state";
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
import { copyToClipboard } from "../util/clipboard";
import { openUrl } from "../util/links";
import { handleRelayLineMouseAction } from "../util/relay-line-click";
import { TOAST_ERROR_SYMBOL, TOAST_INFO_SYMBOL, TOAST_WARNING_SYMBOL, useToast } from "../ui/toast";
import { RelayLineText } from "./relay-line-text";
import { normalizeRelayLines, type RelayWidgetEntry } from "../../plugins/slots";
import type { RelayLine } from "../../plugins/types";
import { primaryStartupErrorFromStderr } from "../../acp/startup-error";
import { getConfig, subscribeConfig } from "../../config";
import { ModalFrame } from "./modal-frame";
import { ModalFooter, ModalHeader } from "./modal-layout";
import { RELAY_LOGO_LINES } from "../util/relay-logo";

export const WELCOME_TIPS = [
  "Use /settings to update themes, notifications, and more",
  "Press @ to attach files or folders with autocomplete",
  "Press ctrl/option+v to attach an image from the OS clipboard",
  "Press tab to complete paths like ./src, ../, and ~/Desktop",
  "Use !cmd to run a local shell command without sending output",
  "Use !!cmd to attach shell command output to your next prompt",
  "Press ctrl+b to spawn or switch threads and worktrees",
  "Press shift+tab to switch modes before sending your next prompt",
  "Press ctrl+l to open links detected in the conversation",
  "Use ↑ and ↓ to reuse or edit prompts from your history",
  "Press ctrl+r to search your prompt history",
  "Press shift+enter when you need a newline instead of sending",
  "Press alt/option+enter to steer this turn, not queue",
  "Use alt+↑/↓ to move through chat blocks and queued prompts",
  "Use ctrl+m / ctrl+t to cycle models and thinking levels",
  "Press ? with an empty prompt to show keyboard shortcuts and tips",
  "Press ctrl+x to open external editor to edit large prompts",
  "Use /subagents to inspect subagent work in detail",
  "Double-click a block, or focus it and press enter/→ for details",
  "Use /plugins to discover, enable, and manage Relay plugins",
  "Use /relay-plugins to create and test Relay plugins",
  "Use /relay-themes to create and install custom themes",
  "Use /reload after plugin edits to refresh without restarting",
] as const;

export interface ConnectionFailureSummary {
  lead: string;
  reason: string;
  details: string;
}

export interface StartupErrorSummary extends ConnectionFailureSummary {
  title: string;
}

export interface InlineConnectionFailureLine {
  text: string;
  lead: string;
  reason: string;
}

const STARTUP_ERROR_INLINE_MAX_WIDTH = 72;
const STARTUP_ERROR_INLINE_MAX_LINES = 3;
const STARTUP_ERROR_INLINE_MAX_CHARS = 300;
const STARTUP_ERROR_DETAILS_ICON = " ↗";
const CONNECTION_ERROR_TITLE = "Connection error";
const STARTUP_ERROR_TITLE = "Startup error";
const WELCOME_VERTICAL_OFFSET_ROWS = 2;

export const RELAY_WELCOME_LOGO_LINES = RELAY_LOGO_LINES;

function promotedConnectionFailureReason(content: string, fallback: string): string {
  return primaryStartupErrorFromStderr(content) || fallback;
}

export function connectionFailureSummary(content: string): ConnectionFailureSummary | null {
  const firstLine = content.split(/\r?\n/, 1)[0]?.trimEnd() ?? "";
  if (!firstLine.startsWith("Failed to connect to ")) return null;

  const reasonMarker = " agent: ";
  const reasonStart = firstLine.indexOf(reasonMarker);
  if (reasonStart < 0) return null;

  const leadEnd = reasonStart + reasonMarker.length;
  const fallbackReason = firstLine.slice(leadEnd) || "Unknown error";
  return {
    lead: firstLine.slice(0, leadEnd),
    reason: promotedConnectionFailureReason(content, fallbackReason),
    details: content.trimEnd(),
  };
}

function inlineStartupErrorWidth(screenWidth: number): number {
  return Math.max(1, Math.min(STARTUP_ERROR_INLINE_MAX_WIDTH, screenWidth - UI_MODAL_HORIZONTAL_MARGIN));
}

function wrapTextWithOffsets(text: string, width: number): Array<{ text: string; start: number }> {
  const maxWidth = Math.max(1, width);
  const lines: Array<{ text: string; start: number }> = [];
  for (let index = 0; index < text.length; index += maxWidth) {
    lines.push({ text: text.slice(index, index + maxWidth), start: index });
  }
  return lines.length > 0 ? lines : [{ text: "", start: 0 }];
}

export function startupErrorSummary(content: string): StartupErrorSummary | null {
  const connection = connectionFailureSummary(content);
  if (connection) return { ...connection, title: CONNECTION_ERROR_TITLE };

  const details = content.trimEnd();
  if (!details) return null;
  const firstLine = details.split(/\r?\n/, 1)[0]?.trimEnd() || STARTUP_ERROR_TITLE;
  return {
    lead: "",
    reason: firstLine,
    details,
    title: STARTUP_ERROR_TITLE,
  };
}

export function formatInlineStartupError(
  summary: ConnectionFailureSummary,
  prefix: string,
  width: number,
): InlineConnectionFailureLine[] {
  const lineWidth = Math.max(1, Math.min(STARTUP_ERROR_INLINE_MAX_WIDTH, width));
  const prefixLead = prefix + summary.lead;
  const visibleBudget = Math.min(STARTUP_ERROR_INLINE_MAX_CHARS, lineWidth * STARTUP_ERROR_INLINE_MAX_LINES);
  const baseBudget = Math.max(0, visibleBudget - STARTUP_ERROR_DETAILS_ICON.length);
  const displayText = `${truncateTextEnd(`${prefixLead}${summary.reason}`, baseBudget)}${STARTUP_ERROR_DETAILS_ICON}`;
  const leadEnd = Math.min(prefixLead.length, displayText.length);

  return wrapTextWithOffsets(displayText, lineWidth)
    .slice(0, STARTUP_ERROR_INLINE_MAX_LINES)
    .map((line) => {
      const lineLeadLength = Math.max(0, Math.min(line.text.length, leadEnd - line.start));
      return {
        text: line.text,
        lead: line.text.slice(0, lineLeadLength),
        reason: line.text.slice(lineLeadLength),
      };
    });
}

export function formatInlineConnectionFailure(
  summary: ConnectionFailureSummary,
  prefix: string,
  width: number,
): InlineConnectionFailureLine[] {
  return formatInlineStartupError(summary, prefix, width);
}

function wrapModalLines(text: string, width: number): string[] {
  const maxWidth = Math.max(1, width);
  const lines: string[] = [];
  for (const rawLine of text.replace(/\r\n/g, "\n").split("\n")) {
    if (rawLine.length === 0) {
      lines.push("");
      continue;
    }
    for (let index = 0; index < rawLine.length; index += maxWidth) {
      lines.push(rawLine.slice(index, index + maxWidth));
    }
  }
  return lines;
}

export function WelcomeScreen(props: {
  welcomeAddonWidgets?: () => readonly RelayWidgetEntry[];
  onConnectionErrorModalOpenChange?: (open: boolean) => void;
}) {
  const app = useApp();
  const colors = getColors();
  const dims = useSharedTerminalDimensions();
  const [detailsOpen, setDetailsOpen] = createSignal(false);
  const [detailsTitle, setDetailsTitle] = createSignal(STARTUP_ERROR_TITLE);
  const [detailsContent, setDetailsContent] = createSignal("");
  const [showTips, setShowTips] = createSignal(getConfig().ui.show_tips);

  const unsubscribeConfig = subscribeConfig((change) => setShowTips(change.config.ui.show_tips));
  onCleanup(unsubscribeConfig);

  createEffect(() => props.onConnectionErrorModalOpenChange?.(detailsOpen()));

  useKeyboard((evt: any) => {
    if (!detailsOpen()) return;
    if (evt.name === "escape") {
      setDetailsOpen(false);
      evt.preventDefault?.();
    }
  });

  const shortcutLine1 = {
    keys: ["/", "@", "tab", "!"],
    labels: [" commands", " files", " complete", " bash"],
  };
  const shortcutLine2 = {
    keys: ["shift+tab", "↑/↓"],
    labels: [" mode", " history"],
  };
  const helpHintLine = {
    keys: ["?"],
    labels: [" for help"],
  };
  const infoMessages = () =>
    app.state.blocks
      .filter(
        (block) =>
          block.type === "info" &&
          (block as InfoBlock).variant !== "session" &&
          (block as InfoBlock).variant !== "resources",
      )
      .map((block) => ({
        content: (block as InfoBlock).content,
        variant: (block as InfoBlock).variant,
      }));

  const logoWidth = Math.max(...RELAY_WELCOME_LOGO_LINES.map((line) => line.length));
  const showWelcomeTips = () => showTips() && dims().height >= 24;
  const hasStartupError = () => infoMessages().some((message) => message.variant === "error");
  const bannerHeight = () => RELAY_WELCOME_LOGO_LINES.length + 2 + (showWelcomeTips() ? 2 : 0);
  const hasWelcomeAddons = () => (props.welcomeAddonWidgets?.() ?? []).length > 0;
  const topPad = () => {
    if (hasStartupError()) return 0;
    return (
      Math.max(0, Math.floor((dims().height - bannerHeight() - 6 - (hasWelcomeAddons() ? 12 : 0)) / 2) - 1) +
      WELCOME_VERTICAL_OFFSET_ROWS
    );
  };

  const centerPad = (text: string) => {
    const pad = Math.max(0, Math.floor((dims().width - text.length) / 2));
    return " ".repeat(pad) + text;
  };

  const renderShortcutLine = (line: { keys: string[]; labels: string[] }) => {
    const plain = line.keys.map((key, index) => key + line.labels[index]).join(" • ");
    const pad = Math.max(0, Math.floor((dims().width - plain.length) / 2));
    const parts: any[] = [<span style={{ fg: colors.textMuted } as any}>{" ".repeat(pad)}</span>];
    line.keys.forEach((key, index) => {
      if (index > 0) parts.push(<span style={{ fg: colors.textMuted } as any}>{" • "}</span>);
      parts.push(<span style={{ fg: colors.textLabel } as any}>{key}</span>);
      parts.push(<span style={{ fg: colors.textSubtle } as any}>{line.labels[index]}</span>);
    });
    return parts;
  };

  const renderStartupErrorLine = (message: { content: string }, prefix: string, color: string) => {
    const summary = startupErrorSummary(message.content);
    if (!summary) return null;

    const openDetails = (event?: { stopPropagation?: () => void }) => {
      event?.stopPropagation?.();
      setDetailsTitle(summary.title);
      setDetailsContent(summary.details);
      setDetailsOpen(true);
    };

    return (
      <box width="100%" flexDirection="column" onMouseDown={openDetails}>
        <For each={formatInlineStartupError(summary, prefix, inlineStartupErrorWidth(dims().width))}>
          {(line) => {
            const pad = Math.max(0, Math.floor((dims().width - line.text.length) / 2));
            return (
              <box width="100%" height={1} flexDirection="row">
                <text fg={color} wrapMode="none">
                  {" ".repeat(pad) + line.lead}
                </text>
                <text fg={color} attributes={createTextAttributes({ underline: true })} wrapMode="none">
                  {line.reason}
                </text>
              </box>
            );
          }}
        </For>
      </box>
    );
  };

  return (
    <box flexGrow={1} flexShrink={1} minHeight={0} width="100%" flexDirection="column" overflow="hidden">
      <box height={topPad()} flexShrink={0} />
      <For each={RELAY_WELCOME_LOGO_LINES}>
        {(line) => (
          <box width="100%" height={1}>
            <text fg={colors.fg} wrapMode="none">
              {" ".repeat(Math.max(0, Math.floor((dims().width - logoWidth) / 2))) + line}
            </text>
          </box>
        )}
      </For>
      <box width="100%" height={1}>
        <text>{renderShortcutLine(helpHintLine)}</text>
      </box>
      <Show when={showWelcomeTips()}>
        <box height={1} flexShrink={0} />
        <box width="100%" height={1}>
          <text>{renderShortcutLine(shortcutLine1)}</text>
        </box>
        <box width="100%" height={1}>
          <text>{renderShortcutLine(shortcutLine2)}</text>
        </box>
      </Show>
      <box height={1} flexShrink={0} />
      {(() => {
        const messages = infoMessages();
        const message = messages[messages.length - 1];
        const color = !message
          ? colors.textMuted
          : message.variant === "error"
            ? colors.error
            : message.variant === "warning"
              ? colors.notice
              : colors.info;
        const prefix = !message
          ? ""
          : message.variant === "error"
            ? `${TOAST_ERROR_SYMBOL} `
            : message.variant === "warning"
              ? `${TOAST_WARNING_SYMBOL} `
              : `${TOAST_INFO_SYMBOL} `;
        const lines = message ? message.content.split("\n") : [""];
        return (
          <box width="100%" flexDirection="column">
            <Show
              when={message?.variant === "error" && renderStartupErrorLine(message, prefix, color)}
              fallback={
                <For each={lines}>
                  {(line, i) => (
                    <box width="100%" height={1}>
                      <text fg={color}>{i() === 0 ? centerPad(prefix + line) : centerPad("  " + line)}</text>
                    </box>
                  )}
                </For>
              }
            >
              {(line) => line()}
            </Show>
          </box>
        );
      })()}
      <WelcomeAddonWidgets widgets={() => props.welcomeAddonWidgets?.() ?? []} />
      <box flexGrow={1} flexShrink={1} />
      <ConnectionErrorDetailsModal
        open={detailsOpen}
        title={detailsTitle}
        content={detailsContent}
        onClose={() => setDetailsOpen(false)}
      />
    </box>
  );
}

export function WelcomeAddonWidgets(props: {
  widgets: () => readonly RelayWidgetEntry[];
  openUrl?: (url: string) => void;
}) {
  const colors = getColors();
  const dims = useSharedTerminalDimensions();
  const [frame, setFrame] = createSignal(0);
  const open = props.openUrl ?? openUrl;
  const contentWidth = () => Math.max(1, dims().width);
  const contentHeight = () => Math.max(0, dims().height);
  const entries = () => props.widgets();

  createEffect(() => {
    const intervals = entries()
      .map((entry) => entry.widget.intervalMs)
      .filter((value): value is number => typeof value === "number" && value > 0);
    if (intervals.length === 0) return;
    // effect-shape-allow: Welcome addon timer is scoped to Solid cleanup.
    const handle = setInterval(() => setFrame((value) => value + 1), Math.min(...intervals));
    onCleanup(() => clearInterval(handle));
  });

  const lines = createMemo(() => {
    frame();
    return entries().flatMap((entry) =>
      normalizeRelayLines(
        entry.widget.render({
          placement: "welcomeAddon",
          width: contentWidth(),
          height: contentHeight(),
          focused: entry.focused,
          colors: getColors(),
        }),
      ),
    );
  });

  return (
    <Show when={lines().length > 0}>
      <box height={1} flexShrink={0} />
      <box width="100%" flexDirection="column" flexShrink={0}>
        <For each={lines()}>
          {(line) => (
            <box height={1} width="100%" onMouseDown={(event) => handleRelayLineMouseAction(line, event, open)}>
              <RelayLineText line={line} fallbackFg={colors.fg} />
            </box>
          )}
        </For>
      </box>
    </Show>
  );
}

function ConnectionErrorDetailsModal(props: {
  open: () => boolean;
  title: () => string;
  content: () => string;
  onClose: () => void;
}) {
  const colors = getColors();
  const dims = useSharedTerminalDimensions();
  const toast = useToast();
  const [scrollOffset, setScrollOffset] = createSignal(0);
  const modalWidth = () =>
    clampDimension(
      Math.floor(dims().width * 0.72),
      Math.min(UI_MODAL_MIN_WIDTH, Math.max(1, dims().width - 2)),
      Math.min(UI_MODAL_MAX_WIDTH, Math.max(1, dims().width - UI_MODAL_HORIZONTAL_MARGIN)),
    );
  const contentWidth = () => Math.max(0, modalWidth() - 4);
  const bodyLines = () => wrapModalLines(props.content(), contentWidth());
  const modalHeight = () =>
    clampDimension(
      Math.min(Math.floor(dims().height * 0.7), bodyLines().length + 5),
      Math.min(UI_MODAL_MIN_HEIGHT, Math.max(1, dims().height - 2)),
      Math.max(1, dims().height - UI_MODAL_VERTICAL_MARGIN),
    );
  const modalTop = () => Math.max(0, Math.floor((dims().height - modalHeight()) / 2));
  const maxBodyRows = () => Math.max(1, modalHeight() - 4);
  const maxScrollOffset = () => Math.max(0, bodyLines().length - maxBodyRows());
  const scrollBy = (delta: number) => {
    setScrollOffset((current) => Math.min(maxScrollOffset(), Math.max(0, current + delta)));
  };
  const visibleBodyLines = () => bodyLines().slice(scrollOffset(), scrollOffset() + maxBodyRows());
  const rangeLabel = () => {
    const total = bodyLines().length;
    if (total <= maxBodyRows()) return "";
    return `${scrollOffset() + 1}-${Math.min(total, scrollOffset() + maxBodyRows())}/${total}`;
  };
  const footerLabel = () => (rangeLabel() ? "↑/↓ scroll · pgup/pgdn" : "");
  const copyError = (event?: { stopPropagation?: () => void }) => {
    event?.stopPropagation?.();
    const copied = copyToClipboard(props.content());
    toast.show(copied ? "Copied error to clipboard" : "Unable to copy error", copied ? "info" : "error");
  };
  const consumeKey = (evt: any) => {
    evt.preventDefault?.();
    evt.stopPropagation?.();
  };

  createEffect(() => {
    props.content();
    props.open();
    setScrollOffset(0);
  });

  createEffect(() => {
    setScrollOffset((current) => Math.min(current, maxScrollOffset()));
  });

  useKeyboard((evt: any) => {
    if (!props.open()) return;
    if (evt.name === "escape") {
      props.onClose();
      consumeKey(evt);
      return;
    }
    if (evt.name === "down") scrollBy(1);
    else if (evt.name === "up") scrollBy(-1);
    else if (evt.name === "pagedown") scrollBy(maxBodyRows());
    else if (evt.name === "pageup") scrollBy(-maxBodyRows());
    else if (evt.name === "end") setScrollOffset(maxScrollOffset());
    else if (evt.name === "home") setScrollOffset(0);
    else if (evt.name === "c") copyError();
    else return;
    consumeKey(evt);
  });

  return (
    <ModalFrame
      open={props.open}
      width={modalWidth}
      height={modalHeight}
      top={modalTop}
      zIndex={3200}
      onClose={props.onClose}
    >
      <ModalHeader
        title={props.title}
        right="c copy · esc"
        width={contentWidth}
        onRightMouseDown={copyError}
        rightAccent
      />
      <For each={visibleBodyLines()}>
        {(line) => (
          <box height={1}>
            <text fg={colors.fg} wrapMode="none">
              {line}
            </text>
          </box>
        )}
      </For>
      <box flexGrow={1} />
      <ModalFooter width={contentWidth} left={rangeLabel} right={footerLabel} />
    </ModalFrame>
  );
}
