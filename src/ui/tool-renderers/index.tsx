import { For, Show } from "solid-js";
import type { JSX } from "solid-js";
import {
  normalizeRelayLines,
  type PluginRunner,
  type RelayLine,
  type RelayRenderable,
  type RelayToolDisplayContext,
  type RelayToolDisplayPolicy,
  type RelayToolRendererContext,
  type RelayToolRendererOutput,
} from "../../plugins";
import type { ToolBlock, ToolContentItem, ToolDiff } from "../state";
import { RelayLineText } from "../component/relay-line-text";
import { altaProfile, renderAltaToolBlock } from "./agents/alta";
import { claudeProfile, renderClaudeToolBlock } from "./agents/claude";
import { codexProfile, renderCodexToolBlock } from "./agents/codex";
import { defaultProfile, renderDefaultToolBlock, renderExpandedDefaultBody } from "./agents/default";
import { renderRovodevToolBlock, rovodevProfile } from "./agents/rovodev";
import {
  buildPatch,
  changeBadge,
  countPatchChanges,
  formatPathForDisplay,
  renderDiffResult,
  renderHeader,
  renderReadLikeHeader,
  renderTextResultLines,
} from "./core";
import type { AgentProfile, ToolRenderContext, ToolRendererOutput, ToolRenderProfile } from "./types";

const PROFILES: Record<string, ToolRenderProfile> = {
  default: defaultProfile,
  alta: altaProfile,
  rovodev: rovodevProfile,
  codex: codexProfile,
  claude: claudeProfile,
};

const RENDERERS: Record<string, (ctx: ToolRenderContext) => ToolRendererOutput> = {
  default: renderDefaultToolBlock,
  alta: renderAltaToolBlock,
  rovodev: renderRovodevToolBlock,
  codex: renderCodexToolBlock,
  claude: renderClaudeToolBlock,
};

export type {
  AgentProfile,
  ToolRenderContext,
  ToolRenderHelpers,
  ToolRendererOutput,
  ToolRenderer,
  ToolRenderProfile,
} from "./types";

export function resolveAgentProfile(profile?: string): AgentProfile {
  const normalized = (profile ?? "").trim().toLowerCase();
  if (!normalized) return "default";
  return PROFILES[normalized] ? normalized : "default";
}

function getProfile(agent: AgentProfile): ToolRenderProfile {
  return PROFILES[resolveAgentProfile(agent)] ?? defaultProfile;
}

export function getToolIcon(agent: AgentProfile, toolName: string): string {
  return getProfile(agent).icons[toolName] ?? "→";
}

export function toolResultCanExpand(block: ToolBlock, agent: AgentProfile, previewLines: number): boolean {
  const text = block.details?.trim() ?? "";
  if (!text) return false;
  if (getProfile(agent).isNonTruncatableTool(block.toolName)) return false;
  return text.trimEnd().split("\n").length > Math.max(0, previewLines);
}

function protocolDiffItems(block: ToolBlock): ToolContentItem[] {
  if (block.content?.some((item) => item.type === "diff")) return block.content;
  return block.diff ? [{ type: "diff", diff: block.diff }] : [];
}

function patchFromDiff(diff: ToolDiff): string {
  return buildPatch(formatPathForDisplay(diff.path, ""), diff.oldText, diff.newText);
}

function protocolContentItemText(item: ToolContentItem): string {
  switch (item.type) {
    case "text":
      return item.text;
    case "image":
      return `Image (${item.mimeType})`;
    case "audio":
      return `Audio (${item.mimeType})`;
    case "resourceLink":
      return item.uri;
    case "resource":
      return item.text ?? item.uri;
    case "terminal":
      return `Terminal: ${item.terminalId}`;
    case "diff":
      return "";
  }
}

function countProtocolDiffChanges(items: ToolContentItem[]): { added: number; removed: number } {
  return items.reduce(
    (total, item) => {
      if (item.type !== "diff") return total;
      const counts = countPatchChanges(patchFromDiff(item.diff));
      return { added: total.added + counts.added, removed: total.removed + counts.removed };
    },
    { added: 0, removed: 0 },
  );
}

