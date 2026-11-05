import { attributesWithLink, TextAttributes } from "@opentui/core";
import { describe, expect, test } from "bun:test";
import {
  extractMarkdownLinks,
  getLinkUrlAtScreenPosition,
  shouldRenderLinkedPlainText,
  splitBareUrls,
} from "../../../src/ui/util/links";

type LinkTestRenderer = {
  readonly currentRenderBuffer: {
    readonly width: number;
    readonly height: number;
    readonly buffers: {
      readonly attributes: Uint32Array;
    };
  };
  readonly lib: {
    readonly linkGetUrl: (id: number) => string | null;
    readonly attributesGetLinkId?: (attribute: number) => number;
  };
};

function rendererWithAttributes(
  width: number,
  height: number,
  attributes: Uint32Array,
  urls = new Map<number, string>([[42, "https://example.test/path/that/wraps/across/rows"]]),
): LinkTestRenderer {
  return {
    currentRenderBuffer: {
      width,
      height,
      buffers: { attributes },
    },
    lib: {
      linkGetUrl: (id) => urls.get(id) ?? null,
    },
  };
}

describe("link utilities", () => {
  test("extracts markdown and bare links once", () => {
    expect(
      extractMarkdownLinks(
        "See [Jira](https://jira.example/browse/X) and https://docs.example/x and https://docs.example/x",
      ),
    ).toEqual([
      { label: "Jira", url: "https://jira.example/browse/X" },
      { label: "https://docs.example/x", url: "https://docs.example/x" },
    ]);
  });

  test("splits bare URLs without rewriting explicit markdown links", () => {
    expect(
      splitBareUrls("See https://docs.example/x, then [https://label.example](https://jira.example/browse/X)."),
    ).toEqual([
      { type: "text", text: "See " },
      { type: "url", text: "https://docs.example/x", url: "https://docs.example/x" },
      { type: "text", text: ", then [https://label.example](https://jira.example/browse/X)." },
    ]);
  });

  test("keeps reference-style markdown links on the markdown renderer path", () => {
    expect(shouldRenderLinkedPlainText("See [docs][docs]\n\n[docs]: https://docs.example/x")).toBe(false);
    expect(shouldRenderLinkedPlainText('See [docs][docs]\n\n[docs]: https://docs.example/x "Documentation"')).toBe(
      false,
    );
    expect(shouldRenderLinkedPlainText("[docs][ref] https://docs.example/x")).toBe(false);
    expect(shouldRenderLinkedPlainText("[docs][] https://docs.example/x")).toBe(false);
    expect(shouldRenderLinkedPlainText("See [\nfoo](https://inline.example/x) and https://docs.example/x")).toBe(false);
  });

  test("keeps plain prose with single underscores, tildes, and bracketed prefixes on the linked plain-text path", () => {
    expect(shouldRenderLinkedPlainText("tool_name ~backup https://docs.example/x")).toBe(true);
    expect(shouldRenderLinkedPlainText("[ERROR]: Could not connect to https://api.example.com")).toBe(true);
    expect(shouldRenderLinkedPlainText("[ERROR]: https://api.example.com")).toBe(true);
    expect(shouldRenderLinkedPlainText("[docs]: https://docs.example/x")).toBe(true);
    expect(shouldRenderLinkedPlainText("[note] https://docs.example/x")).toBe(true);
  });

  test("resolves a wrapped link when the clicked continuation cell has no link id", () => {
    const width = 8;
    const attributes = new Uint32Array(width * 2);
    const linkedUnderline = attributesWithLink(TextAttributes.UNDERLINE, 42);
    attributes[width - 2] = linkedUnderline;
    attributes[width - 1] = linkedUnderline;
    attributes[width] = TextAttributes.UNDERLINE;
    attributes[width + 1] = TextAttributes.UNDERLINE;

    expect(getLinkUrlAtScreenPosition(rendererWithAttributes(width, 2, attributes), 1, 1)).toBe(
      "https://example.test/path/that/wraps/across/rows",
    );
  });

  test("uses the renderer's native attribute decoder when available", () => {
    const attributes = new Uint32Array([TextAttributes.UNDERLINE]);
    const renderer = rendererWithAttributes(1, 1, attributes);
    const nativeRenderer: LinkTestRenderer = {
      ...renderer,
      lib: {
        ...renderer.lib,
        attributesGetLinkId: () => 42,
      },
    };

    expect(getLinkUrlAtScreenPosition(nativeRenderer, 0, 0)).toBe("https://example.test/path/that/wraps/across/rows");
  });

  test("prefers the contiguous wrapped link over another link later on the same row", () => {
    const width = 10;
    const attributes = new Uint32Array(width * 2);
    const wrappedLink = attributesWithLink(TextAttributes.UNDERLINE, 42);
    const laterLink = attributesWithLink(TextAttributes.UNDERLINE, 84);
    attributes[width - 1] = wrappedLink;
    attributes[width] = TextAttributes.UNDERLINE;
    attributes[width + 1] = TextAttributes.UNDERLINE;
    attributes[width + 5] = laterLink;

    expect(
      getLinkUrlAtScreenPosition(
        rendererWithAttributes(
          width,
          2,
          attributes,
          new Map<number, string>([
            [42, "https://example.test/path/that/wraps/across/rows"],
            [84, "https://other.example.test/"],
          ]),
        ),
        1,
        1,
      ),
    ).toBe("https://example.test/path/that/wraps/across/rows");
  });
});
