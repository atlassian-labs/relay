import { describe, expect, test } from "bun:test";
import { PasteStore } from "../../../src/ui/paste";
import { refreshPasteHighlights, type PasteHighlightRef } from "../../../src/ui/util/paste-highlights";
import { getColors } from "../../../src/ui/context/theme";

interface CreatedExtmark {
  id: number;
  start: number;
  end: number;
  virtual?: boolean;
  styleId?: number;
  priority?: number;
  typeId?: number;
}

function createRef(text: string): PasteHighlightRef & { created: CreatedExtmark[] } {
  let nextTypeId = 1;
  let nextExtmarkId = 1;
  const typeIds = new Map<string, number>();
  const created: CreatedExtmark[] = [];

  return {
    plainText: text,
    created,
    extmarks: {
      registerType: (typeName: string) => {
        const typeId = nextTypeId++;
        typeIds.set(typeName, typeId);
        return typeId;
      },
      getTypeId: (typeName: string) => typeIds.get(typeName) ?? null,
      getAllForTypeId: (typeId: number) => created.filter((mark) => mark.typeId === typeId),
      create: (options) => {
        const id = nextExtmarkId++;
        created.push({ id, ...options });
        return id;
      },
      delete: (id: number) => {
        const index = created.findIndex((mark) => mark.id === id);
        if (index === -1) return false;
        created.splice(index, 1);
        return true;
      },
    },
  };
}

describe("paste highlights", () => {
  test("creates theme-colored highlights for compacted paste markers", () => {
    const store = new PasteStore();
    const marker = store.transformPaste(["one", "two", "three", "four", "five", "six"].join("\n"));
    const text = `before ${marker} after`;
    const ref = createRef(text);

    refreshPasteHighlights(ref, store, getColors());

    expect(ref.created).toHaveLength(1);
    expect(ref.created[0].start).toBe(7);
    expect(ref.created[0].end).toBe(7 + marker.length);
    expect(ref.created[0].styleId).toBeGreaterThan(0);
    expect(ref.created[0].priority).toBe(100);
    expect(ref.syntaxStyle?.getStyle("relay.pasteMarker")).toBeTruthy();
  });

  test("clears stale paste marker highlights", () => {
    const store = new PasteStore();
    const marker = store.transformPaste(["one", "two", "three", "four", "five", "six"].join("\n"));
    const ref = createRef(marker);

    refreshPasteHighlights(ref, store, getColors());
    expect(ref.created).toHaveLength(1);

    ref.plainText = "no markers";
    refreshPasteHighlights(ref, store, getColors());

    expect(ref.created).toHaveLength(0);
  });

  test("highlights the leading slash command token", () => {
    const store = new PasteStore();
    const ref = createRef("  /clean-up-feature-flag feature_flag_key");

    refreshPasteHighlights(ref, store, getColors(), new Set(["clean-up-feature-flag"]));

    expect(ref.created).toHaveLength(1);
    expect(ref.created[0].start).toBe(2);
    expect(ref.created[0].end).toBe(24);
    expect(ref.created[0].styleId).toBeGreaterThan(0);
    expect(ref.created[0].priority).toBe(90);
    expect(ref.syntaxStyle?.getStyle("relay.slashCommand")).toBeTruthy();
  });

  test("clears stale slash command highlights", () => {
    const store = new PasteStore();
    const known = new Set(["new"]);
    const ref = createRef("/new");

    refreshPasteHighlights(ref, store, getColors(), known);
    expect(ref.created).toHaveLength(1);

    ref.plainText = "not a slash command";
    refreshPasteHighlights(ref, store, getColors(), known);

    expect(ref.created).toHaveLength(0);
  });

  test("does not highlight unknown slash tokens like file paths", () => {
    const store = new PasteStore();
    const ref = createRef("/etc/hosts is the file");

    refreshPasteHighlights(ref, store, getColors(), new Set(["new", "settings"]));

    expect(ref.created).toHaveLength(0);
  });

  test("does not highlight a slash token when no command list is provided", () => {
    const store = new PasteStore();
    const ref = createRef("/new");

    refreshPasteHighlights(ref, store, getColors());

    expect(ref.created).toHaveLength(0);
  });

  test("does not highlight a slash command after a leading newline", () => {
    const store = new PasteStore();
    const ref = createRef("\n/new");

    refreshPasteHighlights(ref, store, getColors(), new Set(["new"]));

    expect(ref.created).toHaveLength(0);
  });

  test("matches known commands case-insensitively", () => {
    const store = new PasteStore();
    const ref = createRef("/NEW");

    refreshPasteHighlights(ref, store, getColors(), new Set(["new"]));

    expect(ref.created).toHaveLength(1);
    expect(ref.created[0].start).toBe(0);
    expect(ref.created[0].end).toBe(4);
  });
});
