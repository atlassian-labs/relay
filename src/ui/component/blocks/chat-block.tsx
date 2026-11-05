import { batch, createMemo, createSignal, For, Show, type JSX } from "solid-js";
import { createTextAttributes, type BaseRenderable, type BoxRenderable, type MouseEvent } from "@opentui/core";
import { getConfig } from "../../../config";
import { parseLiveSessionMessage } from "../../../core/live-sessions";
import { blendHexColors } from "../../../config/themes";
import { userMessageBackgroundColor } from "../../util/user-message-style";
import type { PluginRunner, RelayLine, RelayMessageRendererOutput } from "../../../plugins";
import { userBashHeader } from "../../util/user-bash-block";
import { userBlockSkillInvocation } from "../../util/user-message";
import { SPINNER_FRAMES } from "../../util/spinner-frames";
import { promptImageMarkerSegments } from "../../prompt-images";
import {
  type ChatBlock,
  type ElicitationBlock,
  type InfoBlock,
  type ToolBlock,
  useApp,
  type UserBashBlock,
} from "../../state";
import { type AgentProfile, getToolIcon as getProfileToolIcon, renderToolBlock } from "../../tool-renderers";
import { renderToggleHint } from "../../tool-renderers/core";
import { getColors, getSyntaxStyle, getThinkingSyntaxStyle } from "../../context/theme";
import { UI_GUTTER_X } from "../../layout";
import { stripEmoji, truncateTextEnd } from "../../util/format";
import { getLinkUrlAtScreenPosition, openUrl, shouldRenderLinkedPlainText, splitBareUrls } from "../../util/links";
import { formatToolName } from "../../util/tool-icons";
import { renderMermaidMarkdown } from "../../util/mermaid";
import { TOAST_ERROR_SYMBOL, TOAST_INFO_SYMBOL, TOAST_WARNING_SYMBOL, useToast } from "../../ui/toast";
import { TRANSCRIPT_NAV_BLOCK_ID_PREFIX, USER_BLOCK_ID_PREFIX } from "../../util/sticky-prompt";
import { handleRelayLineMouseAction } from "../../util/relay-line-click";
import { copyToClipboard } from "../../util/clipboard";
import { systemReminderUserContent } from "../../util/system-reminder";

const ACTIVE_BLOCK_LEFT_BORDER_CHARS = {
  topLeft: "▏",
  topRight: "▏",
  bottomLeft: "▏",
  bottomRight: "▏",
  horizontal: "▏",
  vertical: "▏",
  topT: "▏",
  bottomT: "▏",
  leftT: "▏",
  rightT: "▏",
  cross: "▏",
};

const ACTIVE_BLOCK_RIGHT_BORDER_CHARS = {
  topLeft: "▕",
  topRight: "▕",
  bottomLeft: "▕",
  bottomRight: "▕",
  horizontal: "▕",
  vertical: "▕",
  topT: "▕",
  bottomT: "▕",
  leftT: "▕",
  rightT: "▕",
  cross: "▕",
};

const INDEXED_TRANSCRIPT_BLOCK_ID_PREFIX = "transcript-block:";
const compactFrameByLayoutNode = new WeakMap<BaseRenderable, boolean>();
const compactFrameByBlock = new WeakMap<object, boolean>();
const TRANSCRIPT_DOUBLE_CLICK_WINDOW_MS = 400;
let lastTranscriptClick: { target: object; at: number; x: number; y: number } | null = null;

function transcriptLayoutNode(frame: BoxRenderable): BaseRenderable {
  const parent = frame.parent;
  return parent?.id.startsWith(INDEXED_TRANSCRIPT_BLOCK_ID_PREFIX) ? parent : frame;
}

// Every frame looks up its previous sibling on each lifecycle pass, and getChildren() copies the list,
// which made each pass O(n^2). Share one index per parent within a rendered frame (ctx.frameId), and
// release it after the pass so removed children are not retained.
type SiblingIndex = Map<BaseRenderable, BaseRenderable | undefined>;
let siblingIndexFrame: { frameId: number; byParent: Map<BaseRenderable, SiblingIndex> } | null = null;

function previousSibling(frame: BoxRenderable, node: BaseRenderable): BaseRenderable | undefined {
  const parent = node.parent;
  if (!parent) return undefined;
  if (siblingIndexFrame?.frameId !== frame.ctx.frameId) {
    siblingIndexFrame = { frameId: frame.ctx.frameId, byParent: new Map() };
    queueMicrotask(() => (siblingIndexFrame = null));
  }
  let previous = siblingIndexFrame.byParent.get(parent);
  if (!previous?.has(node)) {
    const children = parent.getChildren();
    previous = new Map(children.map((child, i) => [child, children[i - 1]]));
    siblingIndexFrame.byParent.set(parent, previous);
  }
  return previous.get(node);
}

