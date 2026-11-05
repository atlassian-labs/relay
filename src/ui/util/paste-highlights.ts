import { SyntaxStyle } from "@opentui/core";
import type { PasteStore } from "../paste";
import type { ColorsConfig } from "../../config/themes";

const PASTE_MARKER_STYLE = "relay.pasteMarker";
const IMAGE_MARKER_STYLE = "relay.imageMarker";
const PASTE_MARKER_TYPE = "relay.pasteMarker";
const SLASH_COMMAND_STYLE = "relay.slashCommand";
const SLASH_COMMAND_TYPE = "relay.slashCommand";

export interface PasteHighlightRef {
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
  editBuffer?: { getText?: () => string };
}

let promptSyntaxStyle: SyntaxStyle | null = null;
let promptStyleKey = "";

function getPromptSyntaxStyle(colors: ColorsConfig): SyntaxStyle {
  const styleKey = `${colors.badge.bg}:${colors.badge.label}:${colors.accent}:${colors.notice}:${colors.bg}`;
  if (promptSyntaxStyle && promptStyleKey === styleKey) return promptSyntaxStyle;

  promptSyntaxStyle = SyntaxStyle.fromTheme([
    {
      scope: [PASTE_MARKER_STYLE],
      style: {
        foreground: colors.badge.label,
        background: colors.badge.bg,
        bold: true,
      },
    },
    {
      scope: [IMAGE_MARKER_STYLE],
      style: {
        foreground: colors.bg,
        background: colors.notice,
        bold: true,
      },
    },
    {
      scope: [SLASH_COMMAND_STYLE],
      style: {
        foreground: colors.accent,
        bold: true,
      },
    },
  ]);
  promptStyleKey = styleKey;
  return promptSyntaxStyle;
}

function ensureType(ref: PasteHighlightRef, typeName: string): number | null {
  const extmarks = ref.extmarks;
  if (!extmarks) return null;
  const existingTypeId = extmarks.getTypeId?.(typeName);
  if (existingTypeId !== null && existingTypeId !== undefined) return existingTypeId;
  return extmarks.registerType?.(typeName) ?? null;
}

function clearHighlights(ref: PasteHighlightRef, typeId: number): void {
  const extmarks = ref.extmarks;
  if (!extmarks?.getAllForTypeId || !extmarks.delete) return;
  for (const mark of extmarks.getAllForTypeId(typeId)) {
    extmarks.delete(mark.id);
  }
}

function findSlashCommandSpan(
  text: string,
  knownCommandNames: ReadonlySet<string>,
): { start: number; end: number } | null {
  // Only highlight a command on the first line; leading newlines mean the
  // slash token is body text, not a command invocation.
  const leadingWhitespace = text.match(/^[\t ]*/)?.[0].length ?? 0;
  if (text.charAt(leadingWhitespace) !== "/") return null;
  const rest = text.slice(leadingWhitespace);
  const command = rest.match(/^\/\S*/)?.[0] ?? "";
  if (command.length <= 1) return null;
  if (!knownCommandNames.has(command.slice(1).toLowerCase())) return null;
  return { start: leadingWhitespace, end: leadingWhitespace + command.length };
}

export function refreshPasteHighlights(
  ref: PasteHighlightRef | null | undefined,
  store: PasteStore,
  colors: ColorsConfig,
  knownSlashCommandNames?: ReadonlySet<string>,
): void {
  if (!ref?.extmarks) return;

  const pasteTypeId = ensureType(ref, PASTE_MARKER_TYPE);
  const slashTypeId = ensureType(ref, SLASH_COMMAND_TYPE);
  if (pasteTypeId !== null) clearHighlights(ref, pasteTypeId);
  if (slashTypeId !== null) clearHighlights(ref, slashTypeId);

  const text = ref.plainText ?? ref.editBuffer?.getText?.() ?? "";
  const pasteSpans = store.hasPasteMarkers(text) ? store.findAllPlaceholders(text) : [];
  const slashSpan = knownSlashCommandNames ? findSlashCommandSpan(text, knownSlashCommandNames) : null;
  if (pasteSpans.length === 0 && !slashSpan) return;

  const syntaxStyle = getPromptSyntaxStyle(colors);
  ref.syntaxStyle = syntaxStyle;

  const pasteStyleId = syntaxStyle.getStyleId(PASTE_MARKER_STYLE);
  const imageStyleId = syntaxStyle.getStyleId(IMAGE_MARKER_STYLE);
  if (pasteTypeId !== null && pasteStyleId !== null && imageStyleId !== null) {
    for (const span of pasteSpans) {
      ref.extmarks.create?.({
        start: span.start,
        end: span.end,
        virtual: false,
        styleId: span.kind === "image" ? imageStyleId : pasteStyleId,
        priority: 100,
        typeId: pasteTypeId,
      });
    }
  }

  const slashStyleId = syntaxStyle.getStyleId(SLASH_COMMAND_STYLE);
  if (slashTypeId !== null && slashStyleId !== null && slashSpan) {
    ref.extmarks.create?.({
      start: slashSpan.start,
      end: slashSpan.end,
      virtual: false,
      styleId: slashStyleId,
      priority: 90,
      typeId: slashTypeId,
    });
  }
}
