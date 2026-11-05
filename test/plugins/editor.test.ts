import { describe, expect, test } from "bun:test";
import { RelayPluginEditorRegistry } from "../../src/plugins/editor";
import type { RelayPluginInfo } from "../../src/plugins/types";

const PLUGIN: RelayPluginInfo = {
  id: "global:test",
  name: "test",
  path: "/tmp/test-plugin.mjs",
};

describe("RelayPluginEditorRegistry", () => {
  test("ignores unknown and invalid plugin theme values", () => {
    const editor = new RelayPluginEditorRegistry();

    editor.setTheme(PLUGIN, {
      borderColor: "#123456",
      textColor: 42,
      mysteryColor: "#abcdef",
    } as never);

    expect(editor.state().theme).toEqual({ borderColor: "#123456" });
  });

  test("preserves explicit undefined theme values so plugins can clear overrides", () => {
    const editor = new RelayPluginEditorRegistry();

    editor.setTheme(PLUGIN, { cursorColor: "#40c4ff" });
    editor.setTheme(PLUGIN, { cursorColor: undefined });

    expect(editor.state().theme).toEqual({ cursorColor: undefined });
  });
});
