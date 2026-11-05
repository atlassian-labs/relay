import { afterEach, expect } from "bun:test";
import { Buffer } from "node:buffer";
import { parseColor } from "@opentui/core";
import { testRender } from "@opentui/solid";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ApprovalResponse } from "../../../src/core/events";
import { saveThreadsForWorkspace } from "../../../src/core/threads";
import { App, previewFromBlocks } from "../../../src/ui/app";
import type { ChatBlock, ElicitationSchema } from "../../../src/ui/state";
import type { TerminalTitleOutput } from "../../../src/ui/util/terminal-title";
import { Config, getConfig, getConfigDir, resetConfig, setConfig } from "../../../src/config";
import { blendHexColors, getThemeIds } from "../../../src/config/themes";
import { getColors } from "../../../src/ui/context/theme";
import { SETTING_VALUE_CHOICES } from "../../../src/ui/util/settings";
import {
  acpAgentMessageChunk,
  acpPromptResponse,
  acpThinkingChunk,
  acpToolCallStart,
  acpToolCallUpdate,
  acpToolDiffContent,
  acpToolMixedContent,
  acpUserMessageChunk,
  acpUsageUpdate,
} from "../../lib/acp-events";
import { createFauxAcpAgent, type FauxAcpAgent } from "../../lib/faux-acp-agent";

const tmpRoots: string[] = [];

export class CaptureTitleOutput implements TerminalTitleOutput {
  readonly isTTY = true;
  readonly chunks: string[] = [];

  write(chunk: string): void {
    this.chunks.push(chunk);
  }

  titles(): string[] {
    return this.chunks.map((chunk) => {
      const prefix = "\u001b]0;";
      const suffix = "\u0007";
      const withoutPrefix = chunk.startsWith(prefix) ? chunk.slice(prefix.length) : chunk;
      return withoutPrefix.endsWith(suffix) ? withoutPrefix.slice(0, -suffix.length) : withoutPrefix;
    });
  }

  lastTitle(): string | undefined {
    return this.titles().at(-1);
  }
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function spinnerTitlePattern(workspace: string): RegExp {
  return new RegExp(`^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] ${escapeRegExp(workspace)}$`, "u");
}

export function tmpWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-app-e2e-"));
  tmpRoots.push(dir);
  return dir;
}

export async function waitFor(
  assertion: () => void | boolean | Promise<void | boolean>,
  timeoutMs = 3000,
): Promise<void> {
  const start = Date.now();
  let lastError: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      const result = await assertion();
      if (result !== false) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (lastError) throw lastError;
  throw new Error("Timed out waiting for assertion");
}

export function configureFauxAgent(preferredModel?: string, ui?: FauxConfigOptions["ui"]) {
  writeFauxConfig(fauxConfigToml({ ui, preferredModel }));
}

export type TomlScalar = string | number | boolean;
export type TomlValue = TomlScalar | readonly string[];

export function tomlValue(value: TomlValue): string {
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(", ")}]`;
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

export function tomlArray(values: readonly string[]): string {
  return tomlValue(values);
}

export function tomlLines(data: Record<string, TomlValue | undefined>): string {
  return (Object.entries(data) as Array<[string, TomlValue | undefined]>)
    .filter((entry): entry is [string, TomlValue] => entry[1] !== undefined)
    .map(([key, value]) => `${key} = ${tomlValue(value)}`)
    .join("\n");
}

type FauxConfigOptions = {
  ui?: Partial<Omit<Config["ui"], "tool_call_groups">>;
  pluginPaths?: string[];
  disabledPlugins?: string[];
  profile?: string;
  preferredModel?: string;
};

export function fauxConfigToml(options: FauxConfigOptions): string {
  const sections: string[] = [];
  if (options.ui) sections.push(`[ui]\n${tomlLines(options.ui)}`);
  if (options.pluginPaths || options.disabledPlugins) {
    sections.push(`[plugins]
enabled = true
allow_project_plugins = false
paths = ${tomlArray(options.pluginPaths ?? [])}
trusted_workspaces = []
disabled = ${tomlArray(options.disabledPlugins ?? [])}`);
  }
  sections.push(`[notifications]
sound_enabled = false`);
  sections.push(`[agents]
default = "faux"

