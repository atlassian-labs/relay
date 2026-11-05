import type { ToolCallGroupsConfig, ToolCallGroupRuleConfig } from "../../config";
import type { ChatBlock, ToolBlock } from "../state";

export const TOOL_CALL_GROUP_ID_PREFIX = "tool-call-group:";

export interface ToolCallGroup {
  readonly id: string;
  readonly firstBlockId: string;
  readonly memberIds: readonly string[];
  readonly members: readonly ToolBlock[];
  readonly summary: string;
}

export interface ToolCallGroupProjection {
  readonly groups: readonly ToolCallGroup[];
  readonly byId: ReadonlyMap<string, ToolCallGroup>;
  readonly byFirstBlockId: ReadonlyMap<string, ToolCallGroup>;
  readonly byMemberBlockId: ReadonlyMap<string, ToolCallGroup>;
}

const EMPTY_PROJECTION: ToolCallGroupProjection = {
  groups: [],
  byId: new Map(),
  byFirstBlockId: new Map(),
  byMemberBlockId: new Map(),
};

function ruleIndexByToolName(config: ToolCallGroupsConfig): Map<string, number> {
  const result = new Map<string, number>();
  for (const [ruleIndex, rule] of config.rules.entries()) {
    for (const toolName of rule.tool_names) {
      if (!result.has(toolName)) result.set(toolName, ruleIndex);
    }
  }
  return result;
}

function eligibleRuleIndex(
  block: ChatBlock | undefined,
  ruleByToolName: ReadonlyMap<string, number>,
): number | undefined {
  if (!block || block.type !== "tool" || block.status === "approval") return undefined;
  return ruleByToolName.get(block.toolName);
}

/** A live tool can still change its name or leave approval, so it cannot safely close a run yet. */
function isStableRunBreaker(block: ChatBlock | undefined): boolean {
  if (!block) return false;
  if (block.type !== "tool") return true;
  return block.status === "success" || block.status === "error";
}

export function formatToolCallGroupSummary(
  members: readonly ToolBlock[],
  rules: readonly ToolCallGroupRuleConfig[],
): string {
  const ruleByToolName = new Map<string, number>();
  for (const [ruleIndex, rule] of rules.entries()) {
    for (const toolName of rule.tool_names) {
      if (!ruleByToolName.has(toolName)) ruleByToolName.set(toolName, ruleIndex);
    }
  }

  const order: number[] = [];
  const counts = new Map<number, number>();
  for (const member of members) {
    const ruleIndex = ruleByToolName.get(member.toolName);
    if (ruleIndex === undefined) continue;
    if (!counts.has(ruleIndex)) order.push(ruleIndex);
    counts.set(ruleIndex, (counts.get(ruleIndex) ?? 0) + 1);
  }

  return order
    .map((ruleIndex) => {
      const count = counts.get(ruleIndex) ?? 0;
      const rule = rules[ruleIndex];
      return (count === 1 ? rule.singular : rule.plural).replace("{count}", String(count));
    })
    .join(", ");
}

/**
 * Build maximal closed runs of at least two consecutive configured, non-approval tool calls.
 * A trailing eligible run remains ungrouped until a non-eligible block closes it.
 */
export function buildToolCallGroupProjection(
  blocks: readonly ChatBlock[],
  config: ToolCallGroupsConfig,
): ToolCallGroupProjection {
  if (!config.enabled || config.rules.length === 0 || blocks.length < 2) return EMPTY_PROJECTION;

  const ruleByToolName = ruleIndexByToolName(config);
  const groups: ToolCallGroup[] = [];
  let index = 0;
  while (index < blocks.length) {
    if (eligibleRuleIndex(blocks[index], ruleByToolName) === undefined) {
      index += 1;
      continue;
    }
    const start = index;
    index += 1;
    while (index < blocks.length && eligibleRuleIndex(blocks[index], ruleByToolName) !== undefined) index += 1;
    const breaker = blocks[index];
    const isOpenRun = index === blocks.length || !isStableRunBreaker(breaker);
    if (index - start < 2 || isOpenRun) continue;

    const members = blocks.slice(start, index) as ToolBlock[];
    const firstBlockId = members[0].id;
    groups.push({
      id: `${TOOL_CALL_GROUP_ID_PREFIX}${firstBlockId}`,
      firstBlockId,
      memberIds: members.map((member) => member.id),
      members,
      summary: formatToolCallGroupSummary(members, config.rules),
    });
  }

  const byId = new Map<string, ToolCallGroup>();
  const byFirstBlockId = new Map<string, ToolCallGroup>();
  const byMemberBlockId = new Map<string, ToolCallGroup>();
  for (const group of groups) {
    byId.set(group.id, group);
    byFirstBlockId.set(group.firstBlockId, group);
    for (const memberId of group.memberIds) byMemberBlockId.set(memberId, group);
  }
  return { groups, byId, byFirstBlockId, byMemberBlockId };
}

export function toolCallGroupNavigableIds(
  blocks: readonly ChatBlock[],
  projection: ToolCallGroupProjection,
  expandedGroups: Readonly<Record<string, boolean>>,
  showThinking: boolean,
): string[] {
  const ids: string[] = [];
  for (const block of blocks) {
    const group = projection.byMemberBlockId.get(block.id);
    if (group) {
      if (group.firstBlockId !== block.id) continue;
      ids.push(group.id);
      if (expandedGroups[group.id]) ids.push(...group.memberIds);
      continue;
    }
    if (block.type === "thinking" && !showThinking) continue;
    if (block.type === "elicitation") continue;
    if (block.type === "tool" && block.status === "approval") continue;
    if (block.type === "info" && block.variant === "session") continue;
    ids.push(block.id);
  }
  return ids;
}

export type ToolCallGroupLayoutRole = "collapsed-header" | "collapsed-hidden" | "expanded-header";

export function toolCallGroupLayoutRoles(
  projection: ToolCallGroupProjection,
  expandedGroups: Readonly<Record<string, boolean>>,
): Readonly<Record<string, ToolCallGroupLayoutRole>> {
  const roles: Record<string, ToolCallGroupLayoutRole> = {};
  for (const group of projection.groups) {
    if (expandedGroups[group.id]) {
      roles[group.firstBlockId] = "expanded-header";
      continue;
    }
    roles[group.firstBlockId] = "collapsed-header";
    for (const memberId of group.memberIds.slice(1)) roles[memberId] = "collapsed-hidden";
  }
  return roles;
}

export function toolCallGroupLayoutKey(
  projection: ToolCallGroupProjection,
  expandedGroups: Readonly<Record<string, boolean>>,
): string {
  return projection.groups
    .map((group) => `${group.id}:${expandedGroups[group.id] ? "1" : "0"}:${group.memberIds.join(",")}`)
    .join(";");
}
