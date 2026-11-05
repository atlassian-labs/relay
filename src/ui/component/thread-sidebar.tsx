import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { createTextAttributes } from "@opentui/core";
import { useSharedTerminalDimensions } from "../context/terminal-dimensions";
import type { ThreadInfo } from "../../core/threads";
import type { RelayLine } from "../../plugins/types";
import { normalizeRelayLines, type RelayWidgetEntry } from "../../plugins/slots";
import { getColors, getSyntaxStyle } from "../context/theme";
import { openUrl } from "../util/links";
import { handleRelayLineMouseAction } from "../util/relay-line-click";
import { visibleSidebarThreads } from "../app/sidebar-navigation";
import { truncateTextEnd } from "../util/format";
import { RelayLineText } from "./relay-line-text";

export interface ThreadSidebarProps {
  threads: () => ThreadInfo[];
  activeThreadId: () => string;
  focused: () => boolean;
  focusedIndex: () => number;
  expanded: () => boolean;
  width: () => number;
  listOffset: () => number;
  spinnerChar: () => string;
  getPreview: (threadId: string) => string;
  onSelect: (threadId: string) => void;
  onCreateLocal: () => void;
  onCreateWorktree: () => void;
  onCreateExistingWorktree: () => void;
  onArchive: (threadId: string) => void;
  pluginWidgets?: () => readonly RelayWidgetEntry[];
}

