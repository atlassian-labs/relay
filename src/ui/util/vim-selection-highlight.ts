import { SyntaxStyle } from "@opentui/core";
import type { ColorsConfig } from "../../config/themes";
import { getVisualSelection, type VimState } from "./vim-engine";

const VISUAL_STYLE = "relay.vimVisual";
const VISUAL_TYPE = "relay.vimVisual";

export interface VimSelectionRef {
  syntaxStyle?: SyntaxStyle | null;
  extmarks?: {
    registerType?: (typeName: string) => number;
    getTypeId?: (typeName: string) => number | null;
    getAllForTypeId?: (typeId: number) => Array<{ id: number }>;
    create?: (options: {
      start: number;
      end: number;
      virtual?: boolean;
      styleId?: number;
      priority?: number;
      typeId?: number;
    }) => number;
    delete?: (id: number) => boolean;
  };
  plainText?: string;
  cursorOffset?: number;
  editBuffer?: { getText?: () => string };
}

let cachedStyle: SyntaxStyle | null = null;
let cachedStyleKey = "";

function getVisualSyntaxStyle(colors: ColorsConfig): SyntaxStyle {
  const styleKey = `${colors.accent}:${colors.bg}`;
  if (cachedStyle && cachedStyleKey === styleKey) return cachedStyle;
  cachedStyle = SyntaxStyle.fromTheme([
    {
      scope: [VISUAL_STYLE],
      style: {
        foreground: colors.bg,
        background: colors.accent,
      },
    },
  ]);
  cachedStyleKey = styleKey;
  return cachedStyle;
}

function ensureType(ref: VimSelectionRef): number | null {
  const extmarks = ref.extmarks;
  if (!extmarks) return null;
  const existing = extmarks.getTypeId?.(VISUAL_TYPE);
  if (existing !== null && existing !== undefined) return existing;
  return extmarks.registerType?.(VISUAL_TYPE) ?? null;
}

function clearVisualHighlights(ref: VimSelectionRef, typeId: number): void {
  const extmarks = ref.extmarks;
  if (!extmarks?.getAllForTypeId || !extmarks.delete) return;
  for (const mark of extmarks.getAllForTypeId(typeId)) {
    extmarks.delete(mark.id);
  }
}

/**
 * Paint or clear the visual-mode selection highlight on the textarea. Safe to call
 * on every state change; existing highlights are wiped first so toggling modes is clean.
 */
export function refreshVimSelectionHighlight(
  ref: VimSelectionRef | null | undefined,
  vimState: VimState,
  colors: ColorsConfig,
): void {
  if (!ref?.extmarks) return;
  const typeId = ensureType(ref);
  if (typeId === null) return;
  clearVisualHighlights(ref, typeId);

  if (vimState.mode !== "visual" && vimState.mode !== "visual-line") return;
  const text = ref.plainText ?? ref.editBuffer?.getText?.() ?? "";
  const cursor = Math.max(0, Math.min(ref.cursorOffset ?? 0, text.length));
  const selection = getVisualSelection(vimState, text, cursor);
  if (!selection || selection.end <= selection.start) return;

  const syntaxStyle = getVisualSyntaxStyle(colors);
  const styleId = syntaxStyle.getStyleId(VISUAL_STYLE);
  if (styleId === null) return;
  ref.syntaxStyle = syntaxStyle;

  ref.extmarks.create?.({
    start: selection.start,
    end: selection.end,
    virtual: false,
    styleId,
    priority: 90,
    typeId,
  });
}