export interface ChatBlockViewProps {
  block: ChatBlock;
  prevBlock?: ChatBlock;
  activeProfile: AgentProfile;
  hideThinking: () => boolean;
  approvalOptionIndex: () => number;
  elicitationOptionIndex: () => number;
  getSpinnerChar: () => string;
  pluginRunner?: () => PluginRunner | null;
  pluginRevision?: () => number;
  configRevision?: () => number;
  renderer?: unknown;
  selectThread?: (threadId: string) => void;
  onTranscriptSelect?: () => void;
  selectElicitationChoice: (app: ReturnType<typeof useApp>, block: ElicitationBlock) => void;
}

function getToolIcon(activeProfile: AgentProfile, toolName: string): string {
  return getProfileToolIcon(activeProfile, toolName);
}

export function TranscriptFrame(frameProps: {
  block: ChatBlock;
  prevBlock?: ChatBlock;
  blockId: string;
  compact: () => boolean;
  onSelect?: () => void;
  onActivate?: () => void;
  activateWhenNavigationDisabled?: boolean;
  children: JSX.Element;
}) {
  const app = useApp();
  const colors = getColors();
  const transcriptNavigationEnabled = () => app.state.selectedSubagentToolCallId === null;
  const selected = () => transcriptNavigationEnabled() && app.state.transcriptSelectedRows[frameProps.blockId] === true;
  const clickTarget = {};
  let mouseDragged = false;
  const select = (evt: MouseEvent): void => {
    if (!transcriptNavigationEnabled()) {
      if (frameProps.activateWhenNavigationDisabled) evt?.stopPropagation?.();
      return;
    }
    if (typeof evt?.button === "number" && evt.button !== 0) return;
    evt?.stopPropagation?.();
    frameProps.onSelect?.();
    const previous = app.state.transcriptSelectedBlockId;
    if (previous === frameProps.blockId) return;
    batch(() => {
      if (previous) app.setState("transcriptSelectedRows", previous, false);
      app.setState("transcriptSelectedRows", frameProps.blockId, true);
      app.setState("transcriptSelectedBlockId", frameProps.blockId);
    });
  };
  const handleMouseUp = (evt: MouseEvent): void => {
    if (!transcriptNavigationEnabled() && !frameProps.activateWhenNavigationDisabled) return;
    evt.stopPropagation();
    if (evt.button !== 0 || evt.modifiers.shift || evt.modifiers.alt || evt.modifiers.ctrl || mouseDragged) {
      lastTranscriptClick = null;
      mouseDragged = false;
      return;
    }

    const now = Date.now();
    const previous = lastTranscriptClick;
    const doubleClick =
      previous?.target === clickTarget &&
      now - previous.at <= TRANSCRIPT_DOUBLE_CLICK_WINDOW_MS &&
      Math.abs(previous.x - evt.x) <= 1 &&
      Math.abs(previous.y - evt.y) <= 1;
    lastTranscriptClick = doubleClick ? null : { target: clickTarget, at: now, x: evt.x, y: evt.y };
    mouseDragged = false;
    if (doubleClick) frameProps.onActivate?.();
  };
  const selectedBackgroundColor = () => {
    if (!selected() || (frameProps.block.type !== "thinking" && frameProps.block.type !== "tool")) return undefined;
    return blendHexColors(colors.bg, colors.fg, 0.05);
  };

  return (
    <box
      ref={(frame: BoxRenderable) => {
        frame.onLifecyclePass = () => {
          const layoutNode = transcriptLayoutNode(frame);
          const compact = frameProps.compact();
          compactFrameByLayoutNode.set(layoutNode, compact);
          compactFrameByBlock.set(frameProps.block, compact);

          const sibling = previousSibling(frame, layoutNode);
          const siblingCompact = sibling ? compactFrameByLayoutNode.get(sibling) : undefined;
          const previousCompact =
            siblingCompact ??
            (frameProps.prevBlock ? compactFrameByBlock.get(frameProps.prevBlock) : undefined) ??
            false;
          const marginTop = frameProps.prevBlock && !(compact && previousCompact) ? 1 : 0;
          if (frame.marginTop !== marginTop) frame.marginTop = marginTop;
        };
      }}
      id={
        transcriptNavigationEnabled() || frameProps.activateWhenNavigationDisabled
          ? `${TRANSCRIPT_NAV_BLOCK_ID_PREFIX}${frameProps.blockId}`
          : undefined
      }
      width="100%"
      flexDirection="column"
      flexShrink={0}
      backgroundColor={selectedBackgroundColor()}
      onMouseDown={(evt) => {
        mouseDragged = false;
        select(evt);
      }}
      onMouseDrag={() => {
        mouseDragged = true;
        lastTranscriptClick = null;
      }}
      onMouseUp={handleMouseUp}
    >
      {frameProps.children}
      <Show when={selected()}>
        <>
          <box
            position="absolute"
            top={0}
            bottom={0}
            left={0}
            width={1}
            customBorderChars={ACTIVE_BLOCK_LEFT_BORDER_CHARS}
            border={["left"] as never}
            borderColor={colors.border}
          />
          <box
            position="absolute"
            top={0}
            bottom={0}
            right={0}
            width={1}
            customBorderChars={ACTIVE_BLOCK_RIGHT_BORDER_CHARS}
            border={["right"] as never}
            borderColor={colors.border}
          />
        </>
      </Show>
    </box>
  );
}

