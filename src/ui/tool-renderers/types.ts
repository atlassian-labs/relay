import type { JSX } from "solid-js";
import type { ToolBlock } from "../state";
import type { ColorsConfig } from "../../config/themes";

export type AgentProfile = string;

export interface ToolRenderHelpers {
  formatToolName: (name: string) => string;
  getToolIcon: (toolName: string) => string;
  getSyntaxStyle: () => any;
  hasMarkup: (text: string) => boolean;
  renderMarkup: (text: string, defaultFg?: string) => any;
}

export interface ToolRenderContext {
  block: ToolBlock;
  colors: ColorsConfig;
  helpers: ToolRenderHelpers;
  expanded: boolean;
  selected?: boolean;
  previewLines: number;
  cwd: string;
  threadId?: string | null;
  sessionId?: string | null;
}

export interface ToolRendererOutput {
  header: JSX.Element;
  result?: JSX.Element;
  canToggle?: boolean;
  hiddenLineCount?: number;
  collapsed?: boolean;
}

export type ToolRenderer = (ctx: ToolRenderContext) => ToolRendererOutput | null;

export interface ToolRenderProfile {
  icons: Record<string, string>;
  renderers: Record<string, ToolRenderer>;
  isNonTruncatableTool: (toolName: string) => boolean;
  shouldHideResultInSuccinctMode: (toolName: string) => boolean;
}
