import { createSignal, onCleanup, Show } from "solid-js";
import { getConfig, subscribeConfig } from "../../config";
import { RelayLineText } from "./relay-line-text";
import { useApp } from "../state";
import { getColors } from "../context/theme";
import { statusLabel as getStatusLabel } from "../util/status-label";
import { combineRelayLines, type EditorChromeElementResolver } from "../util/editor-chrome";
import { handleRelayLineMouseAction } from "../util/relay-line-click";
import { openUrl } from "../util/links";
import { UI_GUTTER_X } from "../layout";
import { subagentEntries } from "../app/subagents";
import { childStatusLabel, directChildThreads, parentThreadForChild } from "../app/children";
import { matchChildSessionTaskTypes } from "../../core/child-session-task-types";
import type { VimMode } from "../util/vim-engine";
import type { RelayEditorSegmentContent, RelayLine, RelayLineSegment, RelayPluginStatus } from "../../plugins";

const VIM_MODE_LABELS: Record<VimMode, string> = {
  insert: "INSERT",
  normal: "NORMAL",
  visual: "VISUAL",
  "visual-line": "V-LINE",
};

export interface StatusLineHint {
  readonly key: string;
  readonly label: string;
}

export function statusLineContentText(content: RelayEditorSegmentContent): string {
  if (typeof content === "string") return content;
  if (content.segments && content.segments.length > 0) return content.segments.map((segment) => segment.text).join("");
  return content.text;
}

export function joinStatusLineSegments(pluginStatusLineSegments: readonly RelayEditorSegmentContent[]): RelayLine {
  const segments: RelayLineSegment[] = [];
  pluginStatusLineSegments.forEach((segment, index) => {
    if (index > 0) segments.push({ text: " · " });
    appendStatusLineContent(segments, segment);
  });
  return { text: segments.map((segment) => segment.text).join(""), segments };
}

export function resolveStatusLineRightContent(
  statusHint: StatusLineHint | null,
  pluginStatusLineSegments: readonly RelayEditorSegmentContent[],
): { readonly hint: StatusLineHint | null; readonly statusLine: RelayLine } {
  return statusHint
    ? { hint: statusHint, statusLine: { text: "" } }
    : { hint: null, statusLine: joinStatusLineSegments(pluginStatusLineSegments) };
}

function appendStatusLineContent(segments: RelayLineSegment[], content: RelayEditorSegmentContent): void {
  const line: RelayLine = typeof content === "string" ? { text: content } : content;
  if (line.segments?.length) {
    for (const segment of line.segments) {
      const fg = segment.fg ?? line.fg;
      const bg = segment.bg ?? line.bg;
      const href = segment.href ?? line.href;
      const ctrlHref = segment.ctrlHref ?? line.ctrlHref;
      const onClick = segment.onClick ?? line.onClick;
      segments.push({
        text: segment.text,
        ...(fg === undefined ? {} : { fg }),
        ...(bg === undefined ? {} : { bg }),
        ...(segment.bold === true || line.bold === true ? { bold: true } : {}),
        ...(segment.underline === true || line.underline === true ? { underline: true } : {}),
        ...(segment.strikethrough === true || line.strikethrough === true ? { strikethrough: true } : {}),
        ...(href === undefined ? {} : { href }),
        ...(ctrlHref === undefined ? {} : { ctrlHref }),
        ...(onClick === undefined ? {} : { onClick }),
      });
    }
    return;
  }
  segments.push({
    text: line.text,
    ...(line.fg === undefined ? {} : { fg: line.fg }),
    ...(line.bg === undefined ? {} : { bg: line.bg }),
    ...(line.bold === undefined ? {} : { bold: line.bold }),
    ...(line.underline === undefined ? {} : { underline: line.underline }),
    ...(line.strikethrough === undefined ? {} : { strikethrough: line.strikethrough }),
    ...(line.href === undefined ? {} : { href: line.href }),
    ...(line.ctrlHref === undefined ? {} : { ctrlHref: line.ctrlHref }),
    ...(line.onClick === undefined ? {} : { onClick: line.onClick }),
  });
}

