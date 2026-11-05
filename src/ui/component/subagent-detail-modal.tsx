import { createMemo, createSignal, For, onCleanup, Show, type JSX } from "solid-js";
import { getConfig, subscribeConfig } from "../../config";
import { useSharedTerminalDimensions } from "../context/terminal-dimensions";
import type { ChatBlock, ToolBlock } from "../state";
import { useApp } from "../state";
import { getColors } from "../context/theme";
import { UI_GUTTER_X } from "../layout";
import { subagentName, subagentStatusLabel } from "../app/subagents";
import { buildToolCallGroupProjection, type ToolCallGroup } from "../util/tool-call-groups";
import { ShortcutHints } from "./shortcut-hints";
import { ToolCallGroupHeader } from "./tool-call-group";

export function SubagentDetailModal(props: {
  open: () => boolean;
  onClose: () => void;
  renderBlock: (block: ChatBlock, previous?: ChatBlock) => JSX.Element;
}) {
  const app = useApp();
  const dims = useSharedTerminalDimensions();
  const tool = (): ToolBlock | undefined => {
    const id = app.state.selectedSubagentToolCallId;
    return id
      ? app.state.blocks.find((block): block is ToolBlock => block.type === "tool" && block.toolCallId === id)
      : undefined;
  };
  const entry = () => {
    const parent = tool();
    return parent?.subagent ? { tool: parent, state: parent.subagent } : undefined;
  };
  const blocks = (): readonly ChatBlock[] => entry()?.state.blocks ?? [];
  const [toolCallGroupsConfig, setToolCallGroupsConfig] = createSignal(getConfig().ui.tool_call_groups);
  const toolCallGroups = createMemo(() => buildToolCallGroupProjection(blocks(), toolCallGroupsConfig()));
  const groupExpanded = (group: ToolCallGroup) => app.state.expandedToolCallGroups[group.id] === true;
  const unsubscribeConfig = subscribeConfig((change) => {
    setToolCallGroupsConfig(change.config.ui.tool_call_groups);
  });
  onCleanup(unsubscribeConfig);

  return (
    <Show when={props.open()}>
      <box
        position="absolute"
        zIndex={4000}
        top={0}
        left={0}
        width={dims().width}
        height={dims().height}
        paddingTop={1}
        paddingLeft={UI_GUTTER_X}
        paddingRight={UI_GUTTER_X}
        flexDirection="column"
        backgroundColor={getColors().bg}
      >
        <Show when={entry()}>
          {(selected) => (
            <>
              <box height={1} width="100%" flexDirection="row" justifyContent="space-between">
                <text fg={getColors().accent} wrapMode="none">
                  {`Subagents / ${subagentName(selected())} (${selected().state.childSessionId ?? "starting…"})`}
                </text>
                <text
                  fg={selected().state.status === "running" ? getColors().running : getColors().textMuted}
                  wrapMode="none"
                >
                  {subagentStatusLabel(selected().state.status)}
                  <span style={{ fg: getColors().textMuted } as never}> · </span>
                  <ShortcutHints hints={[["esc", "back"]]} />
                </text>
              </box>
              <box height={1} width="100%" flexShrink={0} />
              <scrollbox flexGrow={1} flexShrink={1} width="100%" stickyScroll stickyStart="bottom">
                <Show
                  when={(selected().state.blocks ?? []).length > 0}
                  fallback={<text fg={getColors().textMuted}>Waiting for subagent activity…</text>}
                >
                  <For each={selected().state.blocks ?? []}>
                    {(block, index) => {
                      const previous = () => (index() > 0 ? selected().state.blocks?.[index() - 1] : undefined);
                      const renderNormalBlock = () => props.renderBlock(block, previous());
                      const group = () => toolCallGroups().byMemberBlockId.get(block.id);
                      return (
                        <Show when={group()} fallback={renderNormalBlock()}>
                          {(currentGroup) => (
                            <Show
                              when={currentGroup().firstBlockId === block.id && block.type === "tool"}
                              fallback={<Show when={groupExpanded(currentGroup())}>{renderNormalBlock()}</Show>}
                            >
                              <ToolCallGroupHeader
                                group={currentGroup()}
                                firstBlock={block as ToolBlock}
                                prevBlock={previous()}
                                expanded={() => groupExpanded(currentGroup())}
                                activateWhenNavigationDisabled
                              />
                              <Show when={groupExpanded(currentGroup())}>{renderNormalBlock()}</Show>
                            </Show>
                          )}
                        </Show>
                      );
                    }}
                  </For>
                </Show>
              </scrollbox>
            </>
          )}
        </Show>
      </box>
    </Show>
  );
}
