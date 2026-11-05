import { describe, expect, test } from "bun:test";
import { formatSkillInvocationPreview, parseSkillInvocationPrompt, skillInvocationDisplay } from "../src/skills";

describe("parseSkillInvocationPrompt", () => {
  function skillPrompt(args = ""): string {
    const block = [
      '<skill name="git-publish" location="/tmp/git-publish/SKILL.md">',
      "References are relative to /tmp/git-publish.",
      "",
      "Publish branches.",
      "</skill>",
    ].join("\n");
    return args ? `${block}\n\n${args}` : block;
  }

  test("preserves non-blank user message whitespace exactly", () => {
    const args = "  run this\n    --with-indent\n";

    expect(parseSkillInvocationPrompt(skillPrompt(args))).toMatchObject({
      name: "git-publish",
      userMessage: args,
    });
  });

  test("treats whitespace-only user message as absent", () => {
    expect(parseSkillInvocationPrompt(skillPrompt(" \n  "))).toMatchObject({
      name: "git-publish",
      userMessage: undefined,
    });
  });

  test("recognizes raw slash skill markdown emitted by ACP shims", () => {
    const prompt = [
      "/review focus on regressions",
      "---",
      "name: review",
      "description: Review changes",
      "register_cmd: true",
      "---",
      "# Review",
      "Read the diff.",
    ].join("\n");

    expect(parseSkillInvocationPrompt(prompt)).toMatchObject({
      name: "review",
      location: "",
      content: "# Review\nRead the diff.",
      userMessage: "focus on regressions",
    });
  });

  test("recognizes multiline raw slash skill args before frontmatter", () => {
    const prompt = [
      "/review focus on regressions",
      "  include edge cases",
      "",
      "---",
      "name: review",
      "description: Review changes",
      "register_cmd: true",
      "---",
      "# Review",
      "Read the diff.",
    ].join("\n");

    expect(parseSkillInvocationPrompt(prompt)).toMatchObject({
      name: "review",
      content: "# Review\nRead the diff.",
      userMessage: "focus on regressions\n  include edge cases",
    });
  });

  test("recognizes filesystem skill markdown emitted by Alta slash handlers", () => {
    const prompt = [
      "---",
      "name: review",
      "description: Review changes",
      "register_cmd: true",
      "---",
      "# Review",
      "Read the diff.",
      "ARGUMENTS: focus on regressions",
    ].join("\n");

    expect(parseSkillInvocationPrompt(prompt)).toMatchObject({
      name: "review",
      location: "",
      content: "# Review\nRead the diff.",
      userMessage: "focus on regressions",
    });
  });

  test("recognizes filesystem skill markdown without arguments", () => {
    const prompt = ["---", "name: review", "description: Review changes", "---", "# Review", "Read the diff."].join(
      "\n",
    );

    expect(parseSkillInvocationPrompt(prompt)).toMatchObject({
      name: "review",
      content: "# Review\nRead the diff.",
      userMessage: undefined,
    });
  });

  test("recognizes filesystem skill markdown without description", () => {
    const prompt = ["---", "name: review", "user-invocable: true", "---", "# Review", "Read the diff."].join("\n");

    expect(parseSkillInvocationPrompt(prompt)).toMatchObject({
      name: "review",
      content: "# Review\nRead the diff.",
    });
  });

  test("does not treat description-only frontmatter as a skill invocation", () => {
    const prompt = ["---", "description: release notes", "---", "Actual user prompt"].join("\n");

    expect(parseSkillInvocationPrompt(prompt)).toBeNull();
    expect(skillInvocationDisplay(prompt, { allowPartial: true })).toBeNull();
  });

  test("recognizes quoted and display-form filesystem skill names", () => {
    const prompt = ["---", 'name: "Review Skill"', "---", "# Review", "Read the diff."].join("\n");

    expect(parseSkillInvocationPrompt(prompt)).toMatchObject({
      name: "Review Skill",
      content: "# Review\nRead the diff.",
    });
  });

  test("preserves multiline filesystem skill arguments", () => {
    const prompt = [
      "---",
      "name: review",
      "description: Review changes",
      "---",
      "# Review",
      "Read the diff.",
      "ARGUMENTS: focus on regressions",
      "  include edge cases",
    ].join("\n");

    expect(parseSkillInvocationPrompt(prompt)).toMatchObject({
      name: "review",
      content: "# Review\nRead the diff.",
      userMessage: "focus on regressions\n  include edge cases",
    });
  });

  test("does not treat mismatched raw slash frontmatter as a complete skill prompt", () => {
    const prompt = ["/review", "---", "name: other", "description: Other skill", "---", "body"].join("\n");

    expect(parseSkillInvocationPrompt(prompt)).toBeNull();
  });

  test("still compacts mismatched raw slash frontmatter for ACP echo display", () => {
    const prompt = ["/review focus", "---", "name: other", "description: Other skill", "---", "body"].join("\n");

    expect(skillInvocationDisplay(prompt, { allowPartial: true })).toEqual({
      name: "review",
      userMessage: "focus",
      complete: false,
    });
  });

  test("summarizes partial filesystem skill frontmatter for streaming ACP echoes", () => {
    expect(skillInvocationDisplay("---\nname: review\n", { allowPartial: true })).toEqual({
      name: "review",
      userMessage: undefined,
      complete: false,
    });
  });

  test("formats filesystem skill previews without the expanded body", () => {
    const prompt = [
      "---",
      "name: review",
      "description: Review changes",
      "---",
      "# Review",
      "Read the diff.",
      "ARGUMENTS: focus on regressions",
    ].join("\n");

    expect(formatSkillInvocationPreview(prompt)).toBe("[skill] review — focus on regressions");
  });
});
