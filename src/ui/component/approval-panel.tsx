import { For, Show } from "solid-js";
import type { ToolBlock } from "../state";
import { getColors } from "../context/theme";
import { formatToolName } from "../util/tool-icons";
import { ShortcutHints } from "./shortcut-hints";
import { InteractionChoiceList, InteractionPanel } from "./interaction-panel";

export interface ApprovalPanelProps {
  readonly block: ToolBlock;
  readonly optionIndex: () => number;
}

const PREVIEW_LINE_LIMIT = 10;

export function ApprovalPanel(props: ApprovalPanelProps) {
  const colors = getColors();
  const options = () => props.block.approvalOptions ?? [];
  const activeOptionIndex = () => Math.min(props.optionIndex(), Math.max(0, options().length - 1));
  const previewLines = () =>
    (props.block.approvalPreview ?? "")
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.trim().length > 0);
  const promptTitle = () => formatToolName(props.block.toolName);
  const previewDetails = () => {
    const lines = previewLines();
    return lines[0]?.trim().toLowerCase() === promptTitle().toLowerCase() ? lines.slice(1) : lines;
  };
  const detailLines = () => previewDetails().slice(0, PREVIEW_LINE_LIMIT);
  const hiddenPreviewLineCount = () => Math.max(0, previewDetails().length - PREVIEW_LINE_LIMIT);

  return (
    <InteractionPanel>
      <text>
        <span style={{ fg: colors.notice, bold: true } as never}>✦ Permission Required</span>
      </text>

      <box marginTop={1} flexDirection="column">
        <text fg={colors.fg}>{promptTitle()}</text>
        <For each={detailLines()}>{(line) => <text fg={colors.textMuted}>{line}</text>}</For>
        <Show when={hiddenPreviewLineCount() > 0}>
          <text fg={colors.textMuted}>{`… ${hiddenPreviewLineCount()} more lines`}</text>
        </Show>
      </box>

      <Show
        when={options().length > 0}
        fallback={
          <box marginTop={1}>
            <text>
              <span style={{ fg: colors.textMuted } as never}>No permission options available · </span>
              <span style={{ fg: colors.textLabel } as never}>enter</span>
              <span style={{ fg: colors.textSubtle } as never}> deny</span>
            </text>
          </box>
        }
      >
        <box marginTop={1} flexDirection="column">
          <InteractionChoiceList
            choices={options().map((option) => ({ label: option.name }))}
            activeIndex={activeOptionIndex()}
            accentColor={colors.notice}
          />
        </box>
      </Show>

      <text>{""}</text>
      <text fg={colors.textMuted}>
        <ShortcutHints
          hints={[
            ["↑/↓", "navigate"],
            ["enter", "select"],
          ]}
        />
      </text>
    </InteractionPanel>
  );
}
