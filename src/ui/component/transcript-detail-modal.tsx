import { Show } from "solid-js";
import type { ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import { useSharedTerminalDimensions } from "../context/terminal-dimensions";
import { getConfig } from "../../config";
import type { ToolBlock } from "../state";
import { useApp } from "../state";
import { getColors, getSyntaxStyle, getThinkingSyntaxStyle } from "../context/theme";
import {
  clampDimension,
  UI_MODAL_HORIZONTAL_MARGIN,
  UI_MODAL_MIN_HEIGHT,
  UI_MODAL_MIN_WIDTH,
  UI_MODAL_VERTICAL_MARGIN,
} from "../layout";
import { getToolIcon } from "../tool-renderers";
import { expandedDefaultBodyText, renderExpandedDefaultBody } from "../tool-renderers/agents/default";
import { copyToClipboard } from "../util/clipboard";
import { useToast } from "../ui/toast";
import { formatToolName } from "../util/tool-icons";
import { stripEmoji } from "../util/format";
import { systemReminderUserContent } from "../util/system-reminder";
import { ModalFrame } from "./modal-frame";
import { ModalFooter, ModalHeader } from "./modal-layout";

interface KeyboardEventLike {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
  option?: boolean;
  preventDefault?: () => void;
  stopPropagation?: () => void;
}

export function TranscriptDetailModal(props: {
  activeProfile: () => Parameters<typeof getToolIcon>[0];
  open: () => boolean;
  onClose: () => void;
}) {
  const app = useApp();
  const dims = useSharedTerminalDimensions();
  const colors = getColors();
  const toast = useToast();
  let bodyScroll: ScrollBoxRenderable | undefined;

  const block = () => {
    const blockId = app.state.transcriptDetailBlockId;
    return blockId ? app.state.blocks.find((candidate) => candidate.id === blockId) : undefined;
  };
  const thinkingContent = () => {
    const selected = block();
    return selected?.type === "thinking" ? selected.content : "";
  };
  const modalWidth = () =>
    clampDimension(
      Math.floor(dims().width * 0.86),
      Math.min(UI_MODAL_MIN_WIDTH, Math.max(1, dims().width - 2)),
      Math.min(116, Math.max(1, dims().width - UI_MODAL_HORIZONTAL_MARGIN)),
    );
  const modalHeight = () =>
    clampDimension(
      Math.floor(dims().height * 0.8),
      Math.min(UI_MODAL_MIN_HEIGHT, Math.max(1, dims().height - 2)),
      Math.max(1, dims().height - UI_MODAL_VERTICAL_MARGIN),
    );
  const contentWidth = () => Math.max(1, modalWidth() - 4);
  const title = () => {
    const selected = block();
    if (!selected) return "Details";
    if (selected.type === "thinking") return "Thinking details";
    if (selected.type === "tool") {
      return `${getToolIcon(props.activeProfile(), selected.toolName)} ${formatToolName(selected.toolName)}`;
    }
    return "Details";
  };
  const pageSize = () => Math.max(1, bodyScroll?.viewport.height ?? modalHeight() - 4);
  const consume = (event: KeyboardEventLike) => {
    event.preventDefault?.();
    event.stopPropagation?.();
  };

  useKeyboard((event: KeyboardEventLike) => {
    if (!props.open()) return;
    const keyName = event.name?.toLowerCase();
    const noModifiers = !event.ctrl && !event.meta && !event.shift && !event.alt && !event.option;
    const isLeftKey = keyName === "left" || keyName === "arrowleft" || keyName === "leftarrow";
    if (keyName === "escape" || (noModifiers && isLeftKey)) {
      props.onClose();
      consume(event);
      return;
    }
    if ((event.ctrl || event.meta) && event.name === "c") {
      copyExpandedContent();
      consume(event);
      return;
    }
    if (event.name === "up") bodyScroll?.scrollBy(-1);
    else if (event.name === "down") bodyScroll?.scrollBy(1);
    else if (event.name === "pageup") bodyScroll?.scrollBy(-pageSize());
    else if (event.name === "pagedown") bodyScroll?.scrollBy(pageSize());
    else if (event.name === "home") bodyScroll?.scrollTo(0);
    else if (event.name === "end") bodyScroll?.scrollTo(bodyScroll.scrollHeight);
    else return;
    consume(event);
  });

  const toolRenderContext = (tool: ToolBlock) => ({
    block: tool,
    colors,
    helpers: {
      formatToolName,
      getToolIcon: (toolName: string) => getToolIcon(props.activeProfile(), toolName),
      getSyntaxStyle,
      hasMarkup: () => false,
      renderMarkup: () => [],
    },
    expanded: true,
    previewLines: getConfig().ui.tool_result_preview_lines,
    cwd: app.state.cwd,
    threadId: app.state.activeThreadId,
    sessionId: app.state.threads.find((thread) => thread.id === app.state.activeThreadId)?.sessionId ?? null,
  });
  const renderToolBody = (tool: ToolBlock) =>
    renderExpandedDefaultBody(toolRenderContext(tool), { collapseHint: false, compact: true });
  const detailText = () => {
    const selected = block();
    if (!selected) return "";
    if (selected.type === "user") {
      const splitReminder = systemReminderUserContent(selected);
      if (splitReminder) {
        return [splitReminder.userContent, "[system-reminder]", splitReminder.reminderContent]
          .filter((part) => part.length > 0)
          .join("\n\n");
      }
      return selected.content;
    }
    if (selected.type === "user-bash") return `${selected.command}\n\n${selected.output}`;
    if ("content" in selected && typeof selected.content === "string") return selected.content;
    return "";
  };
  const copyExpandedContent = () => {
    const selected = block();
    if (!selected) return;
    let text = detailText();
    if (selected.type === "tool") {
      const body = expandedDefaultBodyText(toolRenderContext(selected));
      text = `${title()}\n\nParams\n${body.params || "(none)"}\n---\nResult\n${body.result || "(empty)"}`;
    } else if (selected.type === "thinking") {
      text = `Thinking details\n\n${selected.content}`;
    }
    if (text) {
      copyToClipboard(text);
      toast.show("Copied details to clipboard");
    }
  };

  return (
    <ModalFrame open={props.open} width={modalWidth} height={modalHeight} zIndex={3500} onClose={props.onClose}>
      <ModalHeader title={title} right="esc" width={contentWidth} />
      <box height={1} flexShrink={0} />
      <scrollbox
        ref={(value: ScrollBoxRenderable) => {
          bodyScroll = value;
        }}
        flexGrow={1}
        flexShrink={1}
        width="100%"
      >
        <Show when={block()}>
          {(selected) => (
            <>
              <Show when={selected().type === "tool"}>{renderToolBody(selected() as ToolBlock)}</Show>
              <Show when={selected().type === "thinking"}>
                <markdown
                  syntaxStyle={getThinkingSyntaxStyle()}
                  streaming={true}
                  content={stripEmoji(thinkingContent())}
                  conceal={true}
                  fg={colors.fg}
                />
              </Show>
              <Show when={selected().type !== "tool" && selected().type !== "thinking"}>
                <text fg={colors.fg}>{detailText()}</text>
              </Show>
            </>
          )}
        </Show>
      </scrollbox>
      <box height={1} flexShrink={0} />
      <ModalFooter
        width={contentWidth}
        leftHints={[
          ["←", "close"],
          ["↑/↓", "scroll"],
          ["pgup/pgdn", "scroll"],
          ["ctrl+c", "copy"],
        ]}
      />
    </ModalFrame>
  );
}
