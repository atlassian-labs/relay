import { describe, expect, test } from "bun:test";
import {
  buildResumeHierarchy,
  type ResumeHierarchyNode,
  type ResumeSessionRelation,
} from "../../../src/ui/app/resume-hierarchy";

type Session = { readonly id: string };

const sessions = (...ids: string[]): Session[] => ids.map((id) => ({ id }));
const relation = (parentSessionId: string, childSessionId: string): ResumeSessionRelation => ({
  parentSessionId,
  childSessionId,
});
const ids = (nodes: readonly ResumeHierarchyNode<Session>[]): unknown[] =>
  nodes.map((node) => [node.value.id, ids(node.children)]);
const hierarchy = (values: readonly Session[], relations: readonly ResumeSessionRelation[]) =>
  buildResumeHierarchy(values, (session) => session.id, relations);

describe("resume hierarchy", () => {
  test("nests a handoff of a handoff under its immediate parent", () => {
    const result = hierarchy(sessions("grandchild", "child", "parent", "unrelated"), [
      relation("parent", "child"),
      relation("child", "grandchild"),
    ]);

    expect(ids(result)).toEqual([
      ["parent", [["child", [["grandchild", []]]]]],
      ["unrelated", []],
    ]);
  });

  test("orders families and siblings by the existing session order", () => {
    const result = hierarchy(sessions("second-child", "unrelated", "first-child", "parent"), [
      relation("parent", "first-child"),
      relation("parent", "second-child"),
    ]);

    expect(ids(result)).toEqual([
      [
        "parent",
        [
          ["second-child", []],
          ["first-child", []],
        ],
      ],
      ["unrelated", []],
    ]);
  });

  test("leaves children with missing or ambiguous parents at the root", () => {
    const result = hierarchy(sessions("child", "parent-a", "parent-b"), [
      relation("missing", "child"),
      relation("parent-a", "child"),
      relation("parent-b", "child"),
    ]);

    expect(ids(result)).toEqual([
      ["child", []],
      ["parent-a", []],
      ["parent-b", []],
    ]);
  });

  test("breaks cycles without dropping sessions", () => {
    const result = hierarchy(sessions("a", "b", "child"), [
      relation("a", "b"),
      relation("b", "a"),
      relation("a", "child"),
    ]);

    expect(ids(result)).toEqual([
      ["a", [["child", []]]],
      ["b", []],
    ]);
  });
});
