import { describe, expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { testRender } from "@opentui/solid";

import { PluginDialogModal } from "../../../src/ui/component/plugin-dialog";
import { getColors } from "../../../src/ui/context/theme";
import type { PluginDialogState } from "../../../src/ui/app/plugin-dialogs";
import type { RelayPluginInfo } from "../../../src/plugins";

const plugin: RelayPluginInfo = { id: "plugin", name: "Dialog Plugin", path: "/plugin" };

describe("PluginDialogModal", () => {
  test("renders a confirm dialog with selected action hints", async () => {
    const colors = getColors();
    const [dialog] = createSignal<PluginDialogState | null>({
      id: 1,
      kind: "confirm",
      plugin,
      title: "Deploy",
      message: "Deploy to production?",
      selectedIndex: 1,
      confirmLabel: "Deploy",
      cancelLabel: "Cancel",
    });
    let app: Awaited<ReturnType<typeof testRender>> | undefined;

    try {
      app = await testRender(
        () => (
          <box width="100%" height="100%" backgroundColor={colors.bg}>
            <PluginDialogModal dialog={dialog} onCancel={() => {}} />
          </box>
        ),
        { width: 90, height: 24, targetFps: 30 },
      );

      await app.renderOnce();
      const frame = app.captureCharFrame();

      expect(frame).toContain("Deploy");
      expect(frame).toContain("Dialog Plugin");
      expect(frame).toContain("Deploy to production?");
      expect(frame).toContain("Cancel");
      expect(frame).toContain(" Deploy ");
      expect(frame).not.toContain("› Deploy");
      expect(frame).not.toContain("[ Deploy ]");
      expect(frame).toContain("←/→ · enter · y/n · esc");

      const lines = frame.split("\n");
      const titleRow = lines.findIndex((line) => line.includes("Deploy") && line.includes("Dialog Plugin"));
      const messageRow = lines.findIndex((line) => line.includes("Deploy to production?"));
      const actionRow = lines.findIndex((line) => line.includes("Cancel") && line.includes(" Deploy "));
      const footerRow = lines.findIndex((line) => line.includes("←/→ · enter · y/n · esc"));
      expect(messageRow - titleRow).toBe(2);
      expect(actionRow - messageRow).toBe(2);
      expect(footerRow - actionRow).toBe(1);
    } finally {
      app?.renderer.destroy();
    }
  });

  test("renders input text with cursor and placeholder", async () => {
    const colors = getColors();
    const [dialog, setDialog] = createSignal<PluginDialogState | null>({
      id: 2,
      kind: "input",
      plugin,
      title: "Environment",
      placeholder: "prod",
      value: "stae",
      cursorOffset: 3,
    });
    let app: Awaited<ReturnType<typeof testRender>> | undefined;

    try {
      app = await testRender(
        () => (
          <box width="100%" height="100%" backgroundColor={colors.bg}>
            <PluginDialogModal dialog={dialog} onCancel={() => {}} />
          </box>
        ),
        { width: 80, height: 18, targetFps: 30 },
      );

      await app.renderOnce();
      expect(app.captureCharFrame()).toContain("sta▌e");

      setDialog({
        id: 3,
        kind: "input",
        plugin,
        title: "Environment",
        placeholder: "prod",
        value: "",
        cursorOffset: 0,
      });
      await app.renderOnce();
      expect(app.captureCharFrame()).toContain("▌prod");
    } finally {
      app?.renderer.destroy();
    }
  });
});
