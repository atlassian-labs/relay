import { describe, expect, test } from "bun:test";
import { buildThemeItems } from "../../../src/ui/app/settings-overlay-controller";

describe("settings theme items", () => {
  test("lists custom theme options with their labels", () => {
    const items = buildThemeItems("paper-cuts", [
      ["catppuccin-mocha", "Catppuccin Mocha"],
      ["paper-cuts", "Paper Cuts"],
    ]);

    expect(items).toEqual([
      {
        value: "catppuccin-mocha",
        label: "catppuccin-mocha",
        description: "Catppuccin Mocha",
        active: false,
      },
      {
        value: "paper-cuts",
        label: "paper-cuts",
        description: "Paper Cuts",
        active: true,
      },
    ]);
  });
});
