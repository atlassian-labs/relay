import { RelayLineText } from "./relay-line-text";
import { joinStatusLineSegments } from "./status-line";
import { useApp } from "../state";
import { thinkingLevelLabel } from "../../core/thinking";
import { blendHexColors } from "../../config/themes";
import { getColors } from "../context/theme";
import { formatPath } from "../util/format";
import { combineRelayLines, type EditorChromeElementResolver } from "../util/editor-chrome";
import { handleRelayLineMouseAction } from "../util/relay-line-click";
import { openUrl } from "../util/links";
import { UI_GUTTER_X } from "../layout";
import type { RelayEditorSegmentContent, RelayLine } from "../../plugins";

function formatCompactNumber(value: number): string {
  const rounded = Math.round(value);
  const sign = rounded < 0 ? "-" : "";
  const absolute = Math.abs(rounded);
  if (absolute >= 1_000_000) return `${sign}${Math.round(absolute / 1_000_000)}m`;
  if (absolute >= 1_000) return `${sign}${Math.round(absolute / 1_000)}k`;
  return rounded.toString();
}

function formatReasoningEffortLabel(label: string): string {
  return label.trim().toLowerCase().split(/\s+/).filter(Boolean).join("-");
}

export function EditorFooter(props: {
  onToggleTokenUsage: () => void;
  pluginFooterSegments?: () => readonly RelayEditorSegmentContent[];
  resolveElement?: EditorChromeElementResolver;
}) {
  const app = useApp();
  const colors = getColors();
  const element = (
    name: Parameters<EditorChromeElementResolver>[0]["element"],
    line: RelayLine,
    active?: boolean,
  ): RelayLine =>
    props.resolveElement?.({ surface: "footer", element: name, line, ...(active === undefined ? {} : { active }) }) ??
    line;

  const branchLabel = () => {
    const branch = app.state.gitBranch;
    return branch ? ` (⎇ ${branch})` : "";
  };
  const cwdColor = () => blendHexColors(colors.accent, colors.bg, 0.1);
  const worktreeLabel = () => {
    if (!app.state.worktreePath) return "";
    const label = app.state.worktreeBranch || formatPath(app.state.worktreePath);
    return ` [wt ${label}]`;
  };
  const reasoningEffortLabel = () => {
    if (!app.state.thinkingLevel) return undefined;
    return (
      app.state.availableThinkingLevels.find((thinkingLevel) => thinkingLevel.id === app.state.thinkingLevel)?.name ??
      thinkingLevelLabel(app.state.thinkingLevel)
    );
  };
  const tokenUsageLabel = () => {
    const usage = app.state.totalUsage;
    const hasUsage =
      usage.input_tokens > 0 || usage.output_tokens > 0 || usage.cache_read_tokens > 0 || usage.cache_write_tokens > 0;
    if (!hasUsage && app.state.contextTokens === null) return "";

    const used = app.state.contextTokens;
    const contextLabel =
      used === null
        ? "context"
        : app.state.contextWindow === null
          ? formatCompactNumber(used)
          : `${formatCompactNumber(used)}/${formatCompactNumber(app.state.contextWindow)}`;
    return `${contextLabel} • ↑${formatCompactNumber(usage.input_tokens)} ↓${formatCompactNumber(
      usage.output_tokens,
    )} R${formatCompactNumber(usage.cache_read_tokens)} W${formatCompactNumber(usage.cache_write_tokens)}`;
  };
  const agentModeColor = () => blendHexColors(colors.badge.label, colors.bg, 0.1);
  const changedPathCount = () => new Set(app.state.fileChanges.map((change) => change.path)).size;
  const pluginFooterLine = (): RelayLine | null => {
    const segments = props.pluginFooterSegments?.() ?? [];
    return segments.length > 0 ? joinStatusLineSegments(segments) : null;
  };

  const row1Left = () =>
    combineRelayLines([
      element("editorFooter.cwd", { text: formatPath(app.state.cwd), fg: cwdColor() }),
      element("editorFooter.branch", { text: branchLabel(), fg: colors.textSubtle }),
      element("editorFooter.worktree", { text: worktreeLabel(), fg: colors.textSubtle }),
    ]);
  const row1Right = () =>
    combineRelayLines([
      element("editorFooter.provider", { text: app.state.providerName, fg: agentModeColor() }, true),
      element(
        "editorFooter.mode",
        {
          text: app.state.modeId ? `${app.state.providerName ? " " : ""}(${app.state.modeId})` : "",
          fg: colors.textSubtle,
        },
        true,
      ),
    ]);
  const fileChangesLine = () => {
    const count = changedPathCount();
    if (count === 0) return { text: "" };
    return combineRelayLines([
      element("editorFooter.fileChanges", {
        text: `${count} file${count === 1 ? "" : "s"} `,
        fg: colors.textSubtle,
      }),
      element("editorFooter.fileAdded", {
        text: `+${app.state.fileChanges.reduce((sum, change) => sum + change.added, 0)}`,
        fg: colors.diffAdded,
      }),
      element("editorFooter.fileRemoved", {
        text: ` -${app.state.fileChanges.reduce((sum, change) => sum + change.removed, 0)}`,
        fg: colors.diffRemoved,
      }),
    ]);
  };
  const row2Left = () => {
    const plugin = pluginFooterLine();
    return combineRelayLines(
      [
        element("editorFooter.tokenUsage", {
          text: tokenUsageLabel(),
          fg: colors.textSubtle,
          onClick: props.onToggleTokenUsage,
        }),
        fileChangesLine(),
        element(
          "editorFooter.pluginStatus",
          plugin ? combineRelayLines([{ text: "• ", fg: colors.textSubtle }, plugin]) : { text: "" },
        ),
      ],
      " ",
    );
  };
  const row2Right = () => {
    const reasoning = reasoningEffortLabel();
    return combineRelayLines([
      element("editorFooter.model", { text: app.state.modelId || "(no model)", fg: colors.textSubtle }, true),
      element(
        "editorFooter.reasoning",
        {
          text: reasoning ? ` • ${formatReasoningEffortLabel(reasoning)}` : "",
          fg: colors.textSubtle,
        },
        true,
      ),
    ]);
  };
  const clickableLine = (line: RelayLine, event: unknown): void => handleRelayLineMouseAction(line, event, openUrl);

  return (
    <box height={2} width="100%" flexDirection="column" flexShrink={0}>
      <box
        height={1}
        width="100%"
        paddingLeft={UI_GUTTER_X}
        paddingRight={UI_GUTTER_X}
        flexDirection="row"
        justifyContent="space-between"
        gap={1}
      >
        <box flexShrink={1} onMouseDown={(event) => clickableLine(row1Left(), event)}>
          <RelayLineText line={row1Left()} fallbackFg={colors.textSubtle} />
        </box>
        <box flexShrink={0} onMouseDown={(event) => clickableLine(row1Right(), event)}>
          <RelayLineText line={row1Right()} fallbackFg={colors.textSubtle} />
        </box>
      </box>
      <box
        height={1}
        width="100%"
        paddingLeft={UI_GUTTER_X}
        paddingRight={UI_GUTTER_X}
        flexDirection="row"
        justifyContent="space-between"
        gap={1}
      >
        <box flexShrink={1} onMouseDown={(event) => clickableLine(row2Left(), event)}>
          <RelayLineText line={row2Left()} fallbackFg={colors.textSubtle} />
        </box>
        <box flexShrink={0} onMouseDown={(event) => clickableLine(row2Right(), event)}>
          <RelayLineText line={row2Right()} fallbackFg={colors.textSubtle} />
        </box>
      </box>
    </box>
  );
}