export function StatusLine(props: {
  spinnerChar: () => string;
  composerText?: () => string;
  vimStatus?: () => { mode: VimMode; pending: string } | null;
  pluginStatusSegments?: () => readonly RelayPluginStatus[];
  pluginStatusLineSegments?: () => readonly RelayEditorSegmentContent[];
  resolveElement?: EditorChromeElementResolver;
}) {
  const app = useApp();
  const colors = getColors();
  const [showTips, setShowTips] = createSignal(getConfig().ui.show_tips);
  const [taskTypes, setTaskTypes] = createSignal(getConfig().task_types);
  const unsubscribeConfig = subscribeConfig((change) => {
    setShowTips(change.config.ui.show_tips);
    setTaskTypes(change.config.task_types);
  });
  onCleanup(unsubscribeConfig);
  const element = (
    name: Parameters<EditorChromeElementResolver>[0]["element"],
    line: RelayLine,
    active?: boolean,
  ): RelayLine =>
    props.resolveElement?.({ surface: "header", element: name, line, ...(active === undefined ? {} : { active }) }) ??
    line;

  const appIsSpinning = () =>
    app.state.connecting || app.state.running || app.state.spinnerActive || Boolean(app.state.spinnerLabel);
  const pluginStatusSegments = () => props.pluginStatusSegments?.() ?? [];
  const pluginActivityStatus = () =>
    appIsSpinning() ? null : (pluginStatusSegments().find((segment) => segment.spinner) ?? null);
  const visiblePluginStatusSegments = () =>
    pluginStatusSegments()
      .filter((segment) => !(pluginActivityStatus() && segment.spinner))
      .map((segment) => segment.text);
  const isSpinning = () => appIsSpinning() || Boolean(pluginActivityStatus());
  const childSessionStatusLine = (): RelayLine | null => {
    const children = directChildThreads(app.state.threads, app.state.activeThreadId);
    if (children.length === 0) return null;
    const counts = new Map<string, number>();
    for (const child of children) {
      const status = childStatusLabel(child);
      counts.set(status, (counts.get(status) ?? 0) + 1);
    }
    const statusColors: Record<string, string> = {
      running: colors.running,
      starting: colors.accent,
      done: colors.success,
      failed: colors.error,
      interrupted: colors.textMuted,
      idle: colors.textMuted,
    };
    const parts: RelayLine[] = [{ text: "children: ", fg: colors.textSubtle }];
    [...counts.entries()].forEach(([status, count], index) => {
      if (index > 0) parts.push({ text: " · ", fg: colors.textSubtle });
      parts.push({ text: `■ ${count} ${status}`, fg: statusColors[status] ?? colors.textMuted });
    });
    parts.push({ text: " · ", fg: colors.textSubtle });
    parts.push({ text: "/children", fg: colors.accent });
    parts.push({ text: " to view", fg: colors.textSubtle });
    return combineRelayLines(parts);
  };
  const subagentStatusLine = (): RelayLine | null => {
    const entries = subagentEntries(app.state.blocks);
    if (entries.length === 0) return null;
    const running = entries.filter((entry) => entry.state.status === "running").length;
    const done = entries.filter((entry) => entry.state.status === "success").length;
    const failed = entries.filter((entry) => entry.state.status === "error").length;
    const cancelled = entries.filter((entry) => entry.state.status === "cancelled").length;
    const parts: RelayLine[] = [{ text: "subagents: ", fg: colors.textSubtle }];
    const statuses = [
      { count: running, label: "running", fg: colors.running },
      { count: done, label: "done", fg: colors.success },
      { count: failed, label: "failed", fg: colors.error },
      { count: cancelled, label: "cancelled", fg: colors.textMuted },
    ].filter((status) => status.count > 0);
    statuses.forEach((status, index) => {
      if (index > 0) parts.push({ text: " · ", fg: colors.textSubtle });
      parts.push({ text: `■ ${status.count} ${status.label}`, fg: status.fg });
    });
    parts.push({ text: " · ", fg: colors.textSubtle });
    parts.push({ text: "/subagents", fg: colors.accent });
    parts.push({ text: " to view", fg: colors.textSubtle });
    return combineRelayLines(parts);
  };
  const statusLabelLine = (): RelayLine => ({
    text: pluginActivityStatus()?.text ?? getStatusLabel(app.state),
    fg: colors.textSubtle,
  });
  const showTurnStatus = () =>
    isSpinning() ||
    app.state.elapsedSeconds > 0 ||
    subagentEntries(app.state.blocks).length > 0 ||
    directChildThreads(app.state.threads, app.state.activeThreadId).length > 0;
  const turnTip = () => (showTips() && showTurnStatus() && app.state.startupTip ? app.state.startupTip : "");
  const hasTurnTip = () => turnTip().length > 0;
  const statusLineHeight = () => 1 + (showTurnStatus() ? 1 : 0) + (hasTurnTip() ? 1 : 0);
  const vimLabel = () => {
    const status = props.vimStatus?.();
    if (!status) return "";
    const mode = VIM_MODE_LABELS[status.mode] ?? "INSERT";
    return status.pending ? `${mode} ${status.pending}` : mode;
  };
  const taskReminderStatusLine = (): RelayLine | null => {
    if (parentThreadForChild(app.state.threads, app.state.activeThreadId)) return null;
    const matches = matchChildSessionTaskTypes(props.composerText?.() ?? "", taskTypes());
    if (matches.length === 0) return null;
    return combineRelayLines([
      { text: "task reminders: ", fg: colors.textSubtle },
      { text: matches.map((match) => match.name).join(", "), fg: colors.textLabel },
    ]);
  };
  const rightContent = () => {
    if (app.state.statusHint) return resolveStatusLineRightContent(app.state.statusHint, []);
    if (app.state.transcriptSelectedBlockId !== null && app.state.transcriptDetailBlockId === null) {
      return resolveStatusLineRightContent({ key: "esc", label: " to focus editor" }, []);
    }
    const taskReminder = taskReminderStatusLine();
    if (taskReminder) return { hint: null, statusLine: taskReminder };
    if (parentThreadForChild(app.state.threads, app.state.activeThreadId)) {
      return resolveStatusLineRightContent({ key: "ctrl+p", label: " back to parent" }, []);
    }
    const children = childSessionStatusLine();
    if (children) return { hint: null, statusLine: children };
    const subagents = subagentStatusLine();
    if (subagents) return { hint: null, statusLine: subagents };
    return resolveStatusLineRightContent(null, props.pluginStatusLineSegments?.() ?? []);
  };
  const showInterruptHint = () => app.state.running && app.state.transcriptSelectedBlockId === null;
  const leftLine = () =>
    combineRelayLines([
      element(
        "editorHeader.statusSpinner",
        {
          text: isSpinning() ? `${props.spinnerChar()} ` : "",
          fg: colors.accent,
        },
        isSpinning(),
      ),
      element("editorHeader.vimMode", {
        text: vimLabel() ? `-- ${vimLabel()} -- ` : "",
        fg: colors.textSubtle,
      }),
      element("editorHeader.statusLabel", statusLabelLine(), isSpinning()),
      element("editorHeader.pluginStatus", {
        text: visiblePluginStatusSegments().length ? ` · ${visiblePluginStatusSegments().join(" · ")}` : "",
        fg: colors.textSubtle,
      }),
      element("editorHeader.interruptHint", {
        text: showInterruptHint() ? " (esc to interrupt)" : "",
        segments: showInterruptHint()
          ? [
              { text: " (", fg: colors.textSubtle },
              { text: "esc", fg: colors.textLabel },
              { text: " to interrupt", fg: colors.textSubtle },
              { text: ")", fg: colors.textSubtle },
            ]
          : [],
      }),
    ]);
  const tipLine = () =>
    combineRelayLines([
      element("editorHeader.tipMarker", { text: "  L ", fg: colors.textMuted }),
      element("editorHeader.tipLabel", { text: "Tip:", fg: colors.textMuted, bold: true }),
      element("editorHeader.tipText", { text: ` ${turnTip()}`, fg: colors.textMuted }),
    ]);
  const clickableLine = (line: RelayLine, event: unknown): void => handleRelayLineMouseAction(line, event, openUrl);

  return (
    <box
      height={statusLineHeight()}
      width="100%"
      paddingLeft={UI_GUTTER_X}
      paddingRight={UI_GUTTER_X}
      flexShrink={0}
      flexDirection="row"
    >
      <box flexGrow={1} flexShrink={1} height={statusLineHeight()} flexDirection="column">
        <Show when={showTurnStatus()}>
          <box height={1} flexShrink={0} />
        </Show>
        <box height={1} flexShrink={0} onMouseDown={(event) => clickableLine(leftLine(), event)}>
          <RelayLineText line={leftLine()} fallbackFg={colors.textSubtle} />
        </box>
        <Show when={hasTurnTip()}>
          <box height={1} flexShrink={0} onMouseDown={(event) => clickableLine(tipLine(), event)}>
            <RelayLineText line={tipLine()} fallbackFg={colors.textMuted} />
          </box>
        </Show>
      </box>
      <StatusLineRightLane
        height={statusLineHeight}
        content={rightContent}
        resolveElement={element}
        onMouseDown={clickableLine}
      />
    </box>
  );
}

function StatusLineRightLane(props: {
  height: () => number;
  content: () => { readonly hint: StatusLineHint | null; readonly statusLine: RelayLine };
  resolveElement: (
    name: Parameters<EditorChromeElementResolver>[0]["element"],
    line: RelayLine,
    active?: boolean,
  ) => RelayLine;
  onMouseDown: (line: RelayLine, event: unknown) => void;
}) {
  const colors = getColors();
  const line = () => {
    const content = props.content();
    if (content.hint) {
      return combineRelayLines([
        props.resolveElement("editorHeader.rightHintKey", { text: content.hint.key, fg: colors.textLabel }, true),
        props.resolveElement("editorHeader.rightHintLabel", { text: content.hint.label, fg: colors.textSubtle }, true),
      ]);
    }
    return props.resolveElement("editorHeader.rightStatus", content.statusLine);
  };
  return (
    <box flexShrink={0} height={props.height()} flexDirection="column">
      <box flexGrow={1} />
      <box height={1} flexShrink={0} onMouseDown={(event) => props.onMouseDown(line(), event)}>
        <RelayLineText line={line()} fallbackFg={colors.textSubtle} />
      </box>
    </box>
  );
}
