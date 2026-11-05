import { describe, expect, test } from "bun:test";
import { Config } from "../../../src/config";
import type { ListItem } from "../../../src/ui/autocomplete";
import {
  filterListItems,
  filterListItemsBySubstringInOrder,
  filterListItemsInOrder,
  fuzzyMatchScore,
  orderedOverlayIndexAfterFilter,
  overlayIndexAfterFilter,
} from "../../../src/ui/app/overlay-filter";
import { buildSettingsItems } from "../../../src/ui/util/settings";

describe("overlay fuzzy filtering", () => {
  test("rewards consecutive matches over scattered matches", () => {
    const consecutive = fuzzyMatchScore("the", "themes");
    const scattered = fuzzyMatchScore("the", "thinking level");

    expect(consecutive).not.toBeNull();
    expect(scattered).not.toBeNull();
    expect(consecutive!).toBeLessThan(scattered!);
  });

  test("requires every whitespace-separated token to match", () => {
    const items: ListItem<string>[] = [
      { value: "theme", label: "automatic theme", description: "" },
      { value: "automatic", label: "automatic mode", description: "" },
    ];

    expect(filterListItems(items, "auto theme").map((item) => item.value)).toEqual(["theme"]);
  });
});

describe("order-preserving filtering", () => {
  const items: ListItem<string>[] = [
    { value: "first", label: "a long b long c", description: "" },
    { value: "second", label: "abc", description: "" },
    { value: "third", label: "another abc", description: "" },
    { value: "fourth", label: "unmatched", description: "" },
  ];

  test("filters without ranking matches", () => {
    expect(filterListItems(items, "abc").map((item) => item.value)).toEqual(["second", "first", "third"]);
    expect(filterListItemsInOrder(items, "abc").map((item) => item.value)).toEqual(["first", "second", "third"]);
  });

  test("uses literal token matching rather than scattered fuzzy matches", () => {
    expect(filterListItemsInOrder(items, "albc").map((item) => item.value)).toEqual(["first"]);
    expect(filterListItemsBySubstringInOrder(items, "albc")).toEqual([]);
    expect(filterListItemsBySubstringInOrder(items, "abc").map((item) => item.value)).toEqual(["second", "third"]);
  });

  test("preserves the cursor or walks back to the nearest matching ancestor", () => {
    const firstAndThird = [items[0], items[2]];

    expect(orderedOverlayIndexAfterFilter(items, firstAndThird, "first")).toBe(0);
    expect(orderedOverlayIndexAfterFilter(items, firstAndThird, "second")).toBe(0);
    expect(orderedOverlayIndexAfterFilter(items, firstAndThird, "fourth")).toBe(1);
    expect(orderedOverlayIndexAfterFilter(items, [], "second")).toBe(0);
  });
});

describe("settings filtering", () => {
  test("ranks themes first for the query from the reported case", () => {
    const items = buildSettingsItems(new Config({}));
    const filtered = filterListItems(items, "the", { includeDescription: false });

    expect(filtered[0]?.label).toStartWith("themes:");
  });

  test("does not match settings through descriptions", () => {
    const items: ListItem<string>[] = [
      { value: "notifications", label: "notifications", description: "choose the UI theme" },
      { value: "themes", label: "themes: dark", description: "choose the UI theme" },
    ];

    expect(filterListItems(items, "theme", { includeDescription: false }).map((item) => item.value)).toEqual([
      "themes",
    ]);
  });

  test("selects the first filtered setting instead of preserving the previous setting", () => {
    const items: ListItem<string>[] = [
      { value: "themes", label: "themes: dark", description: "" },
      { value: "notifications", label: "notifications", description: "" },
    ];

    expect(overlayIndexAfterFilter(items, "notifications", true)).toBe(0);
    expect(overlayIndexAfterFilter(items, "notifications", false)).toBe(1);
  });
});
