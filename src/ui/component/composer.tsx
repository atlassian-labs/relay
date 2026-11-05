import { Show, createEffect, createSignal, onCleanup } from "solid-js";
import { useKeyboard } from "@opentui/solid";
import { useSharedTerminalDimensions } from "../context/terminal-dimensions";
import { createTextAttributes, parseColor, type CursorStyleOptions } from "@opentui/core";
import { PromptHistory } from "../../prompt-history";
import { getConfig, subscribeConfig } from "../../config";
import { blendHexColors, getLayerColors } from "../../config/themes";
import {
  applyFileCompletion,
  applySlashCompletion,
  buildPluginAutocompleteCompletion,
  buildSlashCommandArgumentCompletion,
  getFileSuggestionsDeferred,
  getKnownSlashCommandNames,
  getRelayAutocompleteContext,
  getSlashCommandArgumentTarget,
  getSlashSuggestions,
  hasFileSuggestionToken,
  SelectionMode,
  type CompletionResult,
  type ListItem,
  type SlashCommand,
} from "../autocomplete";
import { pasteStore } from "../paste";
import { createPromptSubmission, sanitizePromptImagesForHistory } from "../prompt-images";
import {
  applyTextareaTextUpdate,
  copySelectionWithPasteExpansion,
  getCursorOffset,
  handlePasteMouseUp,
  installPasteHandler,
} from "../util/paste-textarea";
import { refreshPasteHighlights } from "../util/paste-highlights";
import { getReasoningEffortSuggestions } from "../util/reasoning-effort";
import { type ChatBlock, useApp } from "../state";
import type {
  PluginRunner,
  RelayAutocompleteItem,
  RelayAutocompleteProviderResult,
  RelayCommandContext,
  RelayEditorBorderColorContext,
  RelayEditorSurfaceState,
} from "../../plugins";
import { getColors } from "../context/theme";
import { EMPTY_QUEUE_EDIT_MESSAGE } from "../util/prompt-queue";
import { showToast } from "../app/toast-controller";
import { composerPaddingX, UI_COMPOSER_MAX_HEIGHT_RATIO, UI_COMPOSER_MIN_HEIGHT } from "../layout";
import { ENTER_KEY_NAMES } from "../util/key-events";
import type { PromptInput } from "../../core/prompt-submission";
import type { VimMode } from "../util/vim-engine";

const promptHistory = new PromptHistory();
const PROMPT_ENTER_KEY_BINDINGS = ENTER_KEY_NAMES.flatMap((name) => [
  { name, shift: false, action: "submit" as const },
  { name, shift: true, action: "newline" as const },
]);
const RELAY_PROMPT_CURSOR_PATCH = Symbol("relayPromptCursorPatch");
const RELAY_PROMPT_CURSOR_COLOR_MODE = Symbol("relayPromptCursorColorMode");
const TERMINAL_OWNED_CURSOR_COLOR_MODE = "terminal";

function isUserMessageBlock(block: ChatBlock): boolean {
  return block.type === "user";
}

type PromptTextareaRef = Record<PropertyKey, unknown> & {
  focus?: () => unknown;
  blur?: () => unknown;
  showCursor?: boolean;
  cursorStyle?: CursorStyleOptions;
  cursorColor?: string;
  cursorOffset?: number;
  requestRender?: () => unknown;
  plainText?: string;
  setText?: (text: string) => unknown;
  clear?: () => unknown;
  insertText?: (text: string) => unknown;
  editBuffer?: {
    getText?: () => string;
    clear?: () => unknown;
  };
};

type PromptRenderContext = {
  writeOut?: (data: string) => unknown;
};

type PromptCursorColorMode = typeof TERMINAL_OWNED_CURSOR_COLOR_MODE | `plugin:${string}`;

export type InputUpdateSource = "completion" | "tab-completion" | "history" | "queue";

export interface ComposerProps {
  selectionMode: () => SelectionMode | null;
  filterOverlayItems: (query: string) => void;
  showOverlay: (items: ListItem<any>[]) => void;
  hideOverlay: () => void;
  isOverlayVisible: () => boolean;
  selectOverlayItem: (app: ReturnType<typeof useApp>, submitSlashCompletion?: boolean) => void;
  getVisibleSlashCommands: (state: ReturnType<typeof useApp>["state"] | null) => SlashCommand[];
  ensureSlashCommandMetadata?: () => Promise<boolean>;
  setActiveCompletion: (completion: CompletionResult | null) => void;
  setTabCompleting: (value: boolean) => void;
  consumeInputUpdateSource: (text: string) => InputUpdateSource | null;
  onPromptTextChanged: (source: InputUpdateSource | null, text: string) => void;
  setTextareaRef: (ref: any, previousRef?: any) => void;
  setCompletedTextSubmitter?: (
    submitter: ((text: string) => void) | null,
    previousSubmitter?: (text: string) => void,
  ) => void;
  resetDoublePressState: () => void;
  currentSessionId: () => string | null;
  commandContext?: () => RelayCommandContext;
  focused?: () => boolean;
  inputSuspended?: () => boolean;
  vimStatus?: () => { mode: VimMode; pending: string } | null;
  handleSubmit: (input: PromptInput, app: ReturnType<typeof useApp>) => void;
  pluginRunner?: () => PluginRunner | null;
  pluginRevision?: () => number;
  variant?: "composer" | "queue-inline" | "composer-placeholder";
  initialText?: () => string;
}