function renderMarkup(markup: string, defaultFg?: string): any[] {
  const colors = getColors();
  const parts: any[] = [];
  const regex = /(?<!\\)\[([^\]]+)\](.*?)(?<!\\)\[\/(?:[^\]]*)\]/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  const styleMap: Record<string, string> = {
    dim: colors.textSubtle,
    red: colors.diffRemoved,
    green: colors.diffAdded,
  };
  const unescape = (value: string) => value.replace(/\\\[/g, "[");
  while ((match = regex.exec(markup)) !== null) {
    if (match.index > lastIndex) {
      const before = unescape(markup.slice(lastIndex, match.index));
      if (before)
        parts.push(defaultFg ? <span style={{ fg: defaultFg } as any}>{before}</span> : <span>{before}</span>);
    }
    const fg = styleMap[match[1]] ?? match[1];
    parts.push(<span style={{ fg } as any}>{unescape(match[2])}</span>);
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < markup.length) {
    const remaining = unescape(markup.slice(lastIndex));
    if (remaining)
      parts.push(defaultFg ? <span style={{ fg: defaultFg } as any}>{remaining}</span> : <span>{remaining}</span>);
  }
  return parts;
}

function hasMarkup(text: string): boolean {
  return /(?<!\\)\[[^\]]+\]/.test(text);
}

/**
 * Terminal command-click reads native hyperlink metadata, so plain URLs use
 * OpenTUI link spans instead of relying on terminal text detection at wraps.
 */
function LinkedPlainText(props: { content: string; fg: string }) {
  const parts = createMemo(() => splitBareUrls(props.content));
  return (
    <text fg={props.fg}>
      <For each={parts()}>
        {(part) => (part.type === "url" ? <a href={part.url}>{part.text}</a> : <span>{part.text}</span>)}
      </For>
    </text>
  );
}

function relayLineFromHeader(header: string | RelayLine): RelayLine {
  return typeof header === "string" ? { text: header } : header;
}

const USER_MESSAGE_PREVIEW_LINES = 10;
const SYSTEM_REMINDER_PREVIEW_LINES = 0;

type UserMessageMouseEvent = {
  readonly type?: string;
  readonly button: number;
  readonly x: number;
  readonly y: number;
  readonly isDragging?: boolean;
  readonly modifiers?: {
    readonly shift?: boolean;
    readonly alt?: boolean;
    readonly ctrl?: boolean;
  };
};

const THINKING_DOT_FRAMES = [".", "..", "..."];

function getThinkingDots(spinnerChar: string): string {
  const frameIndex = SPINNER_FRAMES.indexOf(spinnerChar as (typeof SPINNER_FRAMES)[number]);
  if (frameIndex < 0) return THINKING_DOT_FRAMES[0];
  return THINKING_DOT_FRAMES[Math.floor((frameIndex * THINKING_DOT_FRAMES.length) / SPINNER_FRAMES.length)];
}

