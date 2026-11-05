import { type ChatBlock, type ToolBlock, useApp } from "../state";
import { getColors } from "../context/theme";
import { toolLabelColor } from "../tool-renderers/core";
import type { ToolCallGroup } from "../util/tool-call-groups";
import { TranscriptFrame } from "./blocks/chat-block";

export function ToolCallGroupHeader(props: {
  group: ToolCallGroup;
  firstBlock: ToolBlock;
  prevBlock?: ChatBlock;
  expanded: () => boolean;
  onSelect?: () => void;
  activateWhenNavigationDisabled?: boolean;
}) {
  const app = useApp();
  const colors = getColors();
  const iconColor = () => {
    if (props.group.members.some((member) => member.status === "error")) return toolLabelColor("error", colors);
    if (props.group.members.every((member) => member.status === "success")) return toolLabelColor("success", colors);
    return toolLabelColor("running", colors);
  };
  return (
    <TranscriptFrame
      block={props.firstBlock}
      prevBlock={props.prevBlock}
      blockId={props.group.id}
      compact={() => true}
      onSelect={props.onSelect}
      onActivate={() => app.setState("expandedToolCallGroups", props.group.id, !props.expanded())}
      activateWhenNavigationDisabled={props.activateWhenNavigationDisabled}
    >
      <box width="100%" paddingLeft={1} flexDirection="column">
        <text>
          <span style={{ fg: iconColor(), bold: true } as any}>{props.expanded() ? "⊟" : "⊞"}</span>
          <span style={{ fg: colors.textLabel, bold: true } as any}>{` ${props.group.summary}`}</span>
        </text>
      </box>
    </TranscriptFrame>
  );
}
