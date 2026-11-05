import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { WelcomeAddonWidgets } from "../../../src/ui/component/welcome-screen";
import type { RelayWidgetRenderContext } from "../../../src/plugins/types";
import type { RelayWidgetEntry } from "../../../src/plugins/slots";

function widgetEntry(render: RelayWidgetEntry["widget"]["render"]): RelayWidgetEntry {
  return {
    plugin: { id: "test", name: "test", path: "test" },
    key: "addon",
    order: 1,
    focused: false,
    hidden: false,
    widget: {
      placement: "welcomeAddon",
      render,
    },
  };
}

describe("WelcomeAddonWidgets", () => {
  test("renders addon lines and passes welcomeAddon render context", async () => {
    let seenContext: RelayWidgetRenderContext | undefined;
    const widgets = [
      widgetEntry((ctx) => {
        seenContext = ctx;
        return [{ text: "example addon" }];
      }),
    ];
    const app = await testRender(
      () => (
        <box width="100%" height="100%">
          <WelcomeAddonWidgets widgets={() => widgets} />
        </box>
      ),
      { width: 60, height: 8, targetFps: 30 },
    );

    try {
      await app.renderOnce();
      const frame = app.captureCharFrame();
      expect(frame).toContain("example addon");
      expect(seenContext).toMatchObject({ placement: "welcomeAddon", width: 60, height: 8 });
    } finally {
      app.renderer.destroy();
    }
  });

  test("opens line hrefs on click", async () => {
    const openedUrls: string[] = [];
    const widgets = [
      widgetEntry(() => [
        {
          text: "dashboard",
          href: "https://example.test/dashboard",
        },
      ]),
    ];
    const app = await testRender(
      () => (
        <box width="100%" height="100%">
          <WelcomeAddonWidgets widgets={() => widgets} openUrl={(url) => openedUrls.push(url)} />
        </box>
      ),
      { width: 60, height: 8, targetFps: 30 },
    );

    try {
      await app.renderOnce();
      await app.mockMouse.click(1, 1);
      expect(openedUrls).toEqual(["https://example.test/dashboard"]);
    } finally {
      app.renderer.destroy();
    }
  });

  test("runs line onClick on click instead of opening href", async () => {
    const openedUrls: string[] = [];
    let clickCount = 0;
    const widgets = [
      widgetEntry(() => [
        {
          text: "details",
          href: "https://example.test/dashboard",
          onClick: () => {
            clickCount += 1;
          },
        },
      ]),
    ];
    const app = await testRender(
      () => (
        <box width="100%" height="100%">
          <WelcomeAddonWidgets widgets={() => widgets} openUrl={(url) => openedUrls.push(url)} />
        </box>
      ),
      { width: 60, height: 8, targetFps: 30 },
    );

    try {
      await app.renderOnce();
      await app.mockMouse.click(1, 1);
      expect(clickCount).toBe(1);
      expect(openedUrls).toEqual([]);
    } finally {
      app.renderer.destroy();
    }
  });

  test("opens ctrlHref on ctrl-click", async () => {
    const openedUrls: string[] = [];
    const widgets = [
      widgetEntry(() => [
        {
          text: "dashboard",
          href: "https://example.test/dashboard",
          ctrlHref: "https://example.test/ctrl",
        },
      ]),
    ];
    const app = await testRender(
      () => (
        <box width="100%" height="100%">
          <WelcomeAddonWidgets widgets={() => widgets} openUrl={(url) => openedUrls.push(url)} />
        </box>
      ),
      { width: 60, height: 8, targetFps: 30 },
    );

    try {
      await app.renderOnce();
      await app.mockMouse.click(1, 1, 0, { modifiers: { ctrl: true } });
      expect(openedUrls).toEqual(["https://example.test/ctrl"]);
    } finally {
      app.renderer.destroy();
    }
  });

  test("routes clicks to actionable line segments", async () => {
    const openedUrls: string[] = [];
    let refreshCount = 0;
    const widgets = [
      widgetEntry(() => [
        {
          text: "dashboard ↗ · refresh ⟳ · /example",
          segments: [
            { text: "dashboard ↗", href: "https://example.test/dashboard" },
            { text: " · " },
            {
              text: "refresh ⟳",
              onClick: () => {
                refreshCount += 1;
              },
            },
            { text: " · /example" },
          ],
        },
      ]),
    ];
    const app = await testRender(
      () => (
        <box width="100%" height="100%">
          <WelcomeAddonWidgets widgets={() => widgets} openUrl={(url) => openedUrls.push(url)} />
        </box>
      ),
      { width: 60, height: 8, targetFps: 30 },
    );

    try {
      await app.renderOnce();
      await app.mockMouse.click(1, 1);
      await app.mockMouse.click(15, 1);
      expect(openedUrls).toEqual(["https://example.test/dashboard"]);
      expect(refreshCount).toBe(1);
    } finally {
      app.renderer.destroy();
    }
  });
});
