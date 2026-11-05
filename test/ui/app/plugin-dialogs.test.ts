import { describe, expect, test } from "bun:test";

import { createPluginDialogController, type PluginDialogKeyboardEvent } from "../../../src/ui/app/plugin-dialogs";
import type { RelayPluginInfo } from "../../../src/plugins";

const plugin: RelayPluginInfo = { id: "plugin", name: "Dialog Plugin", path: "/plugin" };

function key(
  name: string,
  sequence = name,
  overrides: Partial<PluginDialogKeyboardEvent> = {},
): PluginDialogKeyboardEvent {
  return {
    name,
    sequence,
    ctrl: false,
    meta: false,
    option: false,
    alt: false,
    ...overrides,
  };
}

describe("createPluginDialogController", () => {
  test("confirm resolves the selected action", async () => {
    const controller = createPluginDialogController();
    const result = controller.confirm(plugin, "Deploy", "Deploy to production?", { confirmLabel: "Deploy" });

    expect(controller.current()).toMatchObject({ kind: "confirm", selectedIndex: 0 });
    controller.handleKey(key("right"));
    expect(controller.current()).toMatchObject({ kind: "confirm", selectedIndex: 1 });
    controller.handleKey(key("return", "\r"));

    await expect(result).resolves.toBe(true);
    expect(controller.current()).toBeNull();
  });

  test("input edits text and resolves on enter", async () => {
    const controller = createPluginDialogController();
    const result = controller.input(plugin, "Environment", "prod");

    for (const character of "stage") controller.handleKey(key(character, character));
    controller.handleKey(key("backspace", "\b"));
    controller.handleKey(key("return", "\r"));

    await expect(result).resolves.toBe("stag");
  });

  test("input supports word and line movement and deletion modifiers", async () => {
    const controller = createPluginDialogController();
    const result = controller.input(plugin, "Search", "", { defaultValue: "alpha beta gamma" });

    controller.handleKey(key("left", undefined, { option: true }));
    expect(controller.current()).toMatchObject({ kind: "input", cursorOffset: 11 });
    controller.handleKey(key("backspace", undefined, { option: true }));
    expect(controller.current()).toMatchObject({ kind: "input", value: "alpha gamma", cursorOffset: 6 });
    controller.handleKey(key("right", undefined, { meta: true }));
    expect(controller.current()).toMatchObject({ kind: "input", cursorOffset: 11 });
    controller.handleKey(key("backspace", undefined, { meta: true }));
    expect(controller.current()).toMatchObject({ kind: "input", value: "", cursorOffset: 0 });
    controller.handleKey(key("return", "\r"));

    await expect(result).resolves.toBe("");
  });

  test("select resolves the highlighted item", async () => {
    const controller = createPluginDialogController();
    const result = controller.select(plugin, "Pick", [
      { value: "dev", label: "Development" },
      { value: "prod", label: "Production" },
    ]);

    controller.handleKey(key("down"));
    controller.handleKey(key("return", "\r"));

    await expect(result).resolves.toBe("prod");
  });

  test("clearPlugin cancels active and queued dialogs for that plugin", async () => {
    const controller = createPluginDialogController();
    const otherPlugin: RelayPluginInfo = { id: "other", name: "Other", path: "/other" };
    const first = controller.confirm(plugin, "First", "first");
    const second = controller.input(plugin, "Second");
    const third = controller.confirm(otherPlugin, "Third", "third", { defaultValue: true });

    controller.clearPlugin(plugin);

    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBeUndefined();
    expect(controller.current()).toMatchObject({ kind: "confirm", plugin: otherPlugin });
    controller.handleKey(key("return", "\r"));
    await expect(third).resolves.toBe(true);
  });

  test("abort signal dismisses a pending dialog", async () => {
    const controller = createPluginDialogController();
    const abortController = new AbortController();
    const result = controller.input(plugin, "Value", "", { signal: abortController.signal });

    abortController.abort();

    await expect(result).resolves.toBeUndefined();
    expect(controller.current()).toBeNull();
  });
});
