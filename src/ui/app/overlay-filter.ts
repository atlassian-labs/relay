import type { ListItem } from "../autocomplete";

export function fuzzyMatchScore(query: string, value: string): number | null {
  const normalizedQuery = query.toLowerCase();
  const normalizedValue = value.toLowerCase();

  function match(candidate: string): number | null {
    if (!candidate) return 0;
    if (candidate.length > normalizedValue.length) return null;

    let queryIndex = 0;
    let score = 0;
    let lastMatchIndex = -1;
    let consecutiveMatches = 0;

    for (let valueIndex = 0; valueIndex < normalizedValue.length && queryIndex < candidate.length; valueIndex++) {
      if (normalizedValue[valueIndex] !== candidate[queryIndex]) continue;

      const isWordBoundary = valueIndex === 0 || /[\s\-_./:]/.test(normalizedValue[valueIndex - 1] ?? "");
      if (lastMatchIndex === valueIndex - 1) {
        consecutiveMatches++;
        score -= consecutiveMatches * 5;
      } else {
        consecutiveMatches = 0;
        if (lastMatchIndex >= 0) score += (valueIndex - lastMatchIndex - 1) * 2;
      }
      if (isWordBoundary) score -= 10;
      score += valueIndex * 0.1;

      lastMatchIndex = valueIndex;
      queryIndex++;
    }

    if (queryIndex < candidate.length) return null;
    return candidate === normalizedValue ? score - 100 : score;
  }

  const primaryScore = match(normalizedQuery);
  if (primaryScore !== null) return primaryScore;

  const alphaNumericMatch = normalizedQuery.match(/^(?<letters>[a-z]+)(?<digits>[0-9]+)$/);
  const numericAlphaMatch = normalizedQuery.match(/^(?<digits>[0-9]+)(?<letters>[a-z]+)$/);
  const swappedQuery = alphaNumericMatch
    ? `${alphaNumericMatch.groups?.digits ?? ""}${alphaNumericMatch.groups?.letters ?? ""}`
    : numericAlphaMatch
      ? `${numericAlphaMatch.groups?.letters ?? ""}${numericAlphaMatch.groups?.digits ?? ""}`
      : "";
  if (!swappedQuery) return null;

  const swappedScore = match(swappedQuery);
  return swappedScore === null ? null : swappedScore + 5;
}

function scoredListItems<T>(
  items: ListItem<T>[],
  query: string,
  options: { includeDescription?: boolean },
): Array<{ item: ListItem<T>; score: number }> {
  const tokens = query
    .trim()
    .split(/[\s/]+/)
    .filter((token) => token.length > 0);
  if (tokens.length === 0) return items.map((item) => ({ item, score: 0 }));

  return items
    .map((item) => {
      const searchLabel = item.searchLabel ?? item.label;
      const searchText = options.includeDescription === false ? searchLabel : `${searchLabel} ${item.description}`;
      const scores = tokens.map((token) => fuzzyMatchScore(token, searchText));
      return {
        item,
        score: scores.every((score): score is number => score !== null)
          ? scores.reduce((total, score) => total + score, 0)
          : null,
      };
    })
    .filter((entry): entry is { item: ListItem<T>; score: number } => entry.score !== null);
}

export function filterListItems<T>(
  items: ListItem<T>[],
  query: string,
  options: { includeDescription?: boolean } = {},
): ListItem<T>[] {
  return scoredListItems(items, query, options)
    .sort((a, b) => a.score - b.score)
    .map((entry) => entry.item);
}

export function filterListItemsInOrder<T>(
  items: ListItem<T>[],
  query: string,
  options: { includeDescription?: boolean } = {},
): ListItem<T>[] {
  return scoredListItems(items, query, options).map((entry) => entry.item);
}

export function filterListItemsBySubstringInOrder<T>(
  items: ListItem<T>[],
  query: string,
  options: { includeDescription?: boolean } = {},
): ListItem<T>[] {
  const tokens = query.toLowerCase().split(/\s+/u).filter(Boolean);
  if (tokens.length === 0) return items;
  return items.filter((item) => {
    const searchLabel = item.searchLabel ?? item.label;
    const searchText = (
      options.includeDescription === false ? searchLabel : `${searchLabel} ${item.description}`
    ).toLowerCase();
    return tokens.every((token) => searchText.includes(token));
  });
}

export function orderedOverlayIndexAfterFilter<T>(
  allItems: ListItem<T>[],
  filteredItems: ListItem<T>[],
  previousValue: T | undefined,
): number {
  if (filteredItems.length === 0) return 0;
  if (previousValue === undefined) return 0;

  const preservedIndex = filteredItems.findIndex((item) => item.value === previousValue);
  if (preservedIndex >= 0) return preservedIndex;

  const previousIndex = allItems.findIndex((item) => item.value === previousValue);
  if (previousIndex < 0) return filteredItems.length - 1;
  for (let index = filteredItems.length - 1; index >= 0; index--) {
    if (allItems.indexOf(filteredItems[index]) <= previousIndex) return index;
  }
  return filteredItems.length - 1;
}

export function overlayIndexAfterFilter<T>(
  filteredItems: ListItem<T>[],
  previousValue: T | undefined,
  resetToFirst: boolean,
): number {
  if (resetToFirst) return 0;
  const preservedIndex =
    previousValue !== undefined ? filteredItems.findIndex((item) => item.value === previousValue) : -1;
  return preservedIndex >= 0 ? preservedIndex : 0;
}