function renderProtocolContentItem(ctx: ToolRenderContext, item: ToolContentItem, index: () => number): JSX.Element {
  return (
    <Show
      when={item.type === "diff" ? item.diff : undefined}
      keyed
      fallback={
        <box paddingLeft={2} flexDirection="column">
          {renderTextResultLines(protocolContentItemText(item).split("\n"), ctx.colors, ctx.helpers)}
        </box>
      }
    >
      {(diff) => (
        <box flexDirection="column" marginTop={index() === 0 ? 0 : 1}>
          <text fg={ctx.colors.textLabel}>{formatPathForDisplay(diff.path, ctx.cwd)}</text>
          {renderDiffResult(patchFromDiff(diff), ctx.colors, ctx.helpers)}
        </box>
      )}
    </Show>
  );
}

function renderProtocolToolContent(ctx: ToolRenderContext, items: ToolContentItem[]): JSX.Element {
  return (
    <box flexDirection="column">
      <For each={items}>{(item, index) => renderProtocolContentItem(ctx, item, index)}</For>
    </box>
  );
}

function renderProtocolDiffToolBlock(ctx: ToolRenderContext): ToolRendererOutput | undefined {
  const items = protocolDiffItems(ctx.block);
  if (!items.some((item) => item.type === "diff")) return undefined;

  const firstDiff = items.find(
    (item): item is Extract<ToolContentItem, { type: "diff" }> => item.type === "diff",
  )?.diff;
  const diffCount = items.filter((item) => item.type === "diff").length;
  const counts = countProtocolDiffChanges(items);
  const extras = diffCount > 1 ? [`${diffCount} files`] : [];
  const badges = changeBadge(counts.added, counts.removed, ctx.colors) ?? undefined;

  return {
    header: renderReadLikeHeader(
      ctx,
      ctx.helpers.getToolIcon(ctx.block.toolName),
      ctx.block.toolName,
      firstDiff?.path ?? "",
      extras,
      badges,
    ),
    result: renderProtocolToolContent(ctx, items),
    canToggle: false,
    hiddenLineCount: 0,
  };
}

function pluginToolDisplayContext(block: ToolBlock): RelayToolDisplayContext {
  return {
    toolName: block.toolName,
    toolCallId: block.toolCallId,
    status: block.status,
    input: block.rawInput,
    output: block.rawOutput,
  };
}

function withToolPolicyContext(ctx: ToolRenderContext, policy: RelayToolDisplayPolicy | undefined): ToolRenderContext {
  if (policy?.previewLines === undefined) return ctx;
  return { ...ctx, previewLines: Math.max(0, policy.previewLines) };
}

function relayLineFromTitle(title: string | RelayLine): RelayLine {
  return typeof title === "string" ? { text: title, bold: true } : title;
}

function renderRelayRenderable(renderable: RelayRenderable, fallbackFg: string, borderColor: string): JSX.Element {
  if (renderable.kind === "lines") {
    return (
      <box width="100%" flexDirection="column">
        <For each={normalizeRelayLines(renderable.lines)}>
          {(line) => <RelayLineText line={line} fallbackFg={fallbackFg} />}
        </For>
      </box>
    );
  }

  const title = renderable.title ? relayLineFromTitle(renderable.title) : null;
  return (
    <box
      width="100%"
      flexDirection="column"
      borderStyle={renderable.border ?? "single"}
      border={["top", "bottom", "left", "right"] as never}
      borderColor={borderColor}
      paddingLeft={1}
      paddingRight={1}
    >
      <Show when={title}>{(line) => <RelayLineText line={line()} fallbackFg={fallbackFg} />}</Show>
      <For each={normalizeRelayLines(renderable.lines)}>
        {(line) => <RelayLineText line={line} fallbackFg={fallbackFg} />}
      </For>
    </box>
  );
}

function pluginToolRendererContext(
  ctx: ToolRenderContext,
  pluginRunner: PluginRunner | null | undefined,
): RelayToolRendererContext {
  return {
    ...pluginToolDisplayContext(ctx.block),
    blockId: ctx.block.id,
    threadId: ctx.threadId ?? null,
    sessionId: ctx.sessionId ?? null,
    display: ctx.block.display,
    details: ctx.block.details,
    cwd: ctx.cwd,
    isPartial: ctx.block.status === "pending" || ctx.block.status === "running",
    expanded: ctx.expanded,
    colors: ctx.colors,
    invalidate: () => pluginRunner?.invalidate(),
  };
}

