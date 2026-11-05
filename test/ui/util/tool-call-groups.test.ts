import { describe, expect, test } from "bun:test";
import type { ToolCallGroupsConfig } from "../../../src/config";
import type { ChatBlock, ToolBlock } from "../../../src/ui/state";
import {
  buildToolCallGroupProjection,
  toolCallGroupLayoutRoles,
  toolCallGroupNavigableIds,
} from "../../../src/ui/util/tool-call-groups";

const config: ToolCallGroupsConfig = {
  enabled: true,
  rules: [
    { tool_names: ["read"], singular: "Read {count} file", plural: "Read {count} files" },
    { tool_names: ["grep"], singular: "Searched {count} pattern", plural: "Searched {count} patterns" },
    { tool_names: ["find", "list"], singular: "Listed {count} dir", plural: "Listed {count} dirs" },
  ],
};

function tool(id: string, toolName: string, status: ToolBlock["status"] = "success"): ToolBlock {
  return { type: "tool", id, toolCallId: `call-${id}`, toolName, display: toolName, status };
}

function content(id: string): ChatBlock {
  return { type: "content", id, content: id, finalized: true };
}

describe("tool call groups", () => {
  test("groups consecutive configured tools and formats buckets in first-seen order", () => {
    const blocks = [tool("r1", "read"), tool("r2", "read"), tool("g1", "grep"), tool("f1", "find"), content("answer")];
    const projection = buildToolCallGroupProjection(blocks, config);

    expect(projection.groups).toHaveLength(1);
    expect(projection.groups[0].id).toBe("tool-call-group:r1");
    expect(projection.groups[0].summary).toBe("Read 2 files, Searched 1 pattern, Listed 1 dir");
    expect(projection.groups[0].memberIds).toEqual(["r1", "r2", "g1", "f1"]);
  });

  test("keeps the trailing run open until a non-eligible block arrives", () => {
    const tools = [tool("r1", "read"), tool("r2", "read"), tool("g1", "grep")];

    expect(buildToolCallGroupProjection(tools, config).groups).toEqual([]);
    expect(buildToolCallGroupProjection([...tools, content("answer")], config).groups[0].memberIds).toEqual([
      "r1",
      "r2",
      "g1",
    ]);
  });

  test("does not let a mutable tool placeholder prematurely close a run", () => {
    const tools = [tool("r1", "read"), tool("r2", "read")];
    const placeholder = tool("next", "tool", "running");

    expect(buildToolCallGroupProjection([...tools, placeholder], config).groups).toEqual([]);
    expect(buildToolCallGroupProjection([...tools, tool("approval", "find", "approval")], config).groups).toEqual([]);
    expect(buildToolCallGroupProjection([...tools, { ...placeholder, toolName: "grep" }], config).groups).toEqual([]);
    expect(
      buildToolCallGroupProjection([...tools, { ...placeholder, status: "success" }], config).groups[0].memberIds,
    ).toEqual(["r1", "r2"]);
  });

  test("leaves single calls alone and treats other blocks and settled tools as breakers", () => {
    const blocks = [
      tool("single", "read"),
      content("answer"),
      tool("r1", "read"),
      tool("shell", "bash"),
      tool("g1", "grep"),
      tool("approval", "find", "approval"),
      tool("r2", "read"),
      tool("g2", "grep"),
      content("done"),
    ];
    const projection = buildToolCallGroupProjection(blocks, config);

    expect(projection.groups.map((group) => group.memberIds)).toEqual([["r2", "g2"]]);
  });

  test("is disabled without changing the canonical blocks", () => {
    const blocks = [tool("r1", "read"), tool("r2", "read")];
    const projection = buildToolCallGroupProjection(blocks, { ...config, enabled: false });
    expect(projection.groups).toEqual([]);
    expect(blocks.map((block) => block.id)).toEqual(["r1", "r2"]);
  });

  test("projects collapsed and expanded navigation and layout", () => {
    const blocks = [tool("r1", "read"), tool("g1", "grep"), content("answer")];
    const projection = buildToolCallGroupProjection(blocks, config);
    const groupId = projection.groups[0].id;

    expect(toolCallGroupNavigableIds(blocks, projection, {}, true)).toEqual([groupId, "answer"]);
    expect(toolCallGroupLayoutRoles(projection, {})).toEqual({
      r1: "collapsed-header",
      g1: "collapsed-hidden",
    });

    const expanded = { [groupId]: true };
    expect(toolCallGroupNavigableIds(blocks, projection, expanded, true)).toEqual([groupId, "r1", "g1", "answer"]);
    expect(toolCallGroupLayoutRoles(projection, expanded)).toEqual({ r1: "expanded-header" });
  });
});