export function Composer(props: ComposerProps) {
  const app = useApp();
  const colors = getColors();
  const layers = getLayerColors(colors);
  const dims = useSharedTerminalDimensions();
  let textareaRef: any;
  let promptBoxRef: any;
  let promptFocusTimer: ReturnType<typeof setTimeout> | null = null;
  const [inputText, setInputText] = createSignal(props.initialText?.() ?? "");
  const [bashPrefix, setBashPrefix] = createSignal<"" | "!" | "!!">("");
  const [promptMarker, setPromptMarker] = createSignal(getConfig().ui.prompt_marker);
  const [editorStyle, setEditorStyle] = createSignal(getConfig().ui.editor_style);
  let normalizingBashPrefixInput = false;
  let restoringSuspendedInput = false;
  let fileAutocompleteTimer: ReturnType<typeof setTimeout> | null = null;
  let cancelPendingFileAutocomplete: (() => void) | null = null;
  let fileAutocompleteRequest = 0;
  let commandArgumentAutocompleteRequest = 0;
  let pluginAutocompleteRequest = 0;
  let slashCommandMetadataRequest = 0;
  let slashCommandMetadataTimer: ReturnType<typeof setTimeout> | null = null;

  const maxPromptHeight = () =>
    Math.max(UI_COMPOSER_MIN_HEIGHT, Math.floor(dims().height * UI_COMPOSER_MAX_HEIGHT_RATIO));
  const paddingX = () => composerPaddingX(dims().width);
  function knownSlashCommandNames(): ReadonlySet<string> {
    return getKnownSlashCommandNames(props.getVisibleSlashCommands(app.state));
  }
  function refreshCurrentPasteHighlights() {
    refreshPasteHighlights(textareaRef, pasteStore, colors, knownSlashCommandNames());
  }

  function currentTextareaText(): string {
    return textareaRef?.plainText ?? textareaRef?.editBuffer?.getText() ?? inputText();
  }

  function setBashPrefixMode(prefix: "" | "!" | "!!"): void {
    setBashPrefix(prefix);
    if ((prefix !== "") !== app.state.userBashMode) app.setState("userBashMode", prefix !== "");
  }

  function applyNormalizedTextareaText(ref: PromptTextareaRef, text: string): void {
    normalizingBashPrefixInput = true;
    applyTextareaTextUpdate(ref, text, text.length);
    setTimeout(() => {
      normalizingBashPrefixInput = false;
    }, 0);
  }

  function normalizeBashPrefixInput(rawText: string): string {
    if (!textareaRef) return rawText;
    if (bashPrefix() === "!" && inputText() === "" && rawText === "!") {
      setBashPrefixMode("!!");
      applyNormalizedTextareaText(textareaRef, "");
      return "";
    }
    if (bashPrefix() !== "") return rawText;
    if (rawText.startsWith("!!")) {
      const nextText = rawText.slice(2);
      setBashPrefixMode("!!");
      applyNormalizedTextareaText(textareaRef, nextText);
      return nextText;
    }
    if (rawText.startsWith("!")) {
      const nextText = rawText.slice(1);
      setBashPrefixMode("!");
      applyNormalizedTextareaText(textareaRef, nextText);
      return nextText;
    }
    return rawText;
  }

  function clearBashPrefixIfCommandEmpty(event?: { preventDefault?: () => void; stopPropagation?: () => void }): void {
    if (bashPrefix() === "" || currentTextareaText().length > 0) return;
    setBashPrefixMode("");
    event?.preventDefault?.();
    event?.stopPropagation?.();
  }

  const unsubscribeConfig = subscribeConfig((change) => {
    setPromptMarker(change.config.ui.prompt_marker);
    setEditorStyle(change.config.ui.editor_style);
  });

  onCleanup(() => {
    unsubscribeConfig();
    cancelAutocompleteRequests();
    if (promptFocusTimer) {
      clearTimeout(promptFocusTimer);
      promptFocusTimer = null;
    }
    const disposedTextarea = textareaRef;
    textareaRef = null;
    if (disposedTextarea) props.setTextareaRef(null, disposedTextarea);
    if (props.variant !== "composer-placeholder") props.setCompletedTextSubmitter?.(null, submitText);
  });

  const promptFocused = () => props.focused?.() ?? true;
  const inputSuspended = () => props.inputSuspended?.() ?? false;
  const promptDisabled = () => !promptFocused() || inputSuspended();
  const promptCursorVisible = () =>
    !promptDisabled() &&
    props.selectionMode() !== SelectionMode.PLUGINS &&
    props.selectionMode() !== SelectionMode.PLUGIN_DETAILS;
  const promptCursorStyle = (): CursorStyleOptions =>
    props.vimStatus?.()?.mode === "insert" ? { style: "line", blinking: false } : { style: "default", blinking: true };
  const pluginEditorState = () => {
    props.pluginRevision?.();
    return props.pluginRunner?.()?.editor.state();
  };
  const nativePiStyle = () => editorStyle() === "pi";
  const pluginFramedEditor = () => pluginEditorState()?.options.composerFrame === "bordered";
  const framedEditor = () => nativePiStyle() || pluginFramedEditor();
  const suppressSlashAutocomplete = () => {
    const configured = pluginEditorState()?.options.suppressSlashAutocomplete;
    return typeof configured === "function" ? configured() : configured === true;
  };

  const promptSurfaceState = (): RelayEditorSurfaceState => ({
    surface: "prompt",
    focused: promptFocused(),
    disabled: promptDisabled(),
    userBashMode: app.state.userBashMode,
    modeId: app.state.modeId,
    running: app.state.running,
    hasSession: props.currentSessionId() !== null,
  });
  const borderColorContext = (): RelayEditorBorderColorContext => ({
    colors,
    state: promptSurfaceState(),
  });
  const shellPromptColor = () => blendHexColors(colors.panelUser, colors.success, 0.15);
  const defaultPromptBorderColor = () => {
    if (!promptFocused()) return layers.borderSubtle;
    if (promptDisabled()) return colors.notice;
    if (app.state.userBashMode) return shellPromptColor();
    switch (app.state.modeId) {
      case "architect":
        return colors.badge.label;
      case "code":
        return colors.accent;
      default:
        return layers.borderSubtle;
    }
  };
  const configuredBorderColor = () => {
    const configured = pluginEditorState()?.options.borderColor;
    if (typeof configured === "string") return configured;
    if (typeof configured === "function") return configured(borderColorContext());
    return undefined;
  };
  const promptBorderColor = () => configuredBorderColor() ?? defaultPromptBorderColor();
  const nativePiBorderColor = () => blendHexColors(colors.badge.label, colors.textMuted, 0.5);
  const frameBorderColor = () =>
    pluginEditorState()?.theme.borderColor ??
    (nativePiStyle() && !pluginFramedEditor() ? colors.bg : promptBorderColor());
  const promptMarkerColor = () => (bashPrefix() ? colors.running : colors.accent);
  const promptTextColor = () => {
    if (promptDisabled()) return layers.onUserPanelDim;
    return colors.fg;
  };
  const configuredPromptCursorColor = () => pluginEditorState()?.theme.cursorColor;
  const promptBackgroundColor = () => {
    if (promptDisabled()) return colors.panelUser;
    return app.state.userBashMode ? shellPromptColor() : colors.panelUser;
  };
  const borderRenderer = () => pluginEditorState()?.options.borderRenderer;
  const borderRendererActive = () => {
    const renderer = borderRenderer();
    if (!framedEditor() || !renderer) return false;
    const context = borderColorContext();
    return renderer.active ? renderer.active(context) : true;
  };

  createEffect(() => {
    const renderer = borderRenderer();
    if (!framedEditor() || !renderer || !borderRendererActive()) return;
    const context = borderColorContext();
    const configuredInterval =
      typeof renderer.intervalMs === "function" ? renderer.intervalMs(context) : renderer.intervalMs;
    const intervalMs =
      typeof configuredInterval === "number" && Number.isFinite(configuredInterval)
        ? Math.max(16, configuredInterval)
        : 80;
    // effect-shape-allow: plugin border animation exists only while a renderer is configured and is disposed by Solid.
    const timer = setInterval(() => {
      if (borderRendererActive()) promptBoxRef?.requestRender?.();
    }, intervalMs);
    timer.unref?.();
    onCleanup(() => clearInterval(timer));
  });

  function focusTextareaIfActive(ref = textareaRef): void {
    if (!ref || promptDisabled()) return;
    try {
      ref.focus?.();
    } catch {}
  }

  function blurTextarea(ref = textareaRef): void {
    if (!ref) return;
    try {
      ref.blur?.();
    } catch {}
  }

  function restoreSuspendedTextareaValue(ref: PromptTextareaRef, text: string): void {
    restoringSuspendedInput = true;
    try {
      applyTextareaTextUpdate(ref, text, text.length);
    } catch {
      try {
        ref.clear?.();
        if (text) ref.insertText?.(text);
      } catch {}
    } finally {
      setTimeout(() => {
        restoringSuspendedInput = false;
      }, 0);
    }
  }

  function promptRenderContext(ref: PromptTextareaRef | null | undefined): PromptRenderContext | null {
    const ctx = ref ? Reflect.get(ref, "_ctx") : null;
    return ctx && typeof ctx === "object" ? (ctx as PromptRenderContext) : null;
  }

  function resetTerminalCursorColor(ref: PromptTextareaRef | null | undefined = textareaRef): void {
    try {
      promptRenderContext(ref)?.writeOut?.("\x1b]112\x07");
    } catch {}
  }

  function promptCursorColorMode(ref: PromptTextareaRef): PromptCursorColorMode | undefined {
    const mode = Reflect.get(ref, RELAY_PROMPT_CURSOR_COLOR_MODE);
    if (mode === TERMINAL_OWNED_CURSOR_COLOR_MODE) return mode;
    if (typeof mode === "string" && mode.startsWith("plugin:")) return mode as `plugin:${string}`;
    return undefined;
  }

  function clearOpenTuiTextareaCursorColor(ref: PromptTextareaRef): void {
    // OpenTUI textareas default to a concrete cursor color; clearing it lets the terminal default remain active.
    Reflect.set(ref, "_cursorColor", undefined);
  }

  function requestFocusedCursorRender(ref: PromptTextareaRef): void {
    if (Reflect.get(ref, "_focused") === true && typeof ref.requestRender === "function") ref.requestRender();
  }

  function applyPluginOwnedCursorColor(ref: PromptTextareaRef, cursorColor: string): void {
    ref.cursorColor = cursorColor;
    Reflect.set(ref, RELAY_PROMPT_CURSOR_COLOR_MODE, `plugin:${cursorColor}`);
  }

  function applyTerminalOwnedCursorColor(ref: PromptTextareaRef): void {
    const previousMode = promptCursorColorMode(ref);
    const terminalOwnedChanged = previousMode !== TERMINAL_OWNED_CURSOR_COLOR_MODE;
    clearOpenTuiTextareaCursorColor(ref);
    if (terminalOwnedChanged) resetTerminalCursorColor(ref);
    Reflect.set(ref, RELAY_PROMPT_CURSOR_COLOR_MODE, TERMINAL_OWNED_CURSOR_COLOR_MODE);
    if (terminalOwnedChanged) requestFocusedCursorRender(ref);
  }

  function installTextareaCursorPatch(ref: PromptTextareaRef | null | undefined): void {
    if (!ref || Reflect.get(ref, RELAY_PROMPT_CURSOR_PATCH) === true) return;
    const originalFocus = typeof ref.focus === "function" ? ref.focus.bind(ref) : null;
    if (originalFocus) {
      ref.focus = () => {
        if (!configuredPromptCursorColor()) clearOpenTuiTextareaCursorColor(ref);
        const result = originalFocus();
        if (!configuredPromptCursorColor()) resetTerminalCursorColor(ref);
        return result;
      };
    }
    Reflect.set(ref, RELAY_PROMPT_CURSOR_PATCH, true);
  }

  function syncTextareaCursor(ref: PromptTextareaRef | null | undefined = textareaRef): void {
    if (!ref) return;
    try {
      ref.showCursor = promptCursorVisible();
    } catch {}
    try {
      ref.cursorStyle = promptCursorStyle();
    } catch {}
    const configuredCursorColor = configuredPromptCursorColor();
    if (configuredCursorColor) {
      try {
        applyPluginOwnedCursorColor(ref, configuredCursorColor);
      } catch {}
    } else {
      try {
        applyTerminalOwnedCursorColor(ref);
      } catch {}
    }
  }

  createEffect(() => {
    const suspended = inputSuspended();
    const disabled = promptDisabled();
    const ref = textareaRef;
    if (!ref) return;
    syncTextareaCursor(ref);
    if (suspended) {
      if (promptFocusTimer) {
        clearTimeout(promptFocusTimer);
        promptFocusTimer = null;
      }
      blurTextarea(ref);
      return;
    }
    if (!disabled) focusTextareaIfActive(ref);
  });

  useKeyboard((event: any) => {
    if (event.name !== "backspace" && event.name !== "delete" && event.name !== "del") return;
    if (promptDisabled() || props.selectionMode() !== null) return;
    clearBashPrefixIfCommandEmpty(event);
  });

  function drawPluginPromptBorder(this: any, buffer: any): void {
    if (!framedEditor()) return;
    const renderer = borderRenderer();
    const width = Math.max(2, Math.floor(this.width ?? promptBoxRef?.width ?? dims().width));
    const height = Math.max(2, Math.floor(this.height ?? promptBoxRef?.height ?? UI_COMPOSER_MIN_HEIGHT + 1));
    const x = Math.floor(this.x ?? 0);
    const y = Math.floor(this.y ?? 0);

    if (!renderer) {
      if (!nativePiStyle()) return;
      const border = "─".repeat(width);
      const color = parseColor(nativePiBorderColor());
      buffer.drawText(border, x, y, color);
      buffer.drawText(border, x, y + height - 1, color);
      return;
    }

    const context = borderColorContext();
    if (renderer.active && !renderer.active(context)) return;
    const intervalMs =
      typeof renderer.intervalMs === "function" ? renderer.intervalMs(context) : (renderer.intervalMs ?? 80);
    renderer.render({
      ...context,
      frame: Math.floor(Date.now() / Math.max(1, intervalMs)),
      baseBorderColor: frameBorderColor(),
      width,
      height,
      drawText: (text, cellX, cellY, color) => buffer.drawText(text, x + cellX, y + cellY, parseColor(color)),
    });
  }

  function cancelFileAutocomplete() {
    fileAutocompleteRequest++;
    if (fileAutocompleteTimer) {
      clearTimeout(fileAutocompleteTimer);
      fileAutocompleteTimer = null;
    }
    cancelPendingFileAutocomplete?.();
    cancelPendingFileAutocomplete = null;
  }

  function cancelCommandArgumentAutocomplete() {
    commandArgumentAutocompleteRequest++;
  }

  function cancelPluginAutocomplete() {
    pluginAutocompleteRequest++;
  }

  function cancelSlashCommandMetadataAutocomplete() {
    slashCommandMetadataRequest++;
    if (!slashCommandMetadataTimer) return;
    clearTimeout(slashCommandMetadataTimer);
    slashCommandMetadataTimer = null;
  }

  function cancelAutocompleteRequests() {
    cancelFileAutocomplete();
    cancelCommandArgumentAutocomplete();
    cancelPluginAutocomplete();
    cancelSlashCommandMetadataAutocomplete();
  }

  function scheduleFileAutocomplete(text: string) {
    cancelFileAutocomplete();
    if (!hasFileSuggestionToken(text)) return false;

    const request = fileAutocompleteRequest;
    fileAutocompleteTimer = setTimeout(() => {
      fileAutocompleteTimer = null;
      const cwd = app.state.cwd;
      cancelPendingFileAutocomplete = getFileSuggestionsDeferred(text, cwd, 20, (fileResult) => {
        if (request !== fileAutocompleteRequest) return;
        cancelPendingFileAutocomplete = null;
        const currentText = textareaRef?.plainText ?? textareaRef?.editBuffer?.getText() ?? inputText();
        if (currentText !== text || props.selectionMode() !== null) return;
        if (fileResult) {
          props.setTabCompleting(false);
          props.setActiveCompletion(fileResult);
          props.showOverlay(fileResult.items);
        } else if (props.isOverlayVisible() && props.selectionMode() === null) {
          props.hideOverlay();
        }
      });
    }, 75);
    return true;
  }

  function isSlashCommandPrefix(text: string): boolean {
    return /^\/\S*$/u.test(text.trimStart());
  }

  function requestSlashCommandMetadata(text: string): void {
    const request = ++slashCommandMetadataRequest;
    if (slashCommandMetadataTimer) clearTimeout(slashCommandMetadataTimer);
    slashCommandMetadataTimer = setTimeout(() => {
      slashCommandMetadataTimer = null;
      const scheduledText = textareaRef?.plainText ?? textareaRef?.editBuffer?.getText() ?? inputText();
      if (scheduledText !== text || !isSlashCommandPrefix(scheduledText) || props.selectionMode() !== null) return;
      if (!promptFocused()) return;
      void (props.ensureSlashCommandMetadata?.() ?? Promise.resolve(false)).then((changed) => {
        if (!changed || request !== slashCommandMetadataRequest) return;
        const currentText = textareaRef?.plainText ?? textareaRef?.editBuffer?.getText() ?? inputText();
        if (currentText !== text || props.selectionMode() !== null || !promptFocused()) return;
        const next = getSlashSuggestions(currentText, props.getVisibleSlashCommands(app.state));
        if (!next) return;
        cancelFileAutocomplete();
        props.setTabCompleting(false);
        props.setActiveCompletion(next);
        props.showOverlay(next.items);
      });
    }, 50);
  }

  function commandAutocompleteContext(): RelayCommandContext {
    const activeThread = app.state.threads.find((thread) => thread.id === app.state.activeThreadId && !thread.archived);
    const running =
      app.state.connecting ||
      app.state.running ||
      activeThread?.status === "connecting" ||
      activeThread?.status === "running";
    return (
      props.commandContext?.() ?? {
        cwd: app.state.cwd,
        sessionId: props.currentSessionId() ?? activeThread?.sessionId ?? null,
        threadId: activeThread?.id ?? null,
        userMessageCount: app.state.blocks.filter(isUserMessageBlock).length,
        running,
        waitForIdle: () => Promise.resolve(),
        toast: () => undefined,
      }
    );
  }

  function scheduleCommandArgumentAutocomplete(text: string): boolean {
    const runner = props.pluginRunner?.();
    const commandRegistry = runner?.commands;
    if (!runner || !commandRegistry) return false;
    const commandNames = new Set(commandRegistry.list().map((entry) => entry.invocationName));
    const target = getSlashCommandArgumentTarget(text, commandNames);
    if (!target) return false;

    const registeredCommand = commandRegistry.find(target.commandName);
    const provider = registeredCommand?.command.getArgumentCompletions;
    if (!registeredCommand || !provider) return false;

    const request = ++commandArgumentAutocompleteRequest;
    let completionItems: readonly RelayAutocompleteItem[] | Promise<readonly RelayAutocompleteItem[]> | null;
    try {
      completionItems = provider(target.argsPrefix, commandAutocompleteContext());
    } catch (error) {
      runner.recordError(
        registeredCommand.plugin,
        `Plugin command completions failed: ${registeredCommand.name}`,
        error,
      );
      return true;
    }

    void Promise.resolve(completionItems)
      .then((items) => {
        if (request !== commandArgumentAutocompleteRequest) return;
        const currentText = textareaRef?.plainText ?? textareaRef?.editBuffer?.getText() ?? inputText();
        if (currentText !== text || props.selectionMode() !== null || !promptFocused()) return;
        const result = buildSlashCommandArgumentCompletion(target, items);
        if (result) {
          cancelFileAutocomplete();
          props.setTabCompleting(false);
          props.setActiveCompletion(result);
          props.showOverlay(result.items);
        } else if (props.isOverlayVisible() && props.selectionMode() === null) {
          props.hideOverlay();
        }
      })
      .catch((error) => {
        if (request !== commandArgumentAutocompleteRequest) return;
        runner.recordError(
          registeredCommand.plugin,
          `Plugin command completions failed: ${registeredCommand.name}`,
          error,
        );
      });
    return true;
  }

  function currentCursorOffset(text: string): number {
    const ref = textareaRef as PromptTextareaRef | null;
    if (!ref) return text.length;
    return ref.cursorOffset ?? getCursorOffset(ref, text);
  }

  function isPromiseLikeAutocompleteResult(
    value: RelayAutocompleteProviderResult | Promise<RelayAutocompleteProviderResult>,
  ): value is Promise<RelayAutocompleteProviderResult> {
    return typeof (value as { readonly then?: unknown }).then === "function";
  }

  function showPluginAutocompleteCompletion(result: CompletionResult<RelayAutocompleteItem> | null): void {
    if (result) {
      cancelFileAutocomplete();
      props.setTabCompleting(false);
      props.setActiveCompletion(result);
      props.showOverlay(result.items);
    } else if (props.isOverlayVisible() && props.selectionMode() === null) {
      props.hideOverlay();
    }
  }

  function schedulePluginAutocomplete(text: string): boolean {
    const runner = props.pluginRunner?.();
    if (!runner) return false;
    const providers = runner.editor.listAutocompleteProviders();
    if (providers.length === 0) return false;

    const cursorOffset = currentCursorOffset(text);
    for (const entry of providers) {
      const context = getRelayAutocompleteContext(text, app.state.cwd, cursorOffset, entry.provider.trigger);
      if (!context) continue;

      let provided: RelayAutocompleteProviderResult | Promise<RelayAutocompleteProviderResult>;
      try {
        provided = entry.provider.provide(context);
      } catch (error) {
        runner.recordError(entry.plugin, "Plugin autocomplete provider failed", error);
        return true;
      }

      if (isPromiseLikeAutocompleteResult(provided)) {
        const request = ++pluginAutocompleteRequest;
        void provided
          .then((items) => {
            if (request !== pluginAutocompleteRequest) return;
            const currentText = textareaRef?.plainText ?? textareaRef?.editBuffer?.getText() ?? inputText();
            if (currentText !== text || props.selectionMode() !== null || !promptFocused()) return;
            if (currentCursorOffset(currentText) !== context.cursorOffset) return;
            showPluginAutocompleteCompletion(
              buildPluginAutocompleteCompletion(context, items, entry.provider.applyCompletion),
            );
          })
          .catch((error) => {
            if (request !== pluginAutocompleteRequest) return;
            runner.recordError(entry.plugin, "Plugin autocomplete provider failed", error);
          });
        return true;
      }

      const completion = buildPluginAutocompleteCompletion(context, provided, entry.provider.applyCompletion);
      if (!completion) continue;
      showPluginAutocompleteCompletion(completion);
      return true;
    }

    return false;
  }

  function tryAutocomplete(text: string, source: InputUpdateSource | null) {
    if (props.variant === "queue-inline") {
      cancelAutocompleteRequests();
      if (props.isOverlayVisible() && props.selectionMode() === null) props.hideOverlay();
      return;
    }
    if (!promptFocused()) return;
    cancelCommandArgumentAutocomplete();
    cancelPluginAutocomplete();
    if (props.selectionMode() !== null) {
      cancelFileAutocomplete();
      props.filterOverlayItems(text);
      return;
    }

    if (source !== null) {
      cancelFileAutocomplete();
      return;
    }

    if (!suppressSlashAutocomplete()) {
      const slashPrefix = isSlashCommandPrefix(text);
      if (slashPrefix) requestSlashCommandMetadata(text);
      const slashResult =
        getReasoningEffortSuggestions(text, app.state.availableThinkingLevels, app.state.thinkingLevel) ??
        getSlashSuggestions(text, props.getVisibleSlashCommands(app.state));
      if (slashResult) {
        cancelFileAutocomplete();
        props.setTabCompleting(false);
        props.setActiveCompletion(slashResult);
        props.showOverlay(slashResult.items);
        return;
      }
    }

    if (scheduleCommandArgumentAutocomplete(text)) return;

    if (schedulePluginAutocomplete(text)) return;

    if (scheduleFileAutocomplete(text)) return;

    if (props.isOverlayVisible() && props.selectionMode() === null) {
      props.hideOverlay();
    }
  }

  const promptMarkerText = () => {
    const marker = bashPrefix() || promptMarker();
    return marker ? `${marker} ` : "";
  };

  function submitText(fullText: string): void {
    if (app.state.statusHint) props.resetDoublePressState();
    if (!fullText.trim()) {
      if (props.variant === "queue-inline") {
        showToast(EMPTY_QUEUE_EDIT_MESSAGE, "warning");
      }
      return;
    }
    const trimmedText = fullText.trim();
    const slashText = fullText.trimStart();
    const submitText = slashText.startsWith("/") ? slashText.replace(/[\t ]+$/u, "") : trimmedText;
    const mappingsForHistory = pasteStore.getPasteMappingsForText(trimmedText);
    const expanded = pasteStore.expandPasteMarkers(submitText);
    const promptSubmission = createPromptSubmission(expanded);
    const historyText = sanitizePromptImagesForHistory(trimmedText, promptSubmission.images);
    promptHistory.add(historyText, mappingsForHistory, props.currentSessionId());
    if (textareaRef) {
      try {
        textareaRef.clear();
      } catch {
        try {
          textareaRef.editBuffer?.clear();
        } catch {}
      }
    }
    setInputText("");
    setBashPrefixMode("");
    props.onPromptTextChanged(null, "");
    pasteStore.reset();
    props.handleSubmit(promptSubmission.images.length > 0 ? promptSubmission : expanded, app);
  }

  if (props.variant !== "composer-placeholder") props.setCompletedTextSubmitter?.(submitText);

  const ComposerInput = () => (
    <box width="100%" flexDirection="row" flexGrow={1} flexShrink={1}>
      <Show when={props.variant !== "queue-inline"}>
        <box width={promptMarkerText().length} flexShrink={0}>
          <text fg={promptMarkerColor()} wrapMode="none" attributes={createTextAttributes({ bold: true })}>
            {promptMarkerText()}
          </text>
        </box>
      </Show>
      <Show
        when={props.variant !== "composer-placeholder"}
        fallback={
          <box flexGrow={1} flexShrink={1}>
            <text fg={promptTextColor()} wrapMode="word">
              {inputText()}
            </text>
          </box>
        }
      >
        <textarea
          ref={(r: any) => {
            if (promptFocusTimer) {
              clearTimeout(promptFocusTimer);
              promptFocusTimer = null;
            }
            textareaRef = r;
            props.setTextareaRef(r);
            if (r) {
              installTextareaCursorPatch(r);
              syncTextareaCursor(r);
              if (inputText()) applyTextareaTextUpdate(r, inputText(), inputText().length);
              if (typeof r.focus === "function" && !promptDisabled()) {
                focusTextareaIfActive(r);
                promptFocusTimer = setTimeout(() => {
                  promptFocusTimer = null;
                  if (textareaRef !== r) return;
                  if (inputText()) applyTextareaTextUpdate(r, inputText(), inputText().length);
                  focusTextareaIfActive(r);
                }, 0);
              } else if (inputSuspended()) {
                blurTextarea(r);
              }
              installPasteHandler(r, pasteStore, refreshCurrentPasteHighlights);
            }
          }}
          flexGrow={1}
          flexShrink={1}
          wrapMode="word"
          scrollMargin={1}
          initialValue={inputText()}
          placeholder=""
          placeholderColor={layers.onUserPanelDim}
          textColor={promptTextColor()}
          focusedTextColor={pluginEditorState()?.theme.textColor ?? promptTextColor()}
          cursorStyle={promptCursorStyle()}
          showCursor={promptCursorVisible()}
          onMouseDown={(e: any) => e.target?.focus()}
          onMouseUp={(() => handlePasteMouseUp(textareaRef, pasteStore, refreshCurrentPasteHighlights)) as any}
          keyBindings={PROMPT_ENTER_KEY_BINDINGS}
          onContentChange={
            (() => {
              if (textareaRef) {
                const rawValue = textareaRef.plainText ?? textareaRef.editBuffer?.getText() ?? "";
                if (restoringSuspendedInput || normalizingBashPrefixInput) return;
                if (inputSuspended()) {
                  const previousText = inputText();
                  if (rawValue !== previousText) restoreSuspendedTextareaValue(textareaRef, previousText);
                  return;
                }
                const val = normalizeBashPrefixInput(rawValue);
                const source = props.consumeInputUpdateSource(rawValue) ?? props.consumeInputUpdateSource(val);
                setInputText(val);
                refreshPasteHighlights(textareaRef, pasteStore, colors, knownSlashCommandNames());
                props.onPromptTextChanged(source, val);
                tryAutocomplete(val, source);
                if (app.state.statusHint) props.resetDoublePressState();
              }
            }) as any
          }
          onCursorChange={(() => {}) as any}
          onSubmit={() => {
            if (props.isOverlayVisible()) {
              props.selectOverlayItem(app, true);
              return;
            }

            const text = currentTextareaText();
            submitText(`${bashPrefix()}${text}`);
          }}
        />
      </Show>
    </box>
  );

  const setPromptBoxRef = (r: any) => {
    promptBoxRef = r;
  };

  return (
    <box
      width="100%"
      flexDirection="column"
      flexShrink={0}
      minHeight={UI_COMPOSER_MIN_HEIGHT}
      maxHeight={maxPromptHeight()}
    >
      <Show
        when={framedEditor()}
        fallback={
          <box
            ref={setPromptBoxRef}
            width="100%"
            flexDirection="column"
            flexGrow={1}
            flexShrink={1}
            minHeight={pluginEditorState()?.options.minHeight ?? UI_COMPOSER_MIN_HEIGHT}
            backgroundColor={promptBackgroundColor()}
            paddingTop={1}
            paddingBottom={1}
            paddingLeft={1}
            paddingRight={1}
          >
            <ComposerInput />
          </box>
        }
      >
        <box
          ref={setPromptBoxRef}
          width="100%"
          flexDirection="column"
          flexGrow={1}
          flexShrink={1}
          minHeight={pluginEditorState()?.options.minHeight ?? UI_COMPOSER_MIN_HEIGHT}
          borderStyle={pluginEditorState()?.options.borderStyle ?? (nativePiStyle() ? "single" : "rounded")}
          borderColor={frameBorderColor()}
          renderAfter={drawPluginPromptBorder}
          paddingLeft={pluginEditorState()?.options.paddingX ?? (nativePiStyle() ? 0 : paddingX())}
          paddingRight={pluginEditorState()?.options.paddingX ?? (nativePiStyle() ? 0 : paddingX())}
        >
          <ComposerInput />
        </box>
      </Show>
    </box>
  );
}

export { promptHistory, copySelectionWithPasteExpansion, applyFileCompletion, applySlashCompletion };