[agents.runners.faux]
command = "faux-agent"
args = []
${tomlLines({ profile: options.profile ?? "default", preferred_model: options.preferredModel })}`);
  return `${sections.join("\n\n")}\n`;
}

export function configureFauxAgentWithPlugins(pluginPaths: string[], ui?: Partial<Config["ui"]>) {
  writeFauxConfig(fauxConfigToml({ ui, pluginPaths }));
}

export function configureFauxAltaAgent(preferredModel?: string) {
  writeFauxConfig(fauxConfigToml({ profile: "alta", preferredModel }));
}

export function configureFauxAgentWithSlashPanelPosition(position: "bottom" | "top") {
  // Write without resetConfig() so a running app's watcher picks up runtime switches.
  fs.mkdirSync(getConfigDir(), { recursive: true });
  fs.writeFileSync(
    path.join(getConfigDir(), "config.toml"),
    fauxConfigToml({ ui: { slash_panel_position: position } }),
  );
}

export function writeFauxConfig(text: string): void {
  fs.mkdirSync(getConfigDir(), { recursive: true });
  fs.writeFileSync(path.join(getConfigDir(), "config.toml"), text, "utf-8");
  resetConfig();
}

afterEach(() => {
  resetConfig();
  fs.rmSync(getConfigDir(), { recursive: true, force: true });
  while (tmpRoots.length > 0) {
    fs.rmSync(tmpRoots.pop()!, { recursive: true, force: true });
  }
});

export async function renderFauxApp(
  cwd: string,
  faux: FauxAcpAgent = createFauxAcpAgent(),
  options: {
    initialContinue?: boolean;
    initialResume?: boolean;
    initialResumeSessionId?: string;
    initialPrompt?: string;
    initialThinkingLevel?: string;
    initialDefaultRenderer?: boolean;
    initialAcpCommand?: string;
    initialAgent?: string;
    externalEditor?: Parameters<typeof App>[0]["externalEditor"];
    terminalTitleOutput?: TerminalTitleOutput;
    otherModifiersMode?: boolean;
    transcriptRendererMode?: Parameters<typeof App>[0]["transcriptRendererMode"];
    width?: number;
    height?: number;
  } = {},
) {
  return await testRender(
    () => (
      <App
        cwd={cwd}
        initialAgent={options.initialAgent ?? "faux"}
        initialAcpCommand={options.initialAcpCommand}
        initialContinue={options.initialContinue ?? false}
        initialResume={options.initialResume ?? false}
        initialResumeSessionId={options.initialResumeSessionId ?? ""}
        initialDefaultRenderer={options.initialDefaultRenderer ?? true}
        initialPrompt={options.initialPrompt}
        initialThinkingLevel={options.initialThinkingLevel}
        acpClientFactory={faux.factory()}
        externalEditor={options.externalEditor}
        terminalTitleOutput={options.terminalTitleOutput}
        transcriptRendererMode={options.transcriptRendererMode}
      />
    ),
    {
      width: options.width ?? 100,
      height: options.height ?? 30,
      targetFps: 30,
      otherModifiersMode: options.otherModifiersMode ?? false,
    },
  );
}

export type FauxRenderedApp = Awaited<ReturnType<typeof renderFauxApp>>;

export type VerticalScrollDirection = "up" | "down";

export function longLineResponse(prefix: string, lineCount = 50): string {
  return Array.from({ length: lineCount }, (_, index) => `${prefix}-${String(index).padStart(2, "0")}`).join("\n");
}

export async function submitPrompt(app: FauxRenderedApp, text: string): Promise<void> {
  await app.mockInput.typeText(text);
  app.mockInput.pressEnter();
}

export async function scrollMouse(
  app: FauxRenderedApp,
  x: number,
  y: number,
  direction: VerticalScrollDirection,
  count: number,
): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await app.mockMouse.scroll(x, y, direction);
    await app.renderOnce();
  }
}

export async function waitForPromptCountWithoutWorking(
  app: FauxRenderedApp,
  faux: FauxAcpAgent,
  promptCount: number,
): Promise<void> {
  await waitFor(() => {
    app.renderOnce();
    app.captureCharFrame();
    expect(faux.prompts).toHaveLength(promptCount);
  }, 5000);
}

export function borderSpans(
  app: Awaited<ReturnType<typeof renderFauxApp>>,
  lineIndex?: number,
): Array<{ text: string; fg: { toString(): string } }> {
  const lines = app.captureSpans().lines;
  const selectedLines = lineIndex === undefined ? lines : lines[lineIndex] ? [lines[lineIndex]] : [];
  return selectedLines.flatMap((line) => line.spans).filter((span) => /[╭╮╰╯─]/.test(span.text)) as Array<{
    text: string;
    fg: { toString(): string };
  }>;
}

export function hasAnimatedBorderColor(
  app: Awaited<ReturnType<typeof renderFauxApp>>,
  baseBorder: string,
  lineIndex?: number,
): boolean {
  return borderSpans(app, lineIndex).some((span) => span.fg.toString() !== baseBorder);
}

export async function waitForConnected(app: Awaited<ReturnType<typeof renderFauxApp>>) {
  await waitFor(() => {
    app.renderOnce();
    expect(app.captureCharFrame()).toContain("Connected to faux agent");
  }, 3000);
}

function userMessagePanelBackground(): string {
  const colors = getColors();
  return parseColor(blendHexColors(colors.panelUser, colors.bg, 0.25)).toString();
}

export function expectSpanNotPanelFilled(app: Awaited<ReturnType<typeof renderFauxApp>>, text: string): void {
  const span = app
    .captureSpans()
    .lines.flatMap((line) => line.spans)
    .find((candidate) => candidate.text.includes(text));
  expect(span).toBeDefined();
  expect(span?.bg.toString()).not.toBe(userMessagePanelBackground());
}

export function expectSpanPanelFilled(app: Awaited<ReturnType<typeof renderFauxApp>>, text: string): void {
  const span = app
    .captureSpans()
    .lines.flatMap((line) => line.spans)
    .find((candidate) => candidate.text.includes(text));
  expect(span).toBeDefined();
  expect(span?.bg.toString()).toBe(userMessagePanelBackground());
}

export function expectPanelVerticalPaddingAroundText(
  app: Awaited<ReturnType<typeof renderFauxApp>>,
  text: string,
): void {
  const panelBg = userMessagePanelBackground();
  const lines = app.captureSpans().lines;
  const lineIndex = lines.findIndex((line) => line.spans.some((span) => span.text.includes(text)));
  expect(lineIndex).toBeGreaterThan(0);
  expect(lineIndex).toBeLessThan(lines.length - 1);
  expect(lines[lineIndex - 1].spans.some((span) => span.bg.toString() === panelBg)).toBe(true);
  expect(lines[lineIndex].spans.some((span) => span.bg.toString() === panelBg)).toBe(true);
  expect(lines[lineIndex + 1].spans.some((span) => span.bg.toString() === panelBg)).toBe(true);
}

export function emitKey(
  app: Awaited<ReturnType<typeof renderFauxApp>>,
  name: string,
  overrides: Partial<Parameters<typeof app.renderer.keyInput.emit>[1]> = {},
): void {
  app.renderer.keyInput.emit("keypress", {
    name,
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    sequence: "",
    number: false,
    raw: "",
    eventType: "press",
    source: "raw",
    get defaultPrevented() {
      return false;
    },
    get propagationStopped() {
      return false;
    },
    preventDefault() {},
    stopPropagation() {},
    ...overrides,
  } as Parameters<typeof app.renderer.keyInput.emit>[1]);
}

export function pressCtrlEnter(app: Awaited<ReturnType<typeof renderFauxApp>>): void {
  emitKey(app, "return", { ctrl: true, sequence: "\r", raw: "\r" });
}

export function pressRawKeypadEnter(
  app: Awaited<ReturnType<typeof renderFauxApp>>,
  modifier: "none" | "shift" | "option" = "none",
): void {
  const sequence = modifier === "shift" ? "\x1b[57414;2u" : modifier === "option" ? "\x1b[57414;3u" : "\x1b[57414u";
  app.renderer.stdin.emit("data", Buffer.from(sequence));
}

export function pressCtrlO(app: Awaited<ReturnType<typeof renderFauxApp>>): void {
  emitKey(app, "o", { ctrl: true, sequence: "\u000f", raw: "\u000f" });
}

export function filesystemSkillUserMessage(name: string, args: string, body = "Agent-owned skill body."): string {
  return [
    "---",
    `name: ${name}`,
    "description: Agent-owned skill",
    "register_cmd: true",
    "---",
    "",
    body,
    ...(args ? ["", `ARGUMENTS: ${args}`] : []),
  ].join("\n");
}

export function twoChoiceSchema(first: string, second: string): ElicitationSchema {
  return {
    type: "object",
    properties: {
      decision: {
        type: "string",
        title: "Decision",
        oneOf: [
          { const: first, title: first },
          { const: second, title: second },
        ],
      },
    },
    required: ["decision"],
  };
}

export {
  ApprovalResponse,
  Buffer,
  Config,
  SETTING_VALUE_CHOICES,
  acpAgentMessageChunk,
  acpPromptResponse,
  acpThinkingChunk,
  acpToolCallStart,
  acpToolCallUpdate,
  acpToolDiffContent,
  acpToolMixedContent,
  acpUsageUpdate,
  acpUserMessageChunk,
  createFauxAcpAgent,
  fs,
  getColors,
  getConfig,
  getConfigDir,
  getThemeIds,
  parseColor,
  path,
  previewFromBlocks,
  resetConfig,
  saveThreadsForWorkspace,
  setConfig,
};
export type { ChatBlock };