export function ThreadSidebar(props: ThreadSidebarProps) {
  const colors = getColors();
  const terminal = useSharedTerminalDimensions();
  const rowBg = (index: number, active: boolean) =>
    props.focused() && index === props.focusedIndex() ? colors.panelUser : active ? colors.panel : undefined;
  const accentColor = (active: boolean, focused: boolean) =>
    focused ? colors.selected : active ? colors.accent : colors.border;
  const titleColor = (active: boolean, focused: boolean) =>
    focused ? colors.badge.label : active ? colors.fg : colors.textMuted;
  const visibleThreads = () =>
    visibleSidebarThreads(props.threads(), props.activeThreadId(), { includeDefaultDrafts: props.expanded() });
  const worktreeLabel = (thread: ThreadInfo) =>
    thread.worktreeBranch ?? thread.worktreePath?.split(/[\\/]+/).pop() ?? "worktree";
  const listHeight = () => Math.max(3, terminal().height - 5);
  const compactVisibleCount = () => Math.max(1, Math.floor(listHeight() / 3));
  const expandedLayout = () => {
    const count = Math.max(1, visibleThreads().length);
    const width = Math.max(30, props.width() - 3);
    const height = Math.max(7, listHeight());
    const maxColumns = Math.max(1, Math.floor(width / 30));
    const maxRows = Math.max(1, Math.floor(height / 7));
    const idealColumns = count <= 2 ? count : Math.ceil(Math.sqrt(count * (width / Math.max(height * 4, 1))));
    const columns = Math.max(1, Math.min(maxColumns, idealColumns));
    const rows = Math.max(1, Math.min(maxRows, Math.ceil(count / columns)));
    return {
      columns,
      rows,
      cardWidth: Math.max(24, Math.floor(width / columns)),
      cardHeight: Math.max(6, Math.floor(height / rows)),
      visibleCount: columns * rows,
    };
  };
  const visibleCount = () => (props.expanded() ? expandedLayout().visibleCount : compactVisibleCount());
  const visibleThreadEntries = () =>
    visibleThreads()
      .slice(props.listOffset(), props.listOffset() + visibleCount())
      .map((thread, index) => ({ thread, absoluteIndex: props.listOffset() + index }));
  const cardKey = (entry: { thread: ThreadInfo; absoluteIndex: number }, compact: boolean) =>
    `${compact ? "compact" : "expanded"}-${entry.thread.id}-${entry.absoluteIndex}`;

  const visibleThreadRows = () => {
    const columns = expandedLayout().columns;
    const entries = visibleThreadEntries();
    const rows: Array<Array<(typeof entries)[number]>> = [];
    for (let index = 0; index < entries.length; index += columns) rows.push(entries.slice(index, index + columns));
    return rows;
  };

  const sidebarWidgets = () => props.pluginWidgets?.() ?? [];
  const [widgetFrame, setWidgetFrame] = createSignal(0);
  const sidebarWidgetWidth = () => Math.max(1, props.width() - 2);
  const sidebarWidgetHeight = (entry: RelayWidgetEntry) => Math.max(1, entry.widget.height ?? 4);
  const sidebarWidgetLines = (entry: RelayWidgetEntry) => {
    widgetFrame();
    return visibleRelayLines(
      normalizeRelayLines(
        entry.widget.render({
          placement: "sidebar",
          width: sidebarWidgetWidth(),
          height: sidebarWidgetHeight(entry),
          focused: entry.focused,
          colors,
        }),
      ),
      sidebarWidgetHeight(entry),
    );
  };

  createEffect(() => {
    const intervals = sidebarWidgets()
      .map((entry) => entry.widget.intervalMs)
      .filter((value): value is number => typeof value === "number" && value > 0);
    if (intervals.length === 0) return;
    // effect-shape-allow: Sidebar plugin widget timer is scoped to Solid cleanup.
    const handle = setInterval(() => setWidgetFrame((value) => value + 1), Math.min(...intervals));
    onCleanup(() => clearInterval(handle));
  });

  function ThreadCard(propsCard: {
    entry: { thread: ThreadInfo; absoluteIndex: number };
    compact: boolean;
    key?: string;
  }) {
    const thread = propsCard.entry.thread;
    const active = () => thread.id === props.activeThreadId();
    const focused = () => props.focused() && props.focusedIndex() === propsCard.entry.absoluteIndex;
    const needsAttention = () => thread.status !== "running" && thread.id !== props.activeThreadId();
    const expanded = () => !propsCard.compact;
    const cardWidth = () => (expanded() ? expandedLayout().cardWidth : "100%");
    const cardHeight = () => (expanded() ? expandedLayout().cardHeight : 3);
    const compactStatusLabel = () => {
      return thread.status === "running"
        ? "running"
        : thread.status === "connecting"
          ? "connecting"
          : needsAttention()
            ? "input"
            : "paused";
    };
    const compactStatusIcon = () =>
      thread.status === "running" || thread.status === "connecting"
        ? props.spinnerChar()
        : needsAttention()
          ? "•"
          : "✓";
    const compactIconColor = () =>
      focused()
        ? colors.badge.label
        : active()
          ? colors.accent
          : thread.status === "running" || thread.status === "connecting"
            ? colors.running
            : needsAttention()
              ? colors.accent
              : colors.textMuted;
    const compactStatusColor = () => (focused() ? colors.badge.label : compactIconColor());
    const compactTitleColor = () => (focused() ? colors.badge.label : colors.textLabel);
    const titleAttributes = () => (focused() ? createTextAttributes({ bold: true }) : undefined);
    const compactStatusIconColor = () =>
      !focused() && !active() && compactStatusIcon() === "•" ? compactTitleColor() : compactStatusColor();
    const workspaceLabel = () => (thread.workspaceKind === "worktree" ? worktreeLabel(thread) : "local");
    const compactTitleWidth = () => Math.max(8, props.width() - 6);
    const compactMetaWidth = () => Math.max(8, props.width() - 5);
    const previewHeight = () => Math.max(2, typeof cardHeight() === "number" ? (cardHeight() as number) - 5 : 4);
    const previewWidth = () => Math.max(12, (typeof cardWidth() === "number" ? (cardWidth() as number) : 28) - 6);
    const previewText = () => {
      const preview = props.getPreview(thread.id) || "No activity yet.";
      const maxLines = previewHeight();
      const maxWidth = previewWidth();
      const output: string[] = [];
      let truncated = false;
      for (const sourceLine of preview.split("\n")) {
        let line = sourceLine;
        if (line.length === 0) {
          output.push("");
        } else {
          while (line.length > 0) {
            output.push(line.slice(0, maxWidth));
            line = line.slice(maxWidth);
            if (output.length >= maxLines) break;
          }
        }
        if (output.length >= maxLines) {
          truncated = true;
          break;
        }
      }
      const visible = output.slice(0, maxLines);
      if (truncated && visible.length > 0) {
        const last = visible[visible.length - 1] ?? "";
        visible[visible.length - 1] = `${last.slice(0, Math.max(0, maxWidth - 1)).trimEnd()}…`;
      }
      return visible.join("\n");
    };

    if (!expanded()) {
      return (
        <box
          flexDirection="row"
          width="100%"
          height={cardHeight()}
          paddingLeft={1}
          onMouseDown={(event: { stopPropagation?: () => void }) => {
            event.stopPropagation?.();
            props.onSelect(thread.id);
          }}
        >
          <box width={2} height="100%" alignItems="center" justifyContent="center">
            <text fg={compactStatusIconColor()} wrapMode="none">
              {compactStatusIcon()}
            </text>
          </box>
          <box
            flexDirection="column"
            flexGrow={1}
            flexShrink={1}
            height="100%"
            justifyContent="center"
            paddingRight={1}
          >
            <box height={1} width="100%" flexDirection="row" justifyContent="space-between">
              <text fg={compactTitleColor()} attributes={titleAttributes()} wrapMode="none" flexShrink={1}>
                {truncateTextEnd(thread.title, compactTitleWidth())}
              </text>
              <text
                fg={focused() ? colors.error : colors.textMuted}
                wrapMode="none"
                flexShrink={0}
                onMouseDown={(event: { stopPropagation?: () => void }) => {
                  event.stopPropagation?.();
                  props.onArchive(thread.id);
                }}
              >
                ×
              </text>
            </box>
            <box height={1} width="100%">
              <text fg={compactStatusColor()} wrapMode="none">
                {truncateTextEnd(`${compactStatusLabel()} · ${workspaceLabel()}`, compactMetaWidth())}
              </text>
            </box>
          </box>
        </box>
      );
    }

    return (
      <box
        flexDirection="row"
        width={cardWidth() as any}
        height={cardHeight()}
        borderStyle="single"
        border={(expanded() ? ["all"] : []) as any}
        borderColor={focused() ? colors.selected : active() ? colors.accent : colors.border}
        backgroundColor={
          expanded() ? (active() ? colors.panel : undefined) : rowBg(propsCard.entry.absoluteIndex, active())
        }
        onMouseDown={(event: any) => {
          event.stopPropagation?.();
          props.onSelect(thread.id);
        }}
      >
        <box flexDirection="column" flexGrow={1} flexShrink={1} paddingLeft={1} paddingRight={1}>
          <Show when={expanded()}>
            <box height={1} width="100%" backgroundColor={accentColor(active(), focused())} paddingLeft={1}>
              <text fg={colors.bg} wrapMode="none">
                {thread.status === "running" ? "running" : thread.status === "connecting" ? "connecting" : "agent"}
              </text>
            </box>
          </Show>
          <box height={1} width="100%" flexDirection="row" justifyContent="space-between">
            <box flexDirection="row" flexShrink={1}>
              <box width={2}>
                <text fg={compactStatusIconColor()} wrapMode="none">
                  {compactStatusIcon()}
                </text>
              </box>
              <text fg={titleColor(active(), focused())} attributes={titleAttributes()} wrapMode="none" flexShrink={1}>
                {truncateTextEnd(thread.title, expanded() ? Math.max(20, (cardWidth() as number) - 8) : 22)}
              </text>
            </box>
            <text
              fg={focused() ? colors.error : colors.textMuted}
              wrapMode="none"
              flexShrink={0}
              onMouseDown={(event: any) => {
                event.stopPropagation?.();
                props.onArchive(thread.id);
              }}
            >
              ×
            </text>
          </box>
          <Show when={thread.workspaceKind === "worktree"}>
            <box height={1} width="100%" paddingLeft={2}>
              <text fg={colors.textLabel} wrapMode="none">
                {truncateTextEnd(worktreeLabel(thread), expanded() ? Math.max(20, (cardWidth() as number) - 5) : 23)}
              </text>
            </box>
          </Show>
          <box height={1} width="100%" flexDirection="row" justifyContent="space-between" paddingLeft={2}>
            <text fg={compactStatusColor()} wrapMode="none" flexShrink={1}>
              {compactStatusLabel()}
            </text>
            <Show when={thread.workspaceKind !== "worktree"}>
              <text fg={colors.textMuted}>local</text>
            </Show>
          </box>
          <Show when={expanded()}>
            <box height={previewHeight()} width="100%" paddingLeft={2} paddingRight={1}>
              <markdown
                syntaxStyle={getSyntaxStyle()}
                internalBlockMode="top-level"
                tableOptions={{ style: "grid" }}
                streaming={thread.status === "running" || thread.status === "connecting"}
                content={previewText()}
                conceal={true}
                fg={focused() ? colors.fg : colors.textMuted}
              />
            </box>
          </Show>
        </box>
      </box>
    );
  }

  return (
    <box
      width={props.width()}
      height="100%"
      flexDirection="column"
      flexShrink={0}
      borderStyle="single"
      border={["right"] as any}
      borderColor={colors.border}
      paddingRight={1}
      onMouseDown={(event: any) => event.stopPropagation?.()}
      onMouseUp={(event: any) => event.stopPropagation?.()}
    >
      <box height={1} width="100%" paddingLeft={1}>
        <text fg={colors.fg} attributes={createTextAttributes({ bold: true })} wrapMode="none">
          {props.expanded() ? "Agents" : "Threads"}
        </text>
      </box>
      <box height={1} width="100%" />
      <box
        height={1}
        paddingLeft={1}
        onMouseDown={(event: any) => {
          event.stopPropagation?.();
          props.onCreateLocal();
        }}
      >
        <text
          fg={props.focused() && props.focusedIndex() === -2 ? colors.badge.label : colors.textMuted}
          attributes={props.focused() && props.focusedIndex() === -2 ? createTextAttributes({ bold: true }) : undefined}
        >
          + local
        </text>
      </box>
      <box
        height={1}
        paddingLeft={1}
        onMouseDown={(event: any) => {
          event.stopPropagation?.();
          props.onCreateWorktree();
        }}
      >
        <text
          fg={props.focused() && props.focusedIndex() === -1 ? colors.badge.label : colors.textMuted}
          attributes={props.focused() && props.focusedIndex() === -1 ? createTextAttributes({ bold: true }) : undefined}
        >
          + new worktree
        </text>
      </box>
      <box
        height={1}
        paddingLeft={1}
        onMouseDown={(event: any) => {
          event.stopPropagation?.();
          props.onCreateExistingWorktree();
        }}
      >
        <text
          fg={props.focused() && props.focusedIndex() === -3 ? colors.badge.label : colors.textMuted}
          attributes={props.focused() && props.focusedIndex() === -3 ? createTextAttributes({ bold: true }) : undefined}
        >
          + existing worktree
        </text>
      </box>
      <box height={1} />
      <box height={1} width="100%" paddingLeft={1}>
        <text fg={colors.border} wrapMode="none">
          {"─".repeat(Math.max(8, props.width() - 3))}
        </text>
      </box>
      <For each={sidebarWidgets()}>
        {(entry) => (
          <box flexDirection="column" flexShrink={0} paddingLeft={1} paddingRight={1}>
            <Show when={entry.widget.title}>
              {(title) => (
                <box height={1}>
                  <text fg={colors.textLabel} wrapMode="none">
                    {title()}
                  </text>
                </box>
              )}
            </Show>
            <For each={sidebarWidgetLines(entry)}>
              {(line) => <SidebarWidgetLine line={line} fallbackFg={colors.fg} />}
            </For>
          </box>
        )}
      </For>
      <Show when={sidebarWidgets().length > 0}>
        <box height={1} width="100%" paddingLeft={1}>
          <text fg={colors.border} wrapMode="none">
            {"─".repeat(Math.max(8, props.width() - 3))}
          </text>
        </box>
      </Show>
      <scrollbox flexGrow={1} flexShrink={1} scrollbarOptions={{ visible: false }}>
        <Show
          when={props.expanded()}
          fallback={
            <For each={visibleThreadEntries()}>
              {(entry) => <ThreadCard entry={entry} compact={true} key={cardKey(entry, true)} />}
            </For>
          }
        >
          <For each={visibleThreadRows()}>
            {(row) => (
              <box flexDirection="row" width="100%">
                <For each={row}>
                  {(entry) => <ThreadCard entry={entry} compact={false} key={cardKey(entry, false)} />}
                </For>
              </box>
            )}
          </For>
        </Show>
      </scrollbox>
    </box>
  );
}

