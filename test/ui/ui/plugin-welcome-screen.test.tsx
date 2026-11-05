import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { PluginWelcomeScreen } from "../../../src/ui/component/plugin-welcome-screen";
import type { RelayWidgetEntry } from "../../../src/plugins/slots";
import {
  FAUX_BUNDLED_PLUGIN_ENTRY_ID,
  FAUX_BUNDLED_PLUGIN_NAME,
  FAUX_BUNDLED_PLUGIN_PATH,
} from "../../lib/faux-bundled-plugin";

const fauxBundledPluginInfo = {
  id: FAUX_BUNDLED_PLUGIN_ENTRY_ID,
  name: FAUX_BUNDLED_PLUGIN_NAME,
  path: FAUX_BUNDLED_PLUGIN_PATH,
};

function widgetEntry(text: string, priority = 0, href?: string, ctrlHref?: string): RelayWidgetEntry {
  return {
    plugin: fauxBundledPluginInfo,
    key: text,
    order: priority,
    focused: false,
    hidden: false,
    widget: {
      placement: "welcome",
      priority,
      title: "Plugin welcome",
      render: () => [{ text, href, ctrlHref }],
    },
  };
}

describe("PluginWelcomeScreen", () => {
  test("renders the highest-priority welcome widget in a bordered panel", async () => {
    const widgets = [widgetEntry("second", 10), widgetEntry("first", -1)];
    const app = await testRender(
      () => (
        <box width="100%" height="100%">
          <PluginWelcomeScreen widgets={() => widgets} />
        </box>
      ),
      { width: 60, height: 8, targetFps: 30 },
    );

    try {
      await app.renderOnce();
      const frame = app.captureCharFrame();
      expect(frame).toContain("Plugin welcome");
      expect(frame).toContain("first");
      expect(frame).not.toContain("second");
    } finally {
      app.renderer.destroy();
    }
  });

  test("opens line hrefs on click", async () => {
    const openedUrls: string[] = [];
    const widgets = [widgetEntry("clickable", 0, "https://example.com/story")];
    const app = await testRender(
      () => (
        <box width="100%" height="100%">
          <PluginWelcomeScreen widgets={() => widgets} openUrl={(url) => openedUrls.push(url)} />
        </box>
      ),
      { width: 60, height: 8, targetFps: 30 },
    );

    try {
      await app.renderOnce();
      await app.mockMouse.click(4, 3);
      expect(openedUrls).toEqual(["https://example.com/story"]);
    } finally {
      app.renderer.destroy();
    }
  });

  test("runs line onClick on click instead of opening href", async () => {
    const openedUrls: string[] = [];
    let clickCount = 0;
    const widgets: RelayWidgetEntry[] = [
      {
        plugin: fauxBundledPluginInfo,
        key: "clickable",
        order: 0,
        focused: false,
        hidden: false,
        widget: {
          placement: "welcome",
          title: "Plugin welcome",
          render: () => [
            {
              text: "clickable",
              href: "https://example.com/story",
              onClick: () => {
                clickCount += 1;
              },
            },
          ],
        },
      },
    ];
    const app = await testRender(
      () => (
        <box width="100%" height="100%">
          <PluginWelcomeScreen widgets={() => widgets} openUrl={(url) => openedUrls.push(url)} />
        </box>
      ),
      { width: 60, height: 8, targetFps: 30 },
    );

    try {
      await app.renderOnce();
      await app.mockMouse.click(4, 3);
      expect(clickCount).toBe(1);
      expect(openedUrls).toEqual([]);
    } finally {
      app.renderer.destroy();
    }
  });

  test("opens ctrlHref on ctrl-click", async () => {
    const openedUrls: string[] = [];
    const widgets = [
      widgetEntry("clickable", 0, "https://example.com/story", "https://news.ycombinator.com/item?id=1"),
    ];
    const app = await testRender(
      () => (
        <box width="100%" height="100%">
          <PluginWelcomeScreen widgets={() => widgets} openUrl={(url) => openedUrls.push(url)} />
        </box>
      ),
      { width: 60, height: 8, targetFps: 30 },
    );

    try {
      await app.renderOnce();
      await app.mockMouse.click(4, 3, 0, { modifiers: { ctrl: true } });
      expect(openedUrls).toEqual(["https://news.ycombinator.com/item?id=1"]);
    } finally {
      app.renderer.destroy();
    }
  });
});
