import { fuzzyMatch, type CompletionResult, type ListItem } from "../autocomplete";
import type { SessionConfigOptionState, SessionThinkingLevelOption } from "../state";
import { isThinkingConfigOption, thinkingLevelLabel, type ThinkingLevel } from "../../core/thinking";

export const REASONING_EFFORT_TITLE = "Reasoning effort";

type InsertTextCompletion = {
  readonly insertText?: string;
};

export function isThoughtLevelConfigOption(option: SessionConfigOptionState): boolean {
  return isThinkingConfigOption(option.category, option.id);
}

function effortArgumentToken(text: string): { query: string; tokenStart: number } | null {
  const command = text.match(/^\/(?:effort|thinking)/u)?.[0];
  if (!command) return null;

  const afterCommand = text.slice(command.length);
  if (!/^\s/.test(afterCommand)) return null;

  const leadingWhitespace = afterCommand.match(/^\s+/)?.[0] ?? "";
  const query = afterCommand.slice(leadingWhitespace.length);
  if (/\s/.test(query)) return null;

  return {
    query,
    tokenStart: command.length + leadingWhitespace.length,
  };
}

export function getReasoningEffortSuggestions(
  text: string,
  levels: readonly SessionThinkingLevelOption[],
  currentThinkingLevel: ThinkingLevel | "",
): CompletionResult<InsertTextCompletion> | null {
  const token = effortArgumentToken(text);
  if (!token) return null;

  const query = token.query.toLowerCase();
  const scored: { item: ListItem<InsertTextCompletion>; score: number; index: number }[] = levels.flatMap(
    (level, index) => {
      const label = thinkingLevelLabel(level.id);
      const name = level.name || label;
      const valueMatch = fuzzyMatch(query, level.id);
      const nameMatch = fuzzyMatch(query, name);
      if (!valueMatch.matched && !nameMatch.matched) return [];

      return [
        {
          item: {
            value: { insertText: level.id },
            label: level.id,
            description: [name, level.description, level.id === currentThinkingLevel ? "current" : undefined]
              .filter(Boolean)
              .join(" · "),
            active: level.id === currentThinkingLevel,
          },
          score: Math.max(valueMatch.score, nameMatch.score),
          index,
        },
      ];
    },
  );

  if (scored.length === 0) return null;
  scored.sort((a, b) => b.score - a.score || a.index - b.index);

  return {
    items: scored.map((entry) => entry.item),
    tokenStart: token.tokenStart,
    query: token.query,
    kind: "slash-argument",
  };
}