function renderPluginToolOutput(ctx: ToolRenderContext, output: RelayToolRendererOutput): ToolRendererOutput {
  const header = output.call
    ? renderRelayRenderable(output.call, ctx.colors.fg, ctx.colors.border)
    : renderHeader(ctx, ctx.helpers.getToolIcon(ctx.block.toolName), ctx.block.display || ctx.block.toolName);
  const result = output.result ? (
    <box width="100%" paddingLeft={2} flexDirection="column">
      {renderRelayRenderable(output.result, ctx.colors.textSubtle, ctx.colors.border)}
    </box>
  ) : undefined;
  return {
    header,
    result,
    canToggle: output.canToggle,
    hiddenLineCount: 0,
  };
}

function renderPluginToolBlock(
  ctx: ToolRenderContext,
  pluginRunner: PluginRunner | null | undefined,
): ToolRendererOutput | undefined {
  const rendered = pluginRunner?.renderers.render(pluginToolRendererContext(ctx, pluginRunner));
  return rendered ? renderPluginToolOutput(ctx, rendered) : undefined;
}

function applyToolDisplayPolicy(
  ctx: ToolRenderContext,
  output: ToolRendererOutput,
  policy: RelayToolDisplayPolicy | undefined,
): ToolRendererOutput {
  const policyOutput = (() => {
    if (!policy) return output;
    const displayCtx = pluginToolDisplayContext(ctx.block);
    const headerText =
      typeof policy.header === "function"
        ? policy.header(displayCtx)
        : typeof policy.header === "string"
          ? policy.header
          : undefined;
    const hasDiff = Boolean(ctx.block.diff || ctx.block.content?.some((item) => item.type === "diff"));
    const policyHidesResult = policy.showResultBody === false || (policy.showDiff === false && hasDiff);
    const collapsed =
      policy.collapsedByDefault === true && !ctx.expanded && !policyHidesResult && Boolean(output.result);
    return {
      ...output,
      header: headerText ? renderHeader(ctx, ctx.helpers.getToolIcon(ctx.block.toolName), headerText) : output.header,
      result: policyHidesResult || collapsed ? undefined : output.result,
      canToggle: policy.canToggle ?? (collapsed ? true : output.canToggle),
      collapsed,
    };
  })();

  if (!ctx.expanded) {
    // With previews off, a hidden result reads as collapsed so selected rows still hint "enter to expand".
    const hiddenByOff = ctx.previewLines <= 0 && policyOutput.canToggle && !policyOutput.result;
    return hiddenByOff ? { ...policyOutput, collapsed: true } : policyOutput;
  }
  return {
    ...policyOutput,
    result: renderExpandedDefaultBody(ctx),
    canToggle: true,
    collapsed: false,
    hiddenLineCount: 0,
  };
}

export function renderToolBlock(
  ctx: ToolRenderContext,
  agent: AgentProfile,
  pluginRunner?: PluginRunner | null,
): ToolRendererOutput {
  const policy = pluginRunner?.renderers.policyFor(ctx.block.toolName);
  const policyCtx = withToolPolicyContext(ctx, policy);
  const pluginOutput = renderPluginToolBlock(policyCtx, pluginRunner);
  if (pluginOutput) return applyToolDisplayPolicy(policyCtx, pluginOutput, policy);
  const resolvedAgent = resolveAgentProfile(agent);
  if (resolvedAgent !== "default") {
    const profile = getProfile(resolvedAgent);
    const profileRenderer = profile.renderers[ctx.block.toolName];
    if (profileRenderer) {
      const profileOutput = profileRenderer(policyCtx);
      if (profileOutput) return applyToolDisplayPolicy(policyCtx, profileOutput, policy);
    }
  }
  const renderer = RENDERERS[resolvedAgent] ?? renderDefaultToolBlock;
  if (resolvedAgent === "codex" || resolvedAgent === "claude") {
    return applyToolDisplayPolicy(policyCtx, renderer(policyCtx), policy);
  }
  const protocolDiff = renderProtocolDiffToolBlock(policyCtx);
  if (protocolDiff) return applyToolDisplayPolicy(policyCtx, protocolDiff, policy);
  return applyToolDisplayPolicy(policyCtx, renderer(policyCtx), policy);
}