function formatCollapsedThinking(content: string, previewLineCount: number): string {
  if (previewLineCount <= 0) return content;
  const lines = content.trim().split("\n");
  const previewLines = lines.slice(0, previewLineCount);
  const hiddenLineCount = Math.max(0, lines.length - previewLines.length);
  const preview = previewLines.join("\n").trim();
  return hiddenLineCount > 0 ? `${preview} ... (${hiddenLineCount} more lines)` : preview;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function ChatBlockView(props: ChatBlockViewProps) {
  const app = useApp();
  const colors = getColors();
  const toast = useToast();
  const [assistantContentWidth, setAssistantContentWidth] = createSignal(0);
  let assistantContentBox: BoxRenderable | undefined;
  const updateAssistantContentWidth = () => {
    setAssistantContentWidth(Math.max(0, (assistantContentBox?.width ?? 0) - 2));
  };
  const assistantMarkdownContent = () => {
    const block = props.block;
    if (block.type !== "content") return "";
    return renderMermaidMarkdown(block.content, {
      availableWidth: assistantContentWidth(),
      finalized: block.finalized,
      mode: getConfig().ui.mermaid_rendering,
    });
  };
  const activeProfile = () => props.activeProfile;
  const activeThreadSessionId = () =>
    app.state.threads.find((thread) => thread.id === app.state.activeThreadId)?.sessionId ?? null;
  // Tool details are available through the selected-block detail modal; there is
  // intentionally no global expansion state for the transcript.
  const transcriptBlockExpanded = (_blockId: string): boolean => false;
  const relayLineHasAction = (line: RelayLine): boolean =>
    Boolean(
      line.onClick ||
      line.href ||
      line.ctrlHref ||
      line.segments?.some((segment) => segment.onClick || segment.href || segment.ctrlHref),
    );
  const renderRelayLine = (line: RelayLine) => {
    const text = (
      <text
        fg={line.fg ?? colors.fg}
        bg={line.bg}
        attributes={createTextAttributes({
          bold: line.bold === true,
          underline: line.underline === true,
          strikethrough: line.strikethrough === true,
        })}
      >
        <Show when={line.segments} fallback={line.text}>
          {(segments) => (
            <For each={segments()}>
              {(segment) => (
                <span
                  style={
                    {
                      fg: segment.fg ?? line.fg ?? colors.fg,
                      bg: segment.bg ?? line.bg,
                      bold: segment.bold === true || line.bold === true,
                      underline: segment.underline === true || line.underline === true,
                      strikethrough: segment.strikethrough === true || line.strikethrough === true,
                    } as any
                  }
                >
                  {segment.text}
                </span>
              )}
            </For>
          )}
        </Show>
      </text>
    );
    if (!relayLineHasAction(line)) return text;
    return (
      <box height={1} onMouseDown={(event) => handleRelayLineMouseAction(line, event, openUrl)}>
        {text}
      </box>
    );
  };
  const renderPluginMessage = (
    output: RelayMessageRendererOutput,
    options?: Partial<{
      id: string;
    }>,
  ) => {
    const header = output.header ? relayLineFromHeader(output.header) : null;
    return (
      <box
        id={options?.id}
        width="100%"
        backgroundColor={output.backgroundColor}
        paddingLeft={output.paddingLeft ?? UI_GUTTER_X}
        paddingRight={output.paddingRight ?? UI_GUTTER_X}
        paddingTop={output.paddingTop ?? 0}
        paddingBottom={output.paddingBottom ?? 0}
        flexDirection="column"
        onMouseDown={
          output.onClick
            ? (event: { stopPropagation?: () => void }) => {
                event.stopPropagation?.();
                void Promise.resolve(output.onClick?.()).catch(() => undefined);
              }
            : undefined
        }
      >
        <Show when={header}>{(line) => renderRelayLine(line())}</Show>
        <For each={output.lines ?? []}>{(line) => renderRelayLine(line)}</For>
      </box>
    );
  };
  const hasPluginMessageRenderer = (blockType: string) => {
    props.pluginRevision?.();
    return props.pluginRunner?.()?.renderers.hasMessageRenderer(blockType) ?? false;
  };
  const pluginMessageFor = (
    blockType: string,
    content: string,
    options: {
      readonly delivery?: string;
      readonly blockId?: string;
      readonly data?: unknown;
    } = {},
  ) => {
    const runner = props.pluginRunner?.();
    if (!runner?.renderers.hasMessageRenderer(blockType)) return null;
    return runner.renderers.renderMessage({
      blockType,
      content,
      ...(options.blockId ? { blockId: options.blockId } : {}),
      ...(options.data !== undefined ? { data: options.data } : {}),
      ...(options.delivery ? { delivery: options.delivery } : {}),
      threadId: app.state.activeThreadId || null,
      sessionId: activeThreadSessionId(),
      cwd: app.state.cwd,
      colors,
      previousBlockType: props.prevBlock?.type,
      startsAgentTurn: props.prevBlock?.type === "user",
    });
  };
  const renderUserMessageLine = (line: string) => {
    const segments = promptImageMarkerSegments(line);
    const hasImageSegment = segments.some((segment) => segment.type === "image");
    return !hasImageSegment ? (
      <text fg={colors.fg}>{line}</text>
    ) : (
      <text fg={colors.fg}>
        <For each={segments}>
          {(segment) =>
            segment.type === "image" ? (
              <span style={{ fg: colors.bg, bg: colors.notice, bold: true } as any}>{segment.text}</span>
            ) : (
              <span>{segment.text}</span>
            )
          }
        </For>
      </text>
    );
  };
  const renderUserMessageLines = (lines: string[]) => {
    const canToggle = lines.length > USER_MESSAGE_PREVIEW_LINES;
    const hiddenLineCount = Math.max(0, lines.length - USER_MESSAGE_PREVIEW_LINES);
    const visibleLines = () => lines.slice(0, USER_MESSAGE_PREVIEW_LINES);

    return (
      <>
        <For each={visibleLines()}>{(line) => renderUserMessageLine(line)}</For>
        <Show when={canToggle}>
          {renderToggleHint(colors, `... (${hiddenLineCount} lines hidden)`, { prefix: "" })}
        </Show>
      </>
    );
  };
  const renderUserMessageContent = (content: string) => renderUserMessageLines(content.split("\n"));
  const renderSystemReminderLines = (lines: string[]) => {
    const hiddenLineCount = Math.max(0, lines.length - SYSTEM_REMINDER_PREVIEW_LINES);
    const visibleLines = () => lines.slice(0, SYSTEM_REMINDER_PREVIEW_LINES);

    return (
      <>
        <For each={visibleLines()}>{(line) => <text fg={colors.fg}>{line}</text>}</For>
        <Show when={hiddenLineCount > 0}>
          {renderToggleHint(colors, `... (${hiddenLineCount} lines hidden)`, { prefix: "" })}
        </Show>
      </>
    );
  };
  const renderSystemReminderBlock = (content: string, options: { id?: string } = {}) => {
    const lines = content.split("\n");
    const backgroundColor = blendHexColors(colors.panelUser, colors.bg, 0.2);
    return (
      <box
        id={options.id}
        width="100%"
        backgroundColor={backgroundColor}
        paddingLeft={UI_GUTTER_X}
        paddingRight={UI_GUTTER_X}
        paddingTop={1}
        paddingBottom={1}
        flexDirection="column"
      >
        <text fg={colors.badge.label} attributes={createTextAttributes({ bold: true })}>
          [system-reminder]
        </text>
        <box marginTop={1} flexDirection="column">
          {renderSystemReminderLines(lines)}
        </box>
      </box>
    );
  };
  const UserMessageFrame = (frameProps: { id?: string; copyText?: string; children: JSX.Element }) => {
    const [hovered, setHovered] = createSignal(false);
    let mouseDragged = false;

    const backgroundColor = () => (hovered() ? colors.panelUser : userMessageBackgroundColor(colors));
    const copyFrameText = (event: UserMessageMouseEvent) => {
      const copyText = frameProps.copyText;
      if (!copyText) return;
      if (event.button !== 0) return;
      if (event.modifiers?.shift || event.modifiers?.alt || event.modifiers?.ctrl) return;
      if (event.isDragging || mouseDragged) return;
      copyToClipboard(copyText);
      toast.show("Copied to clipboard");
    };

    return (
      <box
        id={frameProps.id}
        width="100%"
        backgroundColor={backgroundColor()}
        paddingLeft={UI_GUTTER_X}
        paddingRight={UI_GUTTER_X}
        paddingTop={1}
        paddingBottom={1}
        flexShrink={0}
        flexDirection="column"
        onMouseOver={() => setHovered(true)}
        onMouseOut={() => setHovered(false)}
        onMouseDown={() => {
          mouseDragged = false;
        }}
        onMouseDrag={() => {
          mouseDragged = true;
        }}
        onMouseUp={(event: UserMessageMouseEvent) => {
          copyFrameText(event);
          mouseDragged = false;
        }}
      >
        {frameProps.children}
      </box>
    );
  };
  const toolHiddenForApproval = createMemo(() => {
    const block = props.block;
    return block.type === "tool" && block.status === "approval";
  });
  const currentToolOutput = createMemo(() => {
    const block = props.block;
    if (block.type !== "tool" || block.status === "approval") return null;
    props.pluginRevision?.();
    props.configRevision?.();
    return renderToolBlock(
      {
        block,
        colors,
        helpers: {
          formatToolName,
          getToolIcon: (toolName: string) => getToolIcon(activeProfile(), toolName),
          getSyntaxStyle,
          hasMarkup,
          renderMarkup,
        },
        expanded: transcriptBlockExpanded(block.id),
        selected: app.state.transcriptSelectedRows[block.id] === true,
        previewLines: getConfig().ui.tool_result_preview_lines,
        cwd: app.state.cwd,
        threadId: app.state.activeThreadId,
        sessionId: activeThreadSessionId(),
      },
      activeProfile(),
      props.pluginRunner?.() ?? null,
    );
  });
  const currentBlockCompact = () => props.block.type === "tool" && !currentToolOutput()?.result;
  const renderBlock = () => {
    const block = props.block;
    if (!block) return null;

    switch (block.type) {
      case "user": {
        const pluginRendered = pluginMessageFor(block.type, block.content, {
          delivery: block.delivery,
          blockId: block.id,
        });
        const userBlockId = `${USER_BLOCK_ID_PREFIX}${block.id}`;
        if (pluginRendered) return renderPluginMessage(pluginRendered, { id: userBlockId });
        const sessionMessage = parseLiveSessionMessage(block.content);
        if (sessionMessage) {
          const sessionLabel = `[${sessionMessage.relation}: ${sessionMessage.name}]`;
          const label = block.delivery === "current-turn-guidance" ? `[turn update] ${sessionLabel}` : sessionLabel;
          return (
            <UserMessageFrame id={userBlockId} copyText={block.content}>
              <text fg={colors.badge.label} attributes={createTextAttributes({ bold: true })}>
                {label}
              </text>
              <box marginTop={1} flexDirection="column">
                {renderUserMessageContent(sessionMessage.text)}
              </box>
            </UserMessageFrame>
          );
        }
        if (block.delivery === "current-turn-guidance") {
          return (
            <UserMessageFrame id={userBlockId} copyText={block.content}>
              <text fg={colors.badge.label} attributes={createTextAttributes({ bold: true })}>
                [turn update]
              </text>
              <box marginTop={1} flexDirection="column">
                {renderUserMessageContent(block.content)}
              </box>
            </UserMessageFrame>
          );
        }
        const skill = userBlockSkillInvocation(block);
        if (skill) {
          const userMessage = skill.userMessage ?? "";
          return (
            <UserMessageFrame id={userBlockId} copyText={userMessage || block.content}>
              <text
                fg={colors.badge.label}
                attributes={createTextAttributes({ bold: true })}
              >{`[skill] ${skill.name}`}</text>
              <Show when={userMessage.length > 0}>
                <box marginTop={1} flexDirection="column">
                  {renderUserMessageContent(userMessage)}
                </box>
              </Show>
            </UserMessageFrame>
          );
        }
        const splitReminder = systemReminderUserContent(block);
        if (splitReminder) {
          const hasUserContent = splitReminder.userContent.length > 0;
          return (
            <>
              <Show when={hasUserContent}>
                <UserMessageFrame id={userBlockId} copyText={splitReminder.userContent}>
                  {renderUserMessageContent(splitReminder.userContent)}
                </UserMessageFrame>
              </Show>
              {renderSystemReminderBlock(splitReminder.reminderContent, {
                id: hasUserContent ? `${userBlockId}-system-reminder` : userBlockId,
              })}
            </>
          );
        }
        return (
          <UserMessageFrame id={userBlockId} copyText={block.content}>
            {renderUserMessageContent(block.content)}
          </UserMessageFrame>
        );
      }

      case "thinking": {
        const thinkingContent = () => {
          props.configRevision?.();
          const collapsed = block.finalized && block.content && !transcriptBlockExpanded(block.id);
          return collapsed && typeof block.content === "string"
            ? formatCollapsedThinking(block.content, getConfig().ui.thinking_preview_lines)
            : block.content;
        };
        return (
          <Show when={!props.hideThinking()}>
            <box width="100%" paddingLeft={1} paddingRight={1} flexDirection="column" flexShrink={0}>
              <Show
                when={block.finalized}
                fallback={
                  <text fg={colors.textSubtle} attributes={createTextAttributes({ italic: true })}>
                    {`thinking${getThinkingDots(props.getSpinnerChar())}`}
                  </text>
                }
              >
                <markdown
                  syntaxStyle={getThinkingSyntaxStyle()}
                  streaming={true}
                  content={stripEmoji(thinkingContent())}
                  conceal={true}
                  fg={colors.textSubtle}
                />
              </Show>
            </box>
          </Show>
        );
      }

      case "content":
        if (hasPluginMessageRenderer(block.type)) {
          const pluginRendered = pluginMessageFor(block.type, block.content);
          if (pluginRendered) return renderPluginMessage(pluginRendered);
        }
        return (
          <box
            ref={(value: BoxRenderable) => {
              assistantContentBox = value;
              updateAssistantContentWidth();
            }}
            width="100%"
            paddingLeft={1}
            paddingRight={1}
            flexShrink={0}
            flexDirection="column"
            onSizeChange={updateAssistantContentWidth}
            onMouseUp={(evt: any) => {
              const url = getLinkUrlAtScreenPosition(props.renderer ?? evt.renderer, evt.x, evt.y);
              if (url) {
                openUrl(url);
                toast.show(`Opening ${truncateTextEnd(url, 60)}…`);
              }
            }}
          >
            <Show
              when={shouldRenderLinkedPlainText(block.content)}
              fallback={
                <markdown
                  syntaxStyle={getSyntaxStyle()}
                  internalBlockMode="top-level"
                  tableOptions={{ style: "grid" }}
                  // Keep OpenTUI's incremental Markdown path enabled after the
                  // final chunk, matching OpenCode. Toggling streaming off forces
                  // a full block refresh and causes a visible end-of-stream flicker.
                  streaming={true}
                  content={assistantMarkdownContent()}
                  conceal={true}
                  fg={colors.fg}
                  bg={colors.bg}
                />
              }
            >
              <LinkedPlainText content={block.content} fg={colors.fg} />
            </Show>
          </box>
        );

      case "elicitation":
        // Pending elicitations render in the composer area so the form replaces
        // the editor chrome instead of appearing mid-thread.
        return null;

      case "tool": {
        const toolBlock = block as ToolBlock;
        if (toolHiddenForApproval()) return null;
        return (
          <box width="100%" paddingLeft={1} flexDirection="column">
            {currentToolOutput()?.header}
            <Show when={currentToolOutput()?.result}>{(result) => <box width="100%">{result()}</box>}</Show>
            <Show when={currentToolOutput()?.collapsed && app.state.transcriptSelectedRows[toolBlock.id] === true}>
              {renderToggleHint(colors, "enter to expand", { prefix: "  " })}
            </Show>
          </box>
        );
      }

      case "user-bash": {
        const bashBlock = block as UserBashBlock;
        const title = userBashHeader(bashBlock.excludeFromContext);
        const outputLines = bashBlock.output
          .trimEnd()
          .split("\n")
          .filter((line, index, lines) => line || index < lines.length - 1);
        const previewLimit = 20;
        const hiddenLineCount = Math.max(0, outputLines.length - previewLimit);
        const visibleOutputLines = outputLines.slice(0, previewLimit);
        return (
          <UserMessageFrame>
            <text fg={colors.badge.label} attributes={createTextAttributes({ bold: true })}>
              {title}
            </text>
            <text>
              <span style={{ fg: colors.textLabel, bold: true } as any}>$ </span>
              <span style={{ fg: colors.fg } as any}>{bashBlock.command}</span>
            </text>
            <Show when={visibleOutputLines.length > 0}>
              <box flexDirection="column">
                <For each={visibleOutputLines}>{(line) => <text fg={colors.textMuted}>{line}</text>}</For>
                <Show when={hiddenLineCount > 0}>
                  <text fg={colors.textMuted}>{`... (${hiddenLineCount} lines hidden)`}</text>
                </Show>
              </box>
            </Show>
            <Show when={bashBlock.status === "done" && bashBlock.exitCode !== undefined && bashBlock.exitCode !== 0}>
              <text fg={colors.error}>{`exit ${bashBlock.exitCode}`}</text>
            </Show>
          </UserMessageFrame>
        );
      }

      case "plugin": {
        const pluginRendered = pluginMessageFor(block.blockType, block.content, {
          blockId: block.id,
          data: block.data,
        });
        if (pluginRendered) return renderPluginMessage(pluginRendered, { id: `plugin-${block.id}` });
        if (block.blockType === "info" || block.blockType === "warning" || block.blockType === "error") {
          const color =
            block.blockType === "error" ? colors.error : block.blockType === "warning" ? colors.notice : colors.info;
          const prefix =
            block.blockType === "error"
              ? `${TOAST_ERROR_SYMBOL} `
              : block.blockType === "warning"
                ? `${TOAST_WARNING_SYMBOL} `
                : `${TOAST_INFO_SYMBOL} `;
          const lines = block.content.split("\n");
          return (
            <box width="100%" paddingLeft={1} paddingRight={1} flexDirection="column">
              <For each={lines}>
                {(line, i) => (
                  <text fg={color}>
                    {i() === 0 ? prefix : "  "}
                    {line}
                  </text>
                )}
              </For>
            </box>
          );
        }
        return (
          <box width="100%" paddingLeft={1} paddingRight={1} flexDirection="column">
            <text fg={colors.textMuted}>{block.content}</text>
          </box>
        );
      }

      case "info": {
        const infoBlock = block as InfoBlock;

        // Inline spinner block — animated, updated in-place when operation completes
        if (infoBlock.variant === "spinner") {
          return (
            <box width="100%" paddingLeft={1} paddingRight={1}>
              <text fg={colors.textLabel}>
                <span style={{ fg: colors.accent } as any}>{props.getSpinnerChar()} </span>
                {infoBlock.content}
              </text>
            </box>
          );
        }

        // Session welcome block — skip rendering here, handled by WelcomeScreen
        if (infoBlock.variant === "session") {
          return null;
        }

        // Loaded resources block
        if (infoBlock.variant === "resources") {
          const lines = infoBlock.content.split("\n");
          return (
            <box width="100%" paddingLeft={1} paddingRight={1} flexDirection="column">
              <For each={lines}>
                {(line) => {
                  if (line.startsWith("[") && line.endsWith("]")) {
                    // Section header: [Context] or [Skills]
                    return (
                      <box height={1}>
                        <text fg={colors.notice}>{line}</text>
                      </box>
                    );
                  }
                  if (line.trim() === "") return null;
                  // Path line (indented)
                  return (
                    <box height={1}>
                      <text fg={colors.textMuted}>{line}</text>
                    </box>
                  );
                }}
              </For>
            </box>
          );
        }

        // Plain structured info block used by /session and similar commands.
        // Rules:
        // - title lines end with ':' and use label text + bold
        // - section headers end with ':' and use label text
        // - indented key/value rows align columns and use muted key + label value
        // - freeform indented lines fall back to muted text
        if (infoBlock.variant === "plain") {
          const lines = infoBlock.content.split("\n");
          const kvRows = lines
            .map((line) => {
              const m = line.match(/^(\s+)([^:]+):(.*)$/);
              if (!m) return null;
              return { indent: m[1], key: m[2].trimEnd(), value: m[3].trimStart() };
            })
            .filter((row): row is { indent: string; key: string; value: string } => row !== null);
          const keyWidth = kvRows.length > 0 ? Math.max(...kvRows.map((row) => row.key.length)) : 0;

          return (
            <box width="100%" paddingLeft={1} paddingRight={1} flexDirection="column">
              <For each={lines}>
                {(line) => {
                  if (line === "") return <box height={1} />;

                  if (!line.startsWith(" ") && line.trimEnd().endsWith(":")) {
                    const isTitle = !lines.slice(0, lines.indexOf(line)).some((prev: string) => prev.trim().length > 0);
                    return (
                      <text
                        fg={colors.textLabel}
                        attributes={isTitle ? createTextAttributes({ bold: true }) : undefined}
                      >
                        {line}
                      </text>
                    );
                  }

                  const kv = line.match(/^(\s+)([^:]+):(.*)$/);
                  if (kv) {
                    const indent = kv[1];
                    const key = kv[2].trimEnd();
                    const value = kv[3].trimStart();
                    return (
                      <text fg={colors.textLabel}>
                        <span style={{ fg: colors.textMuted } as any}>
                          {indent}
                          {key.padEnd(keyWidth + 2)}
                        </span>
                        {value}
                      </text>
                    );
                  }

                  return <text fg={colors.textMuted}>{line}</text>;
                }}
              </For>
            </box>
          );
        }

        const color =
          infoBlock.variant === "error" ? colors.error : infoBlock.variant === "warning" ? colors.notice : colors.info;
        const isInterrupted = infoBlock.variant === "info" && infoBlock.content.startsWith("Interrupted");
        const prefix = isInterrupted
          ? ""
          : infoBlock.variant === "error"
            ? `${TOAST_ERROR_SYMBOL} `
            : infoBlock.variant === "warning"
              ? `${TOAST_WARNING_SYMBOL} `
              : `${TOAST_INFO_SYMBOL} `;
        const lines = infoBlock.content.split("\n");
        return (
          <box width="100%" paddingLeft={1} paddingRight={1} flexDirection="column">
            <For each={lines}>
              {(line, i) => (
                <text fg={color}>
                  {i() === 0 ? prefix : "  "}
                  {line}
                </text>
              )}
            </For>
          </box>
        );
      }

      default:
        return null;
    }
  };

  const selectableContent = createMemo(() => {
    const block = props.block;
    const content = renderBlock();
    return content ? (
      <TranscriptFrame
        block={block}
        prevBlock={props.prevBlock}
        blockId={block.id}
        compact={currentBlockCompact}
        onSelect={props.onTranscriptSelect}
        onActivate={() => app.setState("transcriptDetailBlockId", block.id)}
      >
        {content}
      </TranscriptFrame>
    ) : null;
  });
  return <>{selectableContent()}</>;
}