function SidebarWidgetLine(props: { line: RelayLine; fallbackFg?: string }) {
  const height = () => relayLineHeight(props.line);
  return (
    <box height={height()} width="100%" onMouseDown={(event) => handleRelayLineMouseAction(props.line, event, openUrl)}>
      <Show when={props.line.markdown} fallback={<RelayLineText line={props.line} fallbackFg={props.fallbackFg} />}>
        {(markdown) => (
          <markdown
            syntaxStyle={getSyntaxStyle()}
            streaming={false}
            content={markdown()}
            conceal={true}
            fg={props.line.fg ?? props.fallbackFg}
          />
        )}
      </Show>
    </box>
  );
}

function relayLineHeight(line: RelayLine): number {
  return line.markdown ? Math.max(1, line.markdownHeight ?? 1) : 1;
}

function visibleRelayLines(lines: readonly RelayLine[], maxHeight: number): readonly RelayLine[] {
  let remaining = maxHeight;
  const visible: RelayLine[] = [];
  for (const line of lines) {
    if (remaining <= 0) break;
    const height = relayLineHeight(line);
    if (line.markdown && height > remaining) {
      visible.push({ ...line, markdownHeight: remaining });
      break;
    }
    visible.push(line);
    remaining -= height;
  }
  return visible;
}
