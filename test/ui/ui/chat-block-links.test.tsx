import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { ChatBlockView } from "../../../src/ui/component/blocks/chat-block";
import { createAppStateValue } from "../../../src/ui/context/app-state";
import { AppContext } from "../../../src/ui/state";
import { ToastProvider } from "../../../src/ui/ui/toast";
import type { ElicitationBlock } from "../../../src/ui/state";

const LONG_URL =
  "https://example.com/relay-wrapped-url-test/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/WRAP_SENTINEL_END";

type RenderedContentBlock = Awaited<ReturnType<typeof testRender>>;

async function renderContentBlock(content: string, width = 60, height = 10): Promise<RenderedContentBlock> {
  const appState = createAppStateValue(process.cwd());
  const app = await testRender(
    () => (
      <ToastProvider>
        <AppContext.Provider value={appState}>
          <box width={width} height={height} flexDirection="column">
            <ChatBlockView
              block={{ type: "content", id: "c1", content, finalized: false }}
              prevBlock={{ type: "user", id: "u1", content: "hi" }}
              activeProfile="default"
              hideThinking={() => false}
              approvalOptionIndex={() => 0}
              elicitationOptionIndex={() => 0}
              getSpinnerChar={() => "⠋"}
              pluginRunner={() => null}
              selectElicitationChoice={(_app, _block: ElicitationBlock) => {}}
            />
          </box>
        </AppContext.Provider>
      </ToastProvider>
    ),
    { width, height },
  );

  await app.renderOnce();
  await app.flush();
  return app;
}

function nativeLinkMetadata(app: RenderedContentBlock): {
  linkIds: Set<number>;
  linkedUrls: Set<string>;
  linkedCellCount: number;
} {
  const renderer = app.renderer as unknown as {
    readonly currentRenderBuffer?: {
      readonly buffers?: { readonly attributes?: unknown };
    };
    readonly lib: {
      readonly attributesGetLinkId: (attribute: number) => number;
      readonly linkGetUrl: (id: number) => string;
    };
  };
  const attributes = renderer.currentRenderBuffer?.buffers?.attributes;
  expect(attributes).toBeInstanceOf(Uint32Array);

  const linkIds = new Set<number>();
  const linkedUrls = new Set<string>();
  let linkedCellCount = 0;
  for (const attribute of attributes as Uint32Array) {
    const linkId = renderer.lib.attributesGetLinkId(attribute);
    if (linkId <= 0) continue;
    linkedCellCount += 1;
    linkIds.add(linkId);

    const linkedUrl = renderer.lib.linkGetUrl(linkId);
    // OpenTUI's test renderer can expose a non-zero link id whose URL registry
    // resolves empty after other UI tests have run in the same Bun process.
    // When the registry has a value, it must still be the expected URL.
    if (linkedUrl) linkedUrls.add(linkedUrl);
  }

  return { linkIds, linkedUrls, linkedCellCount };
}

describe("chat block links", () => {
  test("renders a wrapped bare URL with native terminal link metadata", async () => {
    const app = await renderContentBlock(LONG_URL);

    try {
      const frame = app.captureCharFrame();
      expect(frame.match(/https:\/\/example\.com/g)).toHaveLength(1);
      expect(frame).toContain("WRAP_SENTINEL_END");

      const { linkIds, linkedUrls, linkedCellCount } = nativeLinkMetadata(app);
      expect(linkIds.size).toBeGreaterThanOrEqual(1);
      expect(linkedCellCount).toBeGreaterThan(LONG_URL.length - 5);
      if (linkedUrls.size > 0) expect(linkedUrls).toEqual(new Set([LONG_URL]));
    } finally {
      app.renderer.destroy();
    }
  });

  test("keeps bare URLs linked when plain prose contains single underscore or tilde", async () => {
    const app = await renderContentBlock(`tool_name ~backup ${LONG_URL}`, 80, 8);

    try {
      const frame = app.captureCharFrame();
      expect(frame).toContain("tool_name ~backup");
      expect(frame).toContain("WRAP_SENTINEL_END");

      const { linkIds, linkedUrls, linkedCellCount } = nativeLinkMetadata(app);
      expect(linkIds.size).toBeGreaterThanOrEqual(1);
      expect(linkedCellCount).toBeGreaterThan(LONG_URL.length - 5);
      if (linkedUrls.size > 0) expect(linkedUrls).toEqual(new Set([LONG_URL]));
    } finally {
      app.renderer.destroy();
    }
  });
});
