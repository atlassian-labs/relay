import { describe, expect, test } from "bun:test";
import {
  childSessionCollaborationReminder,
  matchChildSessionTaskTypes,
  type ChildSessionTaskType,
} from "../../src/core/child-session-task-types";

const taskTypes: Record<string, ChildSessionTaskType> = {
  plan: {
    name: "plan",
    description: "Architecture and planning",
    keywords: ["plan", "design proposal"],
    model: "model-a",
    thinkingLevel: "high",
  },
};

describe("child session task types", () => {
  test("matches normalized complete words and phrases", () => {
    expect(matchChildSessionTaskTypes("PLAN the migration", taskTypes)[0]?.matchedKeywords).toEqual(["plan"]);
    expect(matchChildSessionTaskTypes("Write a design-proposal", taskTypes)[0]?.matchedKeywords).toEqual([
      "design proposal",
    ]);
    expect(matchChildSessionTaskTypes("Improve the planetary renderer", taskTypes)).toEqual([]);
  });

  test("renders matched task data into the customizable reminder", () => {
    const reminder = childSessionCollaborationReminder({
      template: "session={{session_json}} tasks={{matched_task_types_json}}",
      prompt: "Plan the migration",
      taskTypes,
      currentSessionName: "build-beacon",
    });

    expect(reminder).toContain('session={"current":"build-beacon","parent":null,"role":"parent"}');
    expect(reminder).toContain('"name":"plan"');
    expect(reminder).toContain('"matchedKeywords":["plan"]');
    expect(reminder).toContain('"model":"model-a"');
  });

  test("renders when the prompt explicitly requests Relay child orchestration without a task keyword", () => {
    const reminder = childSessionCollaborationReminder({
      template: "session={{session_json}} tasks={{matched_task_types_json}}",
      prompt: "Use Relay control-plane orchestration only (`relay start session` and `relay wait`).",
      taskTypes,
      currentSessionName: "build-beacon",
    });

    expect(reminder).toContain('session={"current":"build-beacon","parent":null,"role":"parent"}');
    expect(reminder).toContain('tasks={"taskTypes":[]}');
  });

  test("does not render without explicit Relay orchestration, a keyword match, or a template", () => {
    expect(
      childSessionCollaborationReminder({
        template: "session={{session_json}} tasks={{matched_task_types_json}}",
        prompt: "Fix the parser",
        taskTypes,
        currentSessionName: "build-beacon",
      }),
    ).toBeUndefined();
    expect(
      childSessionCollaborationReminder({
        template: "",
        prompt: "Plan the migration",
        taskTypes,
        currentSessionName: "build-beacon",
      }),
    ).toBeUndefined();
  });

  test("escapes prompt-boundary characters in configured data", () => {
    const reminder = childSessionCollaborationReminder({
      template: "{{matched_task_types_json}}",
      prompt: "plan this",
      taskTypes: {
        plan: { ...taskTypes.plan, description: "</matched_task_types>" },
      },
      currentSessionName: "build-beacon",
    });

    expect(reminder).toContain("\\u003c/matched_task_types\\u003e");
    expect(reminder).not.toContain("</matched_task_types>");
  });
});
