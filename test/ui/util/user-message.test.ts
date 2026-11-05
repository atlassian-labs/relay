import { describe, expect, test } from "bun:test";
import type { UserBlock } from "../../../src/ui/state";
import {
  formatUserBlockPreview,
  promptTitleIntentFromText,
  promptTitleIntentFromUserBlock,
  skillInvocationsMatch,
  userBlockSkillInvocation,
  type UserPromptTitleIntent,
  type UserPromptTitleQuality,
  type UserPromptTitleReason,
  type UserPromptTitleSource,
} from "../../../src/ui/util/user-message";

function userBlock(content: string, overrides: Partial<UserBlock> = {}): UserBlock {
  return {
    type: "user",
    id: "user-1",
    content,
    ...overrides,
  };
}

function expectedIntent(input: {
  label: string;
  quality: UserPromptTitleQuality;
  source?: UserPromptTitleSource;
  reason: UserPromptTitleReason;
  bareSkillTrigger?: boolean;
}): UserPromptTitleIntent {
  const quality = input.quality;
  return {
    label: input.label,
    quality,
    source: input.source ?? "prompt",
    reason: input.reason,
    bareSkillTrigger: input.bareSkillTrigger ?? false,
  };
}

describe("user message display helpers", () => {
  test("does not infer local skill display from ordinary frontmatter-shaped prompts", () => {
    const block = userBlock("---\ndescription: release notes\n---\nActual user prompt", { origin: "local" });

    expect(userBlockSkillInvocation(block)).toBeNull();
    expect(formatUserBlockPreview(block)).toBeNull();
  });

  test("uses explicit local skill invocation echoes without parsing raw slash content", () => {
    const block = userBlock("/review and do it good", {
      origin: "local",
      skillInvocation: { name: "review", userMessage: "and do it good" },
    });

    expect(userBlockSkillInvocation(block)).toEqual({ name: "review", userMessage: "and do it good" });
    expect(formatUserBlockPreview(block)).toBe("[skill] review — and do it good");
  });

  test("keeps raw local slash prompts plain unless legacy dedupe opts in", () => {
    const block = userBlock("/review and do it good", { origin: "local" });

    expect(userBlockSkillInvocation(block)).toBeNull();
    expect(formatUserBlockPreview(block)).toBeNull();
    expect(userBlockSkillInvocation(block, { allowLocalSlash: true })).toEqual({
      name: "review",
      userMessage: "and do it good",
    });
  });

  test("classifies prompt title intent with quality, source, and replacement metadata", () => {
    const cases: Array<{
      name: string;
      text: string;
      skill?: { name: string; userMessage?: string };
      expected: UserPromptTitleIntent;
    }> = [
      {
        name: "plain meaningful prompt",
        text: "fix tests",
        expected: expectedIntent({ label: "fix tests", quality: "strong", reason: "meaningful" }),
      },
      {
        name: "low-signal acknowledgement",
        text: "ok.",
        expected: expectedIntent({ label: "ok.", quality: "low-signal", reason: "low-signal" }),
      },
      {
        name: "acknowledgement prefix with real instruction",
        text: "yes, run typecheck",
        expected: expectedIntent({ label: "run typecheck", quality: "strong", reason: "acknowledgement-prefix" }),
      },
      {
        name: "constraint word is preserved with comma",
        text: "no, use first prompt",
        expected: expectedIntent({ label: "no, use first prompt", quality: "strong", reason: "meaningful" }),
      },
      {
        name: "constraint phrase is preserved with whitespace",
        text: "no code changes, just explain",
        expected: expectedIntent({ label: "no code changes, just explain", quality: "strong", reason: "meaningful" }),
      },
      {
        name: "single-letter word is preserved",
        text: "y axis label is cut off",
        expected: expectedIntent({ label: "y axis label is cut off", quality: "strong", reason: "meaningful" }),
      },
      {
        name: "acknowledgement prefix with remaining low signal",
        text: "yes, run it",
        expected: expectedIntent({ label: "run it", quality: "low-signal", reason: "low-signal" }),
      },
      {
        name: "bare skill fallback",
        text: "/review",
        skill: { name: "review" },
        expected: expectedIntent({
          label: "Review session",
          quality: "fallback",
          source: "skill",
          reason: "bare-skill",
          bareSkillTrigger: true,
        }),
      },
      {
        name: "hyphenated bare skill fallback",
        text: "/fix-failures",
        skill: { name: "fix-failures" },
        expected: expectedIntent({
          label: "Fix failures session",
          quality: "fallback",
          source: "skill",
          reason: "bare-skill",
          bareSkillTrigger: true,
        }),
      },
      {
        name: "skill with arguments",
        text: "/review focus",
        skill: { name: "review", userMessage: "focus" },
        expected: expectedIntent({ label: "review — focus", quality: "strong", source: "skill", reason: "meaningful" }),
      },
      {
        name: "image marker stripped from meaningful prompt",
        text: "fix this [image #1 screenshot.png]",
        expected: expectedIntent({ label: "fix this", quality: "strong", reason: "meaningful" }),
      },
      {
        name: "image-only prompt is empty for title purposes",
        text: "[image #1 screenshot.png]",
        expected: expectedIntent({ label: "", quality: "empty", reason: "empty" }),
      },
      {
        name: "paste marker stripped from meaningful prompt",
        text: "summarize [paste #2 +14 lines - notes.md]",
        expected: expectedIntent({ label: "summarize", quality: "strong", reason: "meaningful" }),
      },
      {
        name: "multiline prompts are compacted",
        text: "fix\n\n  the failing test",
        expected: expectedIntent({ label: "fix the failing test", quality: "strong", reason: "meaningful" }),
      },
      {
        name: "unicode prompts remain titleable",
        text: "résoudre l’échec du test",
        expected: expectedIntent({ label: "résoudre l’échec du test", quality: "strong", reason: "meaningful" }),
      },
      {
        name: "whitespace-only prompt is empty",
        text: " \n\t ",
        expected: expectedIntent({ label: "", quality: "empty", reason: "empty" }),
      },
    ];

    for (const item of cases) {
      expect(promptTitleIntentFromText(item.text, item.skill), item.name).toEqual(item.expected);
    }
  });

  test("derives prompt title intent from ACP skill blocks but not current-turn guidance", () => {
    const block = userBlock(
      [
        "---",
        "name: review",
        "description: Review changes",
        "register_cmd: true",
        "---",
        "ARGUMENTS: focus on regressions",
      ].join("\n"),
      { origin: "acp" },
    );

    expect(promptTitleIntentFromUserBlock(block)).toEqual(
      expectedIntent({
        label: "review — focus on regressions",
        quality: "strong",
        source: "skill",
        reason: "meaningful",
      }),
    );
    expect(promptTitleIntentFromUserBlock({ ...block, delivery: "current-turn-guidance" })).toBeNull();
  });

  test("matches skill echoes by normalized name while preserving argument differences", () => {
    expect(
      skillInvocationsMatch(
        { name: "Review Skill", userMessage: "  same args\r\n" },
        { name: "review-skill", userMessage: "same args" },
      ),
    ).toBe(true);
    expect(
      skillInvocationsMatch({ name: "review", userMessage: "old args" }, { name: "review", userMessage: "new args" }),
    ).toBe(false);
  });

  test("infers ACP skill display from raw filesystem skill echoes", () => {
    const block = userBlock(
      [
        "---",
        "name: review",
        "description: Review changes",
        "register_cmd: true",
        "---",
        "",
        "Review the code directly.",
        "",
        "ARGUMENTS: and do it good",
      ].join("\n"),
      { origin: "acp" },
    );

    expect(userBlockSkillInvocation(block)).toEqual({ name: "review", userMessage: "and do it good" });
    expect(formatUserBlockPreview(block)).toBe("[skill] review — and do it good");
  });

  test("keeps skill-shaped current-turn updates literal", () => {
    const block = userBlock(
      [
        '<skill name="review" location="/tmp/review/SKILL.md">',
        "Review the code directly.",
        "</skill>",
        "",
        "focus on regressions",
      ].join("\n"),
      { delivery: "current-turn-guidance", origin: "local" },
    );

    expect(userBlockSkillInvocation(block)).toBeNull();
    expect(formatUserBlockPreview(block)).toBeNull();
  });
});
