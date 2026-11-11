/**
 * Main TUI application.
 *
 * Uses @opentui/solid + SolidJS for rendering.
 */

import { createEffect, createSignal, onMount, onCleanup } from "solid-js";
import { mergeSessionCapabilities, store } from "./app/runtime-store";
import { useKeyboard, useRenderer, useSelectionHandler } from "@opentui/solid";
import type { CliRenderer, Selection } from "@opentui/core";
import type { AppProps } from "./app/types";
export type { AppProps, LaunchOptions } from "./app/types";
import { getSpinnerChar } from "./app/spinner";
import { stopTurnTimer } from "./app/turn-timer";
import { readTextareaText, terminalColumns } from "./app/terminal";
import {
  applyAcpClientCapabilities,
  applyPreferredModelForNewSession,
  applyPreferredThinkingLevelForNewSession,
  connectAcpClientWithTimeout,
} from "./app/acp-client-controller";
import { formatConnectionFailure } from "./app/connection";
import { formatConfigWarningMessage, pluginsConfigFingerprint } from "./app/config-helpers";
import * as path from "path";
import { acpThreadEventFromSessionUpdate, textFromAcpThreadContent } from "../acp/thread-events";
import {
  getConfig,
  getConfigLoadResult,
  setAgentPreferredModel,
  setAgentPreferredThinkingLevel,
  setTheme as setConfigTheme,
  startConfigWatcher,
  subscribeConfig,
} from "../config";
import { type ConfigSetting } from "../config/schema";
import { Effect } from "effect";
import { setTerminalNotifier } from "../notify";
import { type FileChanges } from "../core/types";
import { parseThinkingLevel, type ThinkingLevel } from "../core/thinking";
import {
  type AppState,
  type ChatBlock,
  type QueuedPrompt,
  type ElicitationBlock,
  type SessionConfigOptionState,
  type SessionModelOption,
  type SessionModeOption,
  type SessionThinkingLevelOption,
  useApp,
  nextBlockId,
} from "./state";
import { copyToClipboard, setClipboardOscWriter } from "./util/clipboard";
import {
  type ListItem,
  type CompletionResult,
  type SlashCommand,
  SelectionMode,
  PathCompleter,
  getKnownSlashCommandNames,
  getSlashSuggestions,
  applySlashCompletion,
  applyFileCompletion,
  applyPluginCompletion,
  applyPluginCompletionSelection,
} from "./autocomplete";
import { pasteStore } from "./paste";
import {
  applyTextareaTextUpdate,
  getCursorOffset,
  insertImagePathAtCursor,
  restorePasteMappings,
} from "./util/paste-textarea";
import { refreshPasteHighlights } from "./util/paste-highlights";
import { resolveAgentProfile } from "./tool-renderers";
import { resolveAgentBehaviorProfile } from "../acp/agent-profile";
import { AcpClient, type AcpSessionInfo } from "../acp/client";
import type { AcpClientOptions } from "../acp/client";
import type { RelayAuthMethod } from "../acp/capabilities";
import type { RelaySessionUpdate } from "../acp/sdk";
import { startupProcessExitSettle } from "../acp/process-exit";
import { disposeAcpClientsForShutdown } from "../acp/shutdown";
import { createBuiltinSkillController, type BuiltinSkillController } from "./app/builtin-skills";
import { createHandoffController, type HandoffController } from "./app/handoff";
import {
  acpLaunchOptionsForAgent,
  resolveAcpLaunchAgent,
  resolveAgentBehaviorProfileForLaunchAgent,
  startAcpSession,
  type ResolvedAcpLaunchAgent,
} from "../application/acp-orchestration";
import { GitBranchWatcher } from "../core/git-branch-watcher";
import {
  PluginRunner,
  type RelayAutocompleteItem,
  type RelayCommandContext,
  type RelayPluginChatBlockInput,
  type RelayPluginForkSessionOptions,
  type RelayPluginInfo,
  type RelayPluginSessionResult,
  type RelayPluginStatus,
  type RelayConversationSnapshot,
  type RelayPluginThreadCreateOptions,
  type RelayPluginThreadInfo,
  type RelayPluginThreadSessionInfo,
  type RelayWidgetPlacement,
} from "../plugins";
import {
  additionalDirectoriesForThread,
  createRelaySessionId,
  discoverThreadWorktreeCandidates,
  loadThreadsForWorkspace,
  relaySessionNameFromId,
  threadRelaySessionName,
  type ThreadInfo,
} from "../core/threads";
import { errorMessage } from "../effect/errors";
import { runUiEffect } from "../effect/runtime";
import { getRelayLogger } from "../logging/logger";
import { visibleSlashCommands } from "./app/slash-commands";
import { createAppStateValue } from "./context/app-state";
import { createToastValue } from "./ui/toast";
import { getColors, invalidateSyntaxStyle } from "./context/theme";
import { promptHistory, copySelectionWithPasteExpansion, type InputUpdateSource } from "./component/composer";
import type { PromptHistorySearchEntry } from "../prompt-history";
import type { SlashPanelPosition } from "./component/floating-list";
import { ChatRoute } from "./routes/chat";
import { printExitMessage as printExitSummary } from "./util/exit-message";
import { openUrl } from "./util/links";
import { truncateTextEnd } from "./util/format";
import {
  SETTING_VALUE_CHOICES,
  formatSettingValue,
  type AcpConfigOptionValueItem,
  type SettingsItem,
  type SettingsSubmenuId,
} from "./util/settings";
import { type PluginSettingsItem } from "./util/plugins";
import { getReasoningEffortSuggestions } from "./util/reasoning-effort";
import {
  addWelcomeBlocks,
  applySessionCapabilities,
  formatSessionAge,
  sessionCapabilitiesWithConfigOptionValue,
  type SessionCapabilitiesResult,
} from "./context/session";
import { openTextInExternalEditor } from "./util/external-editor";
import { runTerminalAuthCommand } from "./util/terminal-auth";
import { isComposerPromptFocused, type ComposerInputOwner } from "./util/composer-input";
import { findPendingApprovalBlock } from "./app/approval-block";
import { getVimStatus, initialVimState, type VimState } from "./util/vim-engine";
import { previewFromBlocks } from "./util/thread-preview";
import { refreshVimSelectionHighlight } from "./util/vim-selection-highlight";
import { TRANSCRIPT_RENDERER_ROLLOUT_DEFAULT } from "./util/transcript-renderer-mode";
import {
  clearPluginDiffOverlay,
  closeDiffOverlay,
  diffOverlayCommand,
  diffOverlayRequest,
  fileChangesModalOpen,
  openPluginDiffOverlay,
  setDiffOverlayOpen,
  setFileChangesModalOpen,
} from "./app/diff-overlay-controller";
import {
  finishElicitation as finishElicitationWithReset,
  navigateElicitationField as navigateElicitationFieldWithIndex,
  pendingElicitationBlock,
  selectElicitationChoice as selectElicitationChoiceWithIndex,
} from "./app/elicitation";
import { setShowToast, showToast } from "./app/toast-controller";
import { useManagedTerminalTitle } from "./app/terminal-title-controller";
import {
  formatPluginLoadFailures,
  initializeRelayPlugins,
  prepareRelayPlugins,
  registerPreparedRelayPlugins,
  startPreparedRelayPlugins,
} from "./app/plugin-lifecycle";
import {
  currentPluginMcpAppliedSnapshot,
  disposePluginRunner,
  emitPluginEvent,
  resetPluginMcpAppliedSnapshot,
  setPluginRunner as setPluginRuntimeRunner,
  shutdownPluginRunner,
  withPluginMcpServers,
} from "./app/plugin-runtime";
import { resetPromptDispatchState } from "./app/prompt-dispatch";
import {
  currentThread,
  setThreadMetadataRootCwd,
  syncCurrentThreadSession,
  syncCurrentThreadStatus,
} from "./app/thread-metadata";
import {
  activeStartupTips,
  resetStartupTipsDismissal,
  setStatusIndicatorStateSetter,
  shouldResetIdleStartupTip,
  startStartupTips,
  stopStartupTips,
} from "./app/status-indicators";
import {
  filterListItems,
  filterListItemsBySubstringInOrder,
  orderedOverlayIndexAfterFilter,
  overlayIndexAfterFilter,
} from "./app/overlay-filter";
import { agentCommandCacheKey, readCachedAgentCommands } from "./app/agent-command-cache";
import { resetCtrlCState } from "./app/ctrl-c-exit";
import { createAppKeyboardHandler } from "./app/keyboard-handler";
import { createSlashCommandHandler } from "./app/slash-command-handler";
import { createSettingsOverlayController } from "./app/settings-overlay-controller";
import { createSessionController } from "./app/session-controller";
import { sanitizeInternalThreadTitle } from "./app/session-policy";
import { createQueueController, type QueueInteractionState } from "./app/queue-controller";
import { createInputHandlers } from "./app/input-handlers";
import { createSubmitController } from "./app/submit-controller";
import { createThreadController } from "./app/thread-controller";
import { createThreadQueueStore } from "./app/thread-queue";
import { withLiveSessionEnv } from "./app/live-session-runtime";
import { createLiveSessionController } from "./app/live-session-controller";
import { createPluginDialogController } from "./app/plugin-dialogs";
import { createNativeModalController } from "./app/native-modal-controller";
import type { SelectionOverlayBehavior } from "./app/selection-overlay";
import type { TranscriptSelectionCoordinator } from "./util/transcript-selection";
import { formatRelayConversationMarkdown } from "./app/conversation-export";
import { snapshotRelayConversation } from "./app/plugin-conversation";
import { flushTelemetry } from "../telemetry";
import { flushTelemetryBeforeExit } from "../telemetry-shutdown";
import { startLiveSessionControlServer, type LiveSessionControlServer } from "../platform/live-session-control";

export { previewFromBlocks };

type ResolvedLaunchAgent = ResolvedAcpLaunchAgent;

// ACP client instance for the configured agent process.
let _appInstanceCounter = 0;
let _pluginRevisionBump: (() => void) | null = null;
let _reloadPlugins: ((reason: "reload" | "error") => Promise<void>) | null = null;

// Abort controller for the currently running user ! / !! bash command.
let _userBashAbortController: AbortController | null = null;
let _transcriptSelectionCoordinator: TranscriptSelectionCoordinator | null = null;

// Global reference to the textarea for history navigation
let _textareaRef: any = null;
let _completedTextSubmitter: ((text: string) => void) | null = null;
let _composerInputOwner: (() => ComposerInputOwner) | null = null;
let _openPromptInExternalEditor: ((initialText?: string) => Promise<void> | void) | null = null;
let _builtinSkillController: BuiltinSkillController | null = null;
let _nativeHandoffController: HandoffController | null = null;
const PLUGIN_WIDGET_PLACEMENTS = [
  "appHeader",
  "editorHeader",
  "aboveEditor",
  "belowEditor",
  "sidebar",
  "modal",
  "overlay",
  "welcome",
  "welcomeAddon",
] as const satisfies readonly RelayWidgetPlacement[];

// ===========================================================================
// Overlay / floating list state (module-level for cross-component access)
// ===========================================================================

/** Current items displayed in the floating list. Empty = hidden. */
const [overlayItems, setOverlayItems] = createSignal<ListItem<any>[]>([]);
/** Whether the floating list is open. It may be open with zero matches. */
const [overlayVisible, setOverlayVisible] = createSignal(false);
/** Currently selected index in the overlay. */
const [overlayIndex, setOverlayIndex] = createSignal(0);
/** Current selection mode (null = autocomplete, non-null = model/theme/session/etc). */
const [selectionMode, setSelectionMode] = createSignal<SelectionMode | null>(null);
/** The active CompletionResult (for autocomplete apply). */
let _activeCompletion: CompletionResult | null = null;
type PendingInputUpdate = {
  source: InputUpdateSource;
  text: string;
};

let _pendingInputUpdate: PendingInputUpdate | null = null;
const [composerText, setComposerText] = createSignal("");

function markInputUpdateSource(source: InputUpdateSource, text: string) {
  _pendingInputUpdate = { source, text };
}

function consumeInputUpdateSource(text: string) {
  const pending = _pendingInputUpdate;
  if (!pending) return null;
  _pendingInputUpdate = null;
  return pending.text === text ? pending.source : null;
}

function onPromptTextChanged(source: InputUpdateSource | null, text: string) {
  setComposerText(text);
  if (source === null && text.length === 0 && _appSetState) {
    const state = _appGetState?.();
    if (store.acpClient && state && shouldResetIdleStartupTip(state)) startStartupTips({ setState: _appSetState });
  }
  if (source === "history") {
    hideOverlay();
    return;
  }
  if (source === null && promptHistory.isBrowsing()) {
    promptHistory.reset();
  }
  if (source !== "queue" && (source !== null || text.trim())) {
    setQueueFocusIndex(null);
  }
}

// Tab path completion state
let _tabCompleting = false;
let _tabStartOffset = 0; // char offset in full text where path fragment started
let _tabBaseFragment = ""; // directory prefix for tab-complete list items
const _pathCompleter = new PathCompleter();

type OverlayDescriptionColumnLayout = {
  maxWidth?: number;
  minWidth?: number;
  align?: "left" | "right";
};

type OverlayLayout = {
  labelMinWidth?: number;
  labelMaxWidth?: number;
  descriptionMaxWidth?: number;
  viewportReservedWidth?: number;
  descriptionColumns?: readonly OverlayDescriptionColumnLayout[];
  descriptionColumnGap?: string;
};

type ResolvedOverlayLayout = Required<Omit<OverlayLayout, "descriptionColumns">> & {
  descriptionColumns: readonly OverlayDescriptionColumnLayout[];
};

const DEFAULT_OVERLAY_LAYOUT: ResolvedOverlayLayout = {
  labelMinWidth: 0,
  labelMaxWidth: 42,
  descriptionMaxWidth: 60,
  viewportReservedWidth: 12,
  descriptionColumns: [],
  descriptionColumnGap: " · ",
};

const MAX_OVERLAY_VISIBLE = 8;
let _selectionAllItems: ListItem<any>[] = [];
let _selectionBehavior: SelectionOverlayBehavior | null = null;
let _sessionOverlayLoadRunId = 0;
const [overlayLayout, setOverlayLayout] = createSignal<ResolvedOverlayLayout>(DEFAULT_OVERLAY_LAYOUT);
const [approvalOptionIndex, setApprovalOptionIndex] = createSignal(0);
const [elicitationOptionIndex, setElicitationOptionIndex] = createSignal(0);
const [settingsOverlayActive, setSettingsOverlayActive] = createSignal(false);
const [slashPanelPosition, setSlashPanelPosition] = createSignal<SlashPanelPosition>(
  getConfig().ui.slash_panel_position,
);
let _activeSettingsSubmenu: SettingsSubmenuId | null = null;

/** Show overlay with items. */
function showOverlay(
  items: ListItem<any>[],
  mode: SelectionMode | null = null,
  layout?: OverlayLayout,
  selectedIndex = 0,
) {
  setOverlayItems(items);
  setOverlayVisible(true);
  setOverlayIndex(Math.max(0, Math.min(selectedIndex, items.length - 1)));
  setSelectionMode(mode);
  setOverlayLayout({
    ...DEFAULT_OVERLAY_LAYOUT,
    ...(layout ?? {}),
  });
}

/** Hide overlay. */
function hideOverlay() {
  setOverlayVisible(false);
  setOverlayItems([]);
  setOverlayIndex(0);
  setSelectionMode(null);
  setSettingsOverlayActive(false);
  _activeSettingsSubmenu = null;
  _activeSettingsValueSetting = null;
  setOverlayLayout(DEFAULT_OVERLAY_LAYOUT);
  _activeCompletion = null;
  _selectionBehavior = null;
  _tabCompleting = false;
  _tabStartOffset = 0;
  _tabBaseFragment = "";
}

/** Is the overlay visible? */
function isOverlayVisible(): boolean {
  return overlayVisible();
}

function isSlashAutocompleteOverlay(): boolean {
  if (!isOverlayVisible()) return false;
  if (selectionMode() !== null) return false;
  if (_tabCompleting) return false;
  if (!_activeCompletion) return false;
  return _activeCompletion.kind === "slash" || _activeCompletion.kind === "slash-argument";
}

function isTextareaOverlay(): boolean {
  if (!isOverlayVisible()) return false;
  return selectionMode() !== null || _activeCompletion !== null;
}

function refreshCurrentPasteHighlights() {
  refreshPasteHighlights(
    _textareaRef,
    pasteStore,
    getColors(),
    getKnownSlashCommandNames(getVisibleSlashCommands(_appGetState?.() ?? null)),
  );
}

function resetVimState(): void {
  setVimState(initialVimState);
  refreshVimSelectionHighlight(_textareaRef, initialVimState, getColors());
}

function filterOverlayItems(query: string) {
  const mode = selectionMode();
  if (
    mode === null ||
    mode === SelectionMode.SESSION_LOADING ||
    mode === SelectionMode.PLUGINS ||
    mode === SelectionMode.PLUGIN_DETAILS
  )
    return;
  const previousValue = overlayItems()[overlayIndex()]?.value;
  const isSettingsSearch = mode === SelectionMode.SETTINGS;
  const includeDescription = !isSettingsSearch;
  if (mode === SelectionMode.TREE) {
    const filtered = filterListItemsBySubstringInOrder(_selectionAllItems, query, { includeDescription });
    setOverlayItems(filtered);
    setOverlayIndex(orderedOverlayIndexAfterFilter(_selectionAllItems, filtered, previousValue));
    return;
  }
  const filtered = filterListItems(_selectionAllItems, query, { includeDescription });
  setOverlayItems(filtered);
  setOverlayIndex(overlayIndexAfterFilter(filtered, previousValue, isSettingsSearch && query.trim().length > 0));
}

function showSelectionOverlay(
  items: ListItem<any>[],
  mode: SelectionMode,
  layout?: OverlayLayout,
  selectedIndex = 0,
  behavior?: SelectionOverlayBehavior,
) {
  _selectionAllItems = items;
  _selectionBehavior = behavior ?? null;
  setSettingsOverlayActive(mode === SelectionMode.SETTINGS);
  showOverlay(items, mode, layout, selectedIndex);
  setTimeout(() => {
    if (_textareaRef) {
      try {
        _textareaRef.setText("");
      } catch {}
      try {
        _textareaRef.focus();
      } catch {}
    }
  }, 0);
}

function openPromptHistorySearch(): void {
  const entries = promptHistory.searchEntries({
    sessionId: store.acpClient?.sessionId,
    allowGlobalContinuation: store.allowGlobalPromptHistoryContinuation,
  });
  if (entries.length === 0) {
    showToast("No prompt history", "info");
    return;
  }
  const items: ListItem<PromptHistorySearchEntry>[] = entries.map((entry) => ({
    value: entry,
    label: truncateTextEnd(entry.text.replace(/\s+/g, " "), 120),
    description: formatSessionAge(entry.timestamp),
  }));
  showSelectionOverlay(
    items,
    SelectionMode.PROMPT_HISTORY,
    {
      labelMinWidth: 42,
      labelMaxWidth: 120,
      descriptionMaxWidth: 10,
      viewportReservedWidth: 8,
    },
    0,
    {
      onSelect: (item) => {
        const entry = item.value as PromptHistorySearchEntry;
        markInputUpdateSource("history", entry.text);
        try {
          _textareaRef?.setText(entry.text);
        } catch {}
        restorePasteMappings(pasteStore, entry.pasteMappings);
        refreshCurrentPasteHighlights();
      },
    },
  );
}

function resetElicitationOptionIndex(): void {
  setElicitationOptionIndex(0);
}

function cancelElicitation(app: ReturnType<typeof useApp>, block: ElicitationBlock): void {
  finishElicitationWithReset(app, block, { action: "cancel" }, resetElicitationOptionIndex);
}

function selectElicitationChoice(app: ReturnType<typeof useApp>, block: ElicitationBlock): void {
  selectElicitationChoiceWithIndex(app, block, elicitationOptionIndex(), setElicitationOptionIndex);
}

function navigateElicitationField(app: ReturnType<typeof useApp>, block: ElicitationBlock, delta: -1 | 1): void {
  navigateElicitationFieldWithIndex(app, block, delta, setElicitationOptionIndex);
}

type PluginCompletionValue = RelayAutocompleteItem;

function clearOverlayPromptText(): void {
  if (!_textareaRef) return;
  try {
    _textareaRef.setText("");
  } catch {}
}

function closeSelectionOverlay(): void {
  hideOverlay();
  _selectionAllItems = [];
  clearOverlayPromptText();
}

function selectOverlayItem(app: ReturnType<typeof useApp>, submitSlashCompletion = false) {
  const items = overlayItems();
  const idx = overlayIndex();
  const item = items[idx];
  if (!item) return;
  const mode = selectionMode();
  if (mode === null) {
    if (_tabCompleting) applyTabPathCompletion(item as ListItem<string>, app);
    else if (_activeCompletion && _textareaRef) {
      const currentText = getTextareaText();
      const selected = item as ListItem<string | SlashCommand | PluginCompletionValue>;
      const completionKind = _activeCompletion.kind ?? (typeof selected.value !== "string" ? "slash" : "file");
      const isSlashCompletion = completionKind === "slash";
      const isPluginCompletion = completionKind === "plugin";
      const isSlashArgumentCompletion = completionKind === "slash-argument";
      if (isPluginCompletion) {
        const pluginSelected = selected as ListItem<PluginCompletionValue>;
        const onSelect = pluginSelected.value.onSelect;
        if (onSelect) {
          hideOverlay();
          void Promise.resolve(onSelect()).catch((error) =>
            showToast(`Plugin completion failed: ${error instanceof Error ? error.message : String(error)}`, "error"),
          );
          return;
        }
      }
      const isPluginStyleCompletion = isPluginCompletion || isSlashArgumentCompletion;
      let appliedPluginCompletion: { readonly text: string; readonly cursorOffset: number } | null = null;
      if (isPluginCompletion) {
        try {
          appliedPluginCompletion = applyPluginCompletionSelection(
            currentText,
            _activeCompletion as CompletionResult<PluginCompletionValue>,
            selected as ListItem<PluginCompletionValue>,
            app.state.cwd,
            getCursorOffset(_textareaRef, currentText),
          );
        } catch (error) {
          hideOverlay();
          showToast(`Plugin completion failed: ${error instanceof Error ? error.message : String(error)}`, "error");
          return;
        }
      }
      const nextText = appliedPluginCompletion
        ? appliedPluginCompletion.text
        : isSlashArgumentCompletion
          ? applyPluginCompletion(
              currentText,
              _activeCompletion as CompletionResult<{ readonly insertText?: string }>,
              selected as ListItem<{ readonly insertText?: string }>,
            )
          : isSlashCompletion
            ? applySlashCompletion(currentText, _activeCompletion, selected as ListItem<SlashCommand>)
            : applyFileCompletion(currentText, _activeCompletion, selected as ListItem<string>, app.state.cwd);
      const replacedEnd =
        _activeCompletion.replaceEnd ??
        _activeCompletion.tokenStart + (isPluginStyleCompletion ? 0 : 1) + _activeCompletion.query.length;
      const textAfterCompletion = currentText.slice(replacedEnd);
      const cursorOffset = appliedPluginCompletion
        ? appliedPluginCompletion.cursorOffset
        : nextText.length - textAfterCompletion.length;
      if (submitSlashCompletion && (isSlashCompletion || isSlashArgumentCompletion)) {
        hideOverlay();
        _completedTextSubmitter?.(nextText);
        return;
      }
      markInputUpdateSource("completion", nextText);
      applyTextareaTextUpdate(_textareaRef, nextText, cursorOffset);
      hideOverlay();
      refreshOpenSlashAutocomplete();
    }
    return;
  }
  if (mode === SelectionMode.SESSION_LOADING) {
    const session = item.value as Partial<AcpSessionInfo> | null;
    if (session?.sessionId) showToast("Another session is already loading", "warning");
    return;
  }
  if (mode === SelectionMode.SESSION) {
    const session = item.value as AcpSessionInfo;
    const client = store.acpClient;
    if (!client) {
      closeSelectionOverlay();
      return;
    }

    // Keep the resume picker mounted while loadSession resets/replays the thread.
    // Loading copy belongs in the status line; leave the session rows unchanged.
    const overlayLoadRunId = ++_sessionOverlayLoadRunId;
    setSelectionMode(SelectionMode.SESSION_LOADING);
    loadSession(session.sessionId, app, client, activeThreadAgentName(app), session.title, session.cwd)
      .catch((err) => showToast(`Failed to load session: ${err}`, "error"))
      .finally(() => {
        if (overlayLoadRunId !== _sessionOverlayLoadRunId) return;
        if (selectionMode() === SelectionMode.SESSION_LOADING) closeSelectionOverlay();
      });
    return;
  }
  const behavior = _selectionBehavior;
  if (behavior) {
    if (behavior.closeOnSelect !== false) closeSelectionOverlay();
    behavior.onSelect(item, app);
    return;
  }
  closeSelectionOverlay();
}

function activeThreadAgentName(app: ReturnType<typeof useApp>): string {
  return currentThread(app)?.agentName ?? store.activeAgentName;
}

async function ensureActiveThreadSession(app: ReturnType<typeof useApp>): Promise<void> {
  const thread = app.state.threads.find((item) => item.id === app.state.activeThreadId && !item.archived);
  if (!thread) return;
  const { client } = await ensureThreadSession(app, thread);
  store.acpClient = client;
  applyAcpClientCapabilities(app, client);
}

async function ensureSlashCommandMetadata(app: ReturnType<typeof useApp>): Promise<boolean> {
  const thread = currentThread(app);
  if (!thread || thread.sessionId || app.state.connecting || app.state.running) return false;
  try {
    await ensureActiveThreadSession(app);
    return true;
  } catch {
    return false;
  }
}

async function switchSessionModel(app: ReturnType<typeof useApp>, modelId: string): Promise<void> {
  await ensureActiveThreadSession(app);
  if (!store.acpClient) throw new Error("No ACP agent configured"); // effect-shape-allow: UI event bridge requires initialized ACP client.
  const modelConfigId = app.state.modelConfigId;
  if (!modelConfigId) throw new Error("No ACP model switcher advertised by this agent"); // effect-shape-allow: UI event bridge reports unsupported native command.
  if (app.state.availableModels.length > 0 && !app.state.availableModels.some((option) => option.modelId === modelId)) {
    throw new Error(`Model "${modelId}" was not advertised by this agent`); // effect-shape-allow: UI event bridge reports unsupported native command.
  }
  const sessionResult = await store.acpClient.setSessionModel(modelId, modelConfigId);
  applyConfigOptionSetResult(app, sessionResult, modelConfigId, modelId);
  app.setState("modelId", modelId);
  emitPluginEvent({ type: "model:change", modelId });
  const agentName = activeThreadAgentName(app);
  if (!agentName) return;
  try {
    setAgentPreferredModel(agentName, modelId);
  } catch (err) {
    showToast(`Model switched, but preference was not saved: ${err}`, "warning", 4000);
  }
}

type SessionCycleOptions<T> = {
  readonly items: () => readonly T[];
  readonly currentId: () => string;
  readonly itemId: (item: T) => string;
  readonly emptyMessage: string;
  readonly apply: (item: T) => Promise<void>;
  readonly successMessage: (item: T) => string;
  readonly failureLabel: string;
};

function cycleSessionOptionFromKeyboard<T>(
  app: ReturnType<typeof useApp>,
  direction: 1 | -1,
  options: SessionCycleOptions<T>,
): void {
  void ensureActiveThreadSession(app)
    .then(async () => {
      const items = options.items();
      if (items.length === 0) {
        showToast(options.emptyMessage, "info");
        return;
      }
      const currentIndex = items.findIndex((item) => options.itemId(item) === options.currentId());
      const baseIndex = currentIndex >= 0 ? currentIndex : direction === 1 ? -1 : 0;
      const nextItem = items[(baseIndex + direction + items.length) % items.length];
      if (!nextItem) return;
      await options.apply(nextItem);
      showToast(options.successMessage(nextItem));
    })
    .catch((err) => showToast(`Failed to set ${options.failureLabel}: ${err}`, "error"));
}

function cycleSessionModelFromKeyboard(app: ReturnType<typeof useApp>, direction: 1 | -1): void {
  cycleSessionOptionFromKeyboard(app, direction, {
    items: () => app.state.availableModels,
    currentId: () => app.state.modelId,
    itemId: (model) => model.modelId,
    emptyMessage: "No models available",
    apply: (model) => switchSessionModel(app, model.modelId),
    successMessage: (model) => `Model: ${model.modelId}`,
    failureLabel: "model",
  });
}

async function switchSessionThinkingLevel(app: ReturnType<typeof useApp>, thinkingLevel: ThinkingLevel): Promise<void> {
  await ensureActiveThreadSession(app);
  if (!store.acpClient) throw new Error("No ACP agent configured"); // effect-shape-allow: UI event bridge requires initialized ACP client.
  if (!app.state.thinkingConfigId) throw new Error("No ACP thinking level switcher advertised by this agent"); // effect-shape-allow: UI event bridge reports unsupported native command.
  if (!app.state.availableThinkingLevels.some((option) => option.id === thinkingLevel)) {
    throw new Error(`Thinking level "${thinkingLevel}" was not advertised by this agent`); // effect-shape-allow: UI event bridge reports unsupported native command.
  }
  const sessionResult = await store.acpClient.setSessionThinkingLevel(thinkingLevel, app.state.thinkingConfigId);
  applyConfigOptionSetResult(app, sessionResult, app.state.thinkingConfigId, thinkingLevel);
  app.setState("thinkingLevel", thinkingLevel);
  const agentName = activeThreadAgentName(app);
  if (!agentName) return;
  try {
    setAgentPreferredThinkingLevel(agentName, thinkingLevel);
  } catch (err) {
    showToast(`Thinking level switched, but preference was not saved: ${err}`, "warning", 4000);
  }
}

function cycleSessionThinkingLevelFromKeyboard(app: ReturnType<typeof useApp>, direction: 1 | -1): void {
  cycleSessionOptionFromKeyboard(app, direction, {
    items: () => app.state.availableThinkingLevels,
    currentId: () => app.state.thinkingLevel,
    itemId: (level) => level.id,
    emptyMessage: "No thinking levels available",
    apply: (level) => switchSessionThinkingLevel(app, level.id),
    successMessage: (level) => `Thinking: ${level.name || level.id}`,
    failureLabel: "thinking level",
  });
}

async function setSessionConfigOption(
  app: ReturnType<typeof useApp>,
  option: SessionConfigOptionState,
  value: string,
): Promise<void> {
  await ensureActiveThreadSession(app);
  if (!store.acpClient) throw new Error("No ACP agent configured"); // effect-shape-allow: UI event bridge requires initialized ACP client.
  const sessionResult = await store.acpClient.setSessionConfigOption(option.id, value);
  applyConfigOptionSetResult(app, sessionResult, option.id, value);
}

function cacheActiveThreadSessionCapabilities(
  app: ReturnType<typeof useApp>,
  sessionResult: SessionCapabilitiesResult,
): void {
  if (app.state.activeThreadId) {
    store.threadSessionCapabilities.set(
      app.state.activeThreadId,
      mergeSessionCapabilities(store.threadSessionCapabilities.get(app.state.activeThreadId), sessionResult),
    );
  }
}

function applyConfigOptionSetResult(
  app: ReturnType<typeof useApp>,
  sessionResult: SessionCapabilitiesResult,
  optionId: string,
  value: string,
): SessionCapabilitiesResult {
  const appliedSessionResult =
    sessionResult.configOptions === undefined
      ? (sessionCapabilitiesWithConfigOptionValue(
          { ...sessionResult, configOptions: app.state.sessionConfigOptions },
          optionId,
          value,
        ) ?? sessionResult)
      : sessionResult;
  applySessionCapabilities(app, appliedSessionResult);
  cacheActiveThreadSessionCapabilities(app, appliedSessionResult);
  return appliedSessionResult;
}

function isSlashCommandPrefix(text: string): boolean {
  return /^\/\S*$/u.test(text.trimStart());
}

function promptInputFocused(): boolean {
  const owner = _composerInputOwner?.();
  if (owner) return isComposerPromptFocused(owner);
  return _textareaRef ? Reflect.get(_textareaRef, "_focused") === true : false;
}

function activeThreadAcceptsSlashAutocompleteRefresh(state: AppState): boolean {
  if (state.connecting || state.running) return false;
  const activeThread = state.threads.find((thread) => thread.id === state.activeThreadId && !thread.archived);
  if (!activeThread) return false;
  return activeThread.status !== "connecting" && activeThread.status !== "running";
}

function currentSlashAutocompleteTextForCommandUpdate(): string | null {
  const state = _appGetState?.();
  if (!state || !activeThreadAcceptsSlashAutocompleteRefresh(state)) return null;
  if (editingQueueItem() !== null) return null;
  if (!promptInputFocused()) return null;
  if (selectionMode() !== null) return null;
  if (isOverlayVisible() && !isSlashAutocompleteOverlay()) return null;
  const currentText = getTextareaText();
  return isSlashCommandPrefix(currentText) ? currentText : null;
}

function refreshSlashAutocomplete(options: { allowOpen: boolean }) {
  const slashOverlayOpen = isSlashAutocompleteOverlay();
  if (!options.allowOpen && !slashOverlayOpen) return;

  const currentText = options.allowOpen ? currentSlashAutocompleteTextForCommandUpdate() : getTextareaText();
  if (currentText === null) return;
  const state = _appGetState?.() ?? null;
  const next =
    getReasoningEffortSuggestions(currentText, state?.availableThinkingLevels ?? [], state?.thinkingLevel ?? "") ??
    getSlashSuggestions(currentText, getVisibleSlashCommands(state));
  if (!next) {
    if (slashOverlayOpen) hideOverlay();
    return;
  }

  const previousLabel = slashOverlayOpen ? overlayItems()[overlayIndex()]?.label : undefined;
  _tabCompleting = false;
  _activeCompletion = next;

  if (!slashOverlayOpen) {
    showOverlay(next.items);
    return;
  }

  setOverlayItems(next.items);
  const preservedIndex = previousLabel ? next.items.findIndex((item) => item.label === previousLabel) : -1;
  setOverlayIndex(preservedIndex >= 0 ? preservedIndex : Math.min(overlayIndex(), next.items.length - 1));
}

function refreshOpenSlashAutocomplete() {
  refreshSlashAutocomplete({ allowOpen: false });
}

function refreshOrOpenSlashAutocompleteForCommandUpdate() {
  refreshSlashAutocomplete({ allowOpen: true });
}

const [queueInteraction, setQueueInteraction] = createSignal<QueueInteractionState>({ kind: "idle" });
const queueFocusIndex = (): number | null => {
  const interaction = queueInteraction();
  return interaction.kind === "browsing" ? interaction.index : null;
};
const editingQueueItem = (): QueuedPrompt | null => {
  const interaction = queueInteraction();
  return interaction.kind === "editing" ? interaction.item : null;
};
const setQueueFocusIndex = (index: number | null): void => {
  setQueueInteraction((interaction) => {
    if (index !== null) return { kind: "browsing", index };
    return interaction.kind === "browsing" ? { kind: "idle" } : interaction;
  });
};
let _restoreEditingQueuedPromptForSnapshot: ((app: ReturnType<typeof useApp>) => boolean) | null = null;
let _cancelPendingQueueFocus: (() => boolean) | null = null;

// Queue max size
const MAX_QUEUE = 10;
const threadQueue = createThreadQueueStore(MAX_QUEUE);

// Allow the stdio transport's graceful-then-forced process-group shutdown to finish
// before Relay exits, while keeping a stuck non-stdio transport from blocking quit.
const SHUTDOWN_DISPOSE_TIMEOUT_MS = 250;
let _appSetState: ((...args: any[]) => void) | null = null;
let _appGetState: (() => AppState) | null = null;
const _agentIdleWaiters = new Set<() => void>();

function activeThreadFromState(state: AppState): ThreadInfo | null {
  return state.threads.find((thread) => thread.id === state.activeThreadId && !thread.archived) ?? null;
}

function isAgentRunningState(state: AppState): boolean {
  const activeThread = activeThreadFromState(state);
  return (
    state.connecting || state.running || activeThread?.status === "connecting" || activeThread?.status === "running"
  );
}

function activePluginEventContext(state: AppState): { threadId: string; sessionId: string | null; cwd: string } | null {
  const activeThread = activeThreadFromState(state);
  if (!activeThread) return null;
  return {
    threadId: activeThread.id,
    sessionId: store.acpClient?.sessionId ?? activeThread.sessionId ?? null,
    cwd: activeThread.cwd,
  };
}

function flushAgentIdleWaitersIfIdle(_dependencyKey?: string): void {
  const state = _appGetState?.();
  if (state && isAgentRunningState(state)) return;
  const waiters = [..._agentIdleWaiters];
  _agentIdleWaiters.clear();
  for (const resolve of waiters) resolve();
}

function waitForActiveAgentIdle(): Promise<void> {
  const state = _appGetState?.();
  if (!state || !isAgentRunningState(state)) return Promise.resolve();
  return new Promise((resolve) => {
    _agentIdleWaiters.add(resolve);
  });
}

function toRelayPluginThreadInfo(thread: ThreadInfo): RelayPluginThreadInfo {
  return {
    id: thread.id,
    title: thread.title,
    sessionId: thread.sessionId,
    cwd: thread.cwd,
    workspaceKind: thread.workspaceKind,
    status: thread.status,
    archived: thread.archived,
    ...(thread.worktreePath ? { worktreePath: thread.worktreePath } : {}),
    ...(thread.worktreeBranch ? { worktreeBranch: thread.worktreeBranch } : {}),
    ...(thread.createdAt ? { createdAt: thread.createdAt } : {}),
    ...(thread.updatedAt ? { updatedAt: thread.updatedAt } : {}),
  };
}

function relayConversationSnapshotForThread(
  app: ReturnType<typeof useApp>,
  threadId?: string,
): RelayConversationSnapshot | null {
  const targetThreadId = threadId ?? app.state.activeThreadId;
  if (!targetThreadId) return null;
  const thread = app.state.threads.find((item) => item.id === targetThreadId && !item.archived);
  if (!thread) return null;
  const sessionId =
    thread.id === app.state.activeThreadId ? (store.acpClient?.sessionId ?? thread.sessionId) : thread.sessionId;
  return snapshotRelayConversation({
    thread: toRelayPluginThreadInfo(thread),
    blocks: threadUiAdapter(app, thread.id).state.blocks,
    sessionId,
  });
}

function relayConversationMarkdownForThread(app: ReturnType<typeof useApp>, threadId?: string): string | null {
  const snapshot = relayConversationSnapshotForThread(app, threadId);
  return snapshot ? formatRelayConversationMarkdown(snapshot) : null;
}

function createRelayCommandContext(app: ReturnType<typeof useApp>): RelayCommandContext {
  const activeThread = activeThreadFromState(app.state);
  const activeThreadBlocks = activeThread
    ? activeThread.id === app.state.activeThreadId
      ? app.state.blocks
      : (store.threadBlocks.get(activeThread.id) ?? [])
    : [];
  return {
    cwd: app.state.cwd,
    sessionId: store.acpClient?.sessionId ?? activeThread?.sessionId ?? null,
    threadId: activeThread?.id ?? null,
    userMessageCount: userMessageCount(activeThreadBlocks),
    running: isAgentRunningState(app.state),
    waitForIdle: waitForActiveAgentIdle,
    toast: showToast,
  };
}

function appendAgentMessageText(parts: string[], update: RelaySessionUpdate): void {
  const event = acpThreadEventFromSessionUpdate(update);
  if (event?.type !== "agentMessage" || !event.content) return;
  const text = textFromAcpThreadContent(event.content, "message");
  if (text) parts.push(text);
}

// Exit message state (set on mount, read on exit)
let _sessionStartTime: number | null = null;
let _exitGetSession: (() => { id: string } | null) | null = null;
let _exitSessionId: string | null = null;
let _exitGetFileChanges: (() => FileChanges[]) | null = null;
let _exitRenderer: any | null = null;
let _shutdownInProgress = false;
let _runtimeShutdown: { readonly appInstanceId: number; readonly promise: Promise<void> } | null = null;
let _terminalAuthActive = false;

async function runAcpTerminalAuth(method: RelayAuthMethod): Promise<void> {
  if (_terminalAuthActive) return Promise.reject(new Error("Terminal auth is already running"));
  const command = method.terminal;
  if (!command) return Promise.reject(new Error(`ACP auth method "${method.id}" did not include a terminal command`));
  _terminalAuthActive = true;
  const renderer = _exitRenderer as { suspend?: () => void; resume?: () => void } | null;
  try {
    try {
      renderer?.suspend?.();
    } catch {
      // Best-effort; the auth command still inherits stdio.
    }
    await runTerminalAuthCommand(command, { cwd: _appGetState?.().cwd ?? process.cwd() });
  } finally {
    try {
      renderer?.resume?.();
    } catch {
      // ignore
    }
    _terminalAuthActive = false;
  }
}

// ACP-advertised slash commands cached for inactive threads.
const [hideThinking, setHideThinking] = createSignal(false);
const [welcomeDismissed, setWelcomeDismissed] = createSignal(false);
const [vimEnabled, setVimEnabled] = createSignal(false);
const [vimState, setVimState] = createSignal<VimState>(initialVimState);
const [showThreadSidebar, setShowThreadSidebar] = createSignal(false);
const [threadSidebarExpanded, setThreadSidebarExpanded] = createSignal(false);
const [sidebarFocused, setSidebarFocused] = createSignal(false);
const [sidebarFocusedIndex, setSidebarFocusedIndex] = createSignal(0);
const [threadSidebarListOffset, setThreadSidebarListOffset] = createSignal(0);

function addConfigWarningBlock(app: ReturnType<typeof useApp>, content: string): void {
  setWelcomeDismissed(true);
  app.addBlock({
    type: "info",
    id: nextBlockId(),
    content,
    variant: "warning",
  });
}

/** Reset all double-press state (ctrl+c exit) and clear hints. */
function resetDoublePressState() {
  resetCtrlCState();
}

// ===========================================================================
// FloatingList component (rendered as absolute overlay above the prompt)
// Tab path completion helpers
// ===========================================================================

/**
 * Perform Tab path completion: extract path fragment before cursor, complete it.
 * Unique match → insert directly. Multiple → insert LCP then show floating list.
 */
function getTextareaText(ref = _textareaRef): string {
  return readTextareaText(ref);
}

function insertPromptTextAtCursor(text: string): boolean {
  const ref = _textareaRef;
  if (!ref || !text) return false;
  try {
    ref.focus?.();
  } catch {}
  try {
    ref.insertText?.(text);
    refreshCurrentPasteHighlights();
    resetVimState();
    return true;
  } catch {
    return false;
  }
}

function doTabPathCompletion(app: ReturnType<typeof useApp>) {
  const ref = _textareaRef;
  if (!ref) return;

  const fullText = getTextareaText(ref);
  const cursorOffset = getCursorOffset(ref, fullText);

  // Work only on the current line up to the cursor
  const lastNL = fullText.lastIndexOf("\n", cursorOffset - 1);
  const lineStart = lastNL + 1; // 0 if no newline
  const lineBeforeCursor = fullText.slice(lineStart, cursorOffset);

  // Extract path fragment
  const [pathFragment, startColInLine] = PathCompleter.extractPathFragment(lineBeforeCursor);
  if (!pathFragment) return; // nothing to complete

  const startOffset = lineStart + startColInLine;

  // Fresh listing (invalidate stale cache)
  _pathCompleter.clearCache();
  const [completion, alternatives] = _pathCompleter.complete(app.state.cwd, pathFragment);

  if (!completion && alternatives.length === 0) return; // no match — do nothing

  if (alternatives.length === 0) {
    // Unique match — insert completion suffix directly
    const isDir = completion.endsWith("/");
    const toInsert = completion + (isDir ? "" : " ");
    markInputUpdateSource("tab-completion", fullText.slice(0, cursorOffset) + toInsert + fullText.slice(cursorOffset));
    try {
      ref.insertText(toInsert);
    } catch {}
    return;
  }

  // Multiple matches — insert LCP first (if any), then show list
  if (completion) {
    markInputUpdateSource(
      "tab-completion",
      fullText.slice(0, cursorOffset) + completion + fullText.slice(cursorOffset),
    );
    try {
      ref.insertText(completion);
    } catch {}
  }

  // Save tab-complete state
  _tabCompleting = true;
  _tabStartOffset = startOffset;
  _tabBaseFragment = PathCompleter.getBasePath(pathFragment + completion);

  // Build overlay items (filename as label, base dir as description)
  const desc = _tabBaseFragment || ".";
  const items: ListItem<string>[] = alternatives.slice(0, 20).map((alt) => ({
    value: alt,
    label: alt,
    description: desc,
  }));

  showOverlay(items);
}

/**
 * Apply a tab-completion selection: replace the path fragment with the chosen path.
 */
function sanitizePersistedThread(thread: ThreadInfo): ThreadInfo {
  return sanitizeInternalThreadTitle(thread, store.activeAgentBehaviorProfile.sessionListPolicy);
}

function applyTabPathCompletion(selected: ListItem<string>, app: ReturnType<typeof useApp>) {
  const ref = _textareaRef;
  if (!ref) return;

  const fullText = getTextareaText(ref);
  const cursorOffset = getCursorOffset(ref, fullText);

  const selectedPath: string = selected.value;
  const newPath = _tabBaseFragment + selectedPath;
  // Quote if the path contains spaces
  const finalPath = newPath.includes(" ") && !newPath.startsWith('"') ? `"${newPath}"` : newPath;

  const isDir = selectedPath.endsWith("/") || selectedPath.endsWith(path.sep);
  const suffix = isDir ? "" : " ";

  const textBefore = fullText.slice(0, _tabStartOffset);
  const textAfter = fullText.slice(cursorOffset);
  const newText = textBefore + finalPath + suffix + textAfter;

  hideOverlay(); // resets _tabCompleting etc.

  markInputUpdateSource("tab-completion", newText);
  try {
    ref.clear();
    ref.insertText(newText);
  } catch {
    try {
      ref.setText(newText);
    } catch {}
  }
}

// ===========================================================================
// Session resume helpers
// ===========================================================================

const {
  resetSessionUi,
  threadUiAdapter,
  restoreBlocksBeforeHistory,
  createThreadCallbacks,
  threadClient,
  ensureThreadSession,
  warmThreadSessionCapabilities,
  threadNotificationContext,
  agentSlashSkillInvocationEcho,
  applyThreadSessionCapabilities,
  createThreadFromExistingWorktree,
  createThread,
  forkThread,
  getThreadPendingQueue,
  drainReadyPromptQueue,
  selectThread,
  archiveThread,
  setSessionModeFromKeyboard,
} = createThreadController({
  threadQueue,
  queueFocusIndex,
  setQueueFocusIndex,
  clearQueueInteraction: () => {
    _cancelPendingQueueFocus?.();
    setQueueInteraction({ kind: "idle" });
  },
  editingQueueItem,
  restoreEditingQueuedPromptForSnapshot: (app) => _restoreEditingQueuedPromptForSnapshot?.(app) ?? false,
  setWelcomeDismissed,
  refreshOpenSlashAutocomplete,
  refreshSlashAutocompleteForCommandUpdate: refreshOrOpenSlashAutocompleteForCommandUpdate,
  gitWatcherSetCwd,
  abortAndClearUserBash: () => {
    if (_userBashAbortController) {
      _userBashAbortController.abort();
      _userBashAbortController = null;
    }
  },
  beforeThreadDeactivate: (threadId) => _transcriptSelectionCoordinator?.beforeThreadDeactivate(threadId),
  afterThreadActivate: (threadId) => _transcriptSelectionCoordinator?.afterThreadActivate(threadId),
  loadSessionHistory: (client, threadId, sessionId, cwd, additionalDirectories, onHistoryReady) =>
    loadSessionHistory(client, threadId, sessionId, cwd, additionalDirectories, onHistoryReady),
  replayLoadedSessionUpdates: (app, threadId, updates, finalize) =>
    replayLoadedSessionUpdates(app, threadId, updates, finalize),
  submitPromptToAgent: (text, app, queuePlacement, options) => submitPromptToAgent(text, app, queuePlacement, options),
});

const { openResumePicker, resumeMostRecentSession, loadSessionHistory, replayLoadedSessionUpdates, loadSession } =
  createSessionController({
    threadAgentCommands: store.threadAgentCommands,
    historyLoadedSessionIdsByThread: store.historyLoadedSessionIdsByThread,
    acpClient: () => store.acpClient,
    activeAgentName: () => store.activeAgentName,
    agentBehaviorProfile: () => store.activeAgentBehaviorProfile,
    resetSessionUi,
    applyThreadSessionCapabilities,
    refreshOpenSlashAutocomplete,
    showSelectionOverlay,
    hideSelectionOverlay: hideOverlay,
    threadUiAdapter,
    setAllowGlobalPromptHistoryContinuation: (value) => {
      store.allowGlobalPromptHistoryContinuation = value;
    },
    onThreadCwdChange: gitWatcherSetCwd,
  });

// ===========================================================================
// Auth provider login/logout handlers
// ===========================================================================

// ===========================================================================
// Slash command handlers
// ===========================================================================

/**
 * Build the slash command list shown in autocomplete with the same precedence
 * rule used at execution time: plugin commands win over ACP-advertised commands;
 * native commands are shown when not shadowed by plugins or available agent commands.
 */
function getVisibleSlashCommands(state: AppState | null): SlashCommand[] {
  const pluginCommands =
    store.pluginRunner?.commands.list().map((entry) => ({
      name: entry.invocationName,
      description: entry.command.description ?? `Plugin command from ${entry.plugin.name}`,
      origin: "plugin" as const,
      kind: "unknown" as const,
      invocation: { syntax: "slash" as const, composable: false as const },
    })) ?? [];
  const activeThread = state?.threads.find((thread) => thread.id === state.activeThreadId && !thread.archived);
  const authoritativeAgentCommandsKnown = activeThread ? store.threadAgentCommandsKnown.has(activeThread.id) : false;
  const shouldUseCachedCommands =
    state &&
    state.availableCommands.length === 0 &&
    store.cachedAgentCommands.length > 0 &&
    !authoritativeAgentCommandsKnown;
  const stateWithCachedCommands = shouldUseCachedCommands
    ? { ...state, availableCommands: store.cachedAgentCommands }
    : state;
  return visibleSlashCommands(stateWithCachedCommands, pluginCommands);
}

let _activeSettingsValueSetting: ConfigSetting | null = null;

const {
  openThemeOverlay,
  openNotificationSettingsOverlay,
  openSettingsSubmenu,
  reopenSettingsAfterUpdate,
  openSettingValueOverlay,
  openAcpConfigOptionValueOverlay,
  pluginSettingEntries,
  openSettingsOverlay,
  openPluginsOverlay,
  refreshPluginsOverlay,
  updateInteractiveSetting,
  updateInteractiveAcpConfigOption,
  updateInteractivePluginSetting,
  updateInteractivePlugin,
  refreshSettingsOverlay,
} = createSettingsOverlayController({
  showSelectionOverlay,
  setSettingsOverlayActive,
  settingsOverlayActive,
  selectionMode,
  overlayItems,
  overlayIndex,
  setOverlayItems,
  setOverlayIndex,
  setSelectionAllItems: (items) => {
    _selectionAllItems = items;
  },
  getActiveSettingsSubmenu: () => _activeSettingsSubmenu,
  setActiveSettingsSubmenu: (value) => {
    _activeSettingsSubmenu = value;
  },
  getActiveSettingsValueSetting: () => _activeSettingsValueSetting,
  setActiveSettingsValueSetting: (value) => {
    _activeSettingsValueSetting = value;
  },
  acpConfigOptions: () => _appGetState?.().sessionConfigOptions ?? [],
  updateAcpConfigOption: (option, value, app) => setSessionConfigOption(app, option, value),
  pluginRunner: () => store.pluginRunner,
  pluginsCwd: () => store.rootCwd || _appGetState?.().cwd || process.cwd(),
  agentCommands: () => _appGetState?.().availableCommands ?? [],
  applyTheme: (themeId) => {
    setConfigTheme(themeId);
    emitPluginEvent({ type: "theme:change", themeId });
    invalidateSyntaxStyle();
  },
  showToast,
});

function toggleSelectedPlugin(app: ReturnType<typeof useApp>): void {
  const selected = overlayItems()[overlayIndex()]?.value as PluginSettingsItem | undefined;
  if (!selected) return;
  updateInteractivePlugin(selected, app);
}

function openExistingWorktreePicker(app: ReturnType<typeof useApp>): void {
  const usedPaths = new Set(
    app.state.threads.filter((thread) => !thread.archived).map((thread) => thread.worktreePath ?? thread.cwd),
  );
  const items = discoverThreadWorktreeCandidates(store.rootCwd || app.state.cwd)
    .filter((worktree) => !worktree.bare && !usedPaths.has(worktree.path))
    .map((worktree) => ({
      value: worktree.path,
      label: worktree.branch ?? truncateTextEnd(worktree.head ?? worktree.path, 18),
      description: worktree.path,
    }));
  if (items.length === 0) {
    showToast("No available git worktrees found", "warning");
    return;
  }
  setSidebarFocused(false);
  showSelectionOverlay(
    items,
    SelectionMode.WORKTREE,
    {
      labelMinWidth: 18,
      labelMaxWidth: 32,
      descriptionMaxWidth: 80,
    },
    0,
    {
      onSelect: (item, selectedApp) => {
        createThreadFromExistingWorktree(selectedApp, item.value as string).catch((err) =>
          showToast(`Failed to create worktree thread: ${err}`, "error"),
        );
      },
    },
  );
}

const { publishChildCompletion, submitPromptToAgent, interruptAcpPrompt } = createSubmitController({
  queuePrompt: (text, app, placement, reason) => queuePrompt(text, app, placement, reason),
  setQueueFocusIndex,
  isEditingQueuedPrompt: () => editingQueueItem() !== null,
  drainReadyPromptQueue,
  admitPromptToThreadQueue: (input, app, threadId) => threadQueue.admit({ app, threadId, input }),
  threadClient,
  ensureThreadSession,
  threadUiAdapter,
  agentSlashSkillInvocationEcho,
  threadNotificationContext,
  getThreadPendingQueue,
});

const handleSlashCommand = createSlashCommandHandler({
  submitPromptToAgent,
  createThread,
  selectThread,
  forkThread,
  loadSession,
  openResumePicker,
  switchSessionModel,
  switchSessionThinkingLevel,
  ensureSessionForCommand: ensureActiveThreadSession,
  shutdownAndExit,
  showSelectionOverlay,
  showToast,
  openSettingsOverlay,
  openPluginsOverlay,
  openPromptInExternalEditor: (initialText) => _openPromptInExternalEditor?.(initialText),
  hideOverlay,
  setWelcomeDismissed,
  setShowThreadSidebar,
  setSidebarFocused,
  setSidebarFocusedIndex,
  acpClient: () => store.acpClient,
  activeAgentName: () => store.activeAgentName,
  pluginRunner: () => store.pluginRunner,
  reloadPlugins: () => _reloadPlugins,
  exitRenderer: () => _exitRenderer,
  commandContext: createRelayCommandContext,
  runBuiltinSkillCommand: (app, skill, args, ctx) =>
    _builtinSkillController?.runCommand(app, skill, args, ctx) ?? Promise.resolve(),
  runNativeHandoffCommand: (app, args, ctx) =>
    _nativeHandoffController?.runCommand(app, args, ctx) ?? Promise.resolve(),
  disabledBuiltinSlashCommands: () => getConfig().ui.disabled_builtin_slash_commands,
  runTerminalAuth: runAcpTerminalAuth,
});

// ===========================================================================
// Submit handler
// ===========================================================================

const {
  queuePrompt,
  setPromptText,
  restoreRejectedPromptToComposerDraft,
  restoreEditingQueuedPrompt,
  deleteEditingQueuedPrompt,
  cancelPendingQueueFocus,
  exitQueueBrowse,
  moveQueueFocus,
  navigatePromptHistory,
  editFocusedQueuedPrompt,
  cancelFocusedQueuedPrompt,
  moveFocusedQueuedPrompt,
  sendFocusedQueuedPromptNow,
} = createQueueController({
  queueInteraction,
  setQueueInteraction,
  threadQueue,
  textareaRef: () => _textareaRef,
  markInputUpdateSource,
  syncPromptText: setComposerText,
  resetVimState,
  refreshCurrentPasteHighlights,
  acpClient: () => store.acpClient,
  allowGlobalPromptHistoryContinuation: () => store.allowGlobalPromptHistoryContinuation,
  cancelRequested: () => store.cancelRequested,
  resumeQueueDrain: (app) => drainReadyPromptQueue(app, app.state.activeThreadId),
  submitPromptToAgent,
});
_restoreEditingQueuedPromptForSnapshot = (app) => restoreEditingQueuedPrompt(app, false);
_cancelPendingQueueFocus = cancelPendingQueueFocus;

const { handleSubmit, handleActiveTurnInput } = createInputHandlers({
  setWelcomeDismissed,
  setUserBashAbortController: (controller) => {
    _userBashAbortController = controller;
  },
  textareaRef: () => _textareaRef,
  getTextareaText,
  markInputUpdateSource,
  acpClient: () => store.acpClient,
  pluginRunner: () => store.pluginRunner,
  restoreRejectedPromptToComposerDraft,
  queuePrompt,
  handleSlashCommand,
  submitPromptToAgent,
});

// ===========================================================================
// Exit message (printed to stdout after renderer is destroyed)
// ===========================================================================

type ShutdownRenderer = Pick<CliRenderer, "destroy"> &
  Partial<Pick<CliRenderer, "isDestroyed" | "setTerminalTitle" | "useMouse">>;

function printExitMessage(): void {
  printExitSummary({
    colors: getColors(),
    sessionStartedAt: _sessionStartTime,
    fileChanges: _exitGetFileChanges?.() ?? [],
    sessionId: _exitSessionId ?? _exitGetSession?.()?.id ?? null,
  });
}

/**
 * Shuts down plugin hooks and ACP clients once for an application instance.
 * Cleanup preserves clients created by a newer instance, bounds plugin shutdown, and force-disposes ACP clients
 * that outlive the graceful shutdown budget.
 *
 * @param appInstanceId - Application instance whose runtime resources should be released.
 */
function shutdownAppRuntimes(appInstanceId: number): Promise<void> {
  if (_runtimeShutdown?.appInstanceId === appInstanceId) return _runtimeShutdown.promise;

  const pluginRunner = store.pluginRunner;
  const initialActiveClient = store.acpClient;
  const initialThreadClients = [...store.threadClients.entries()];
  const clients = new Set(initialThreadClients.map(([, client]) => client));
  if (initialActiveClient) clients.add(initialActiveClient);

  const promise = (async () => {
    const pluginShutdownPromise = pluginRunner
      ? shutdownPluginRunner(pluginRunner, "quit").catch((err) => {
          console.error(`Failed to shut down Relay plugins: ${err}`);
        })
      : Promise.resolve();
    const pluginsStopped = await Promise.race([
      pluginShutdownPromise.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), SHUTDOWN_DISPOSE_TIMEOUT_MS)),
    ]);
    if (!pluginsStopped && pluginRunner) disposePluginRunner(pluginRunner);
    if (store.pluginRunner === pluginRunner) {
      store.pluginRunner = null;
      setPluginRuntimeRunner(null);
    }

    if (store.activeAppInstanceId === appInstanceId) {
      for (const client of store.threadClients.values()) clients.add(client);
      if (store.acpClient) clients.add(store.acpClient);
      store.acpClient = null;
      store.threadClients.clear();
    } else {
      if (store.acpClient === initialActiveClient) store.acpClient = null;
      for (const [threadId, client] of initialThreadClients) {
        if (store.threadClients.get(threadId) === client) store.threadClients.delete(threadId);
      }
    }

    await disposeAcpClientsForShutdown(clients, {
      disposeTimeoutMs: SHUTDOWN_DISPOSE_TIMEOUT_MS,
      forceSettleMs: 25,
      onDisposeError: (err) => console.error(`Failed to dispose an ACP client during shutdown: ${err}`),
      onForceDisposeError: (err) => console.error(`Failed to force-dispose an ACP client during shutdown: ${err}`),
    });
  })();
  _runtimeShutdown = { appInstanceId, promise };
  return promise;
}

/**
 * Runs bounded shutdown for plugins, ACP clients, and telemetry before destroying the renderer and exiting.
 *
 * @param renderer - Terminal renderer to destroy after cleanup.
 * @param [exitCode=0] - Process exit code to use after cleanup.
 */
async function shutdownAndExit(renderer: ShutdownRenderer, exitCode = 0): Promise<void> {
  if (_shutdownInProgress) return;
  _shutdownInProgress = true;
  // Stop new mouse reports while Relay still owns stdin so any in-flight input is consumed before teardown.
  try {
    renderer.useMouse = false;
  } catch {}
  resetDoublePressState();
  stopTurnTimer();
  if (_userBashAbortController) {
    _userBashAbortController.abort();
    _userBashAbortController = null;
  }
  _exitSessionId = _exitGetSession?.()?.id ?? null;
  await shutdownAppRuntimes(store.activeAppInstanceId);
  await flushTelemetryBeforeExit(flushTelemetry);

  try {
    if (renderer.isDestroyed !== true) {
      try {
        renderer.setTerminalTitle?.("");
      } catch {}
      renderer.destroy();
    }
  } finally {
    printExitMessage();
    _shutdownInProgress = false;
    process.exit(exitCode);
  }
}

let _setGitWatcherCwd: ((cwd: string) => void) | null = null;
function gitWatcherSetCwd(cwd: string) {
  _setGitWatcherCwd?.(cwd);
}

// ===========================================================================
// App component
// ===========================================================================

function isUserMessageBlock(block: ChatBlock): boolean {
  return block.type === "user";
}

function userMessageCount(blocks: readonly ChatBlock[]): number {
  return blocks.filter(isUserMessageBlock).length;
}

function userMessageUiIndex(blocks: readonly ChatBlock[], userMessageIndex: number): number | null {
  let currentUserMessageIndex = -1;
  for (let index = 0; index < blocks.length; index++) {
    if (!isUserMessageBlock(blocks[index])) continue;
    currentUserMessageIndex += 1;
    if (currentUserMessageIndex === userMessageIndex) return index;
  }
  return null;
}

function nextUserMessageUiIndex(blocks: readonly ChatBlock[], startIndex: number): number {
  for (let index = startIndex; index < blocks.length; index++) {
    if (isUserMessageBlock(blocks[index])) return index;
  }
  return blocks.length;
}

function leadingPluginBlockCount(blocks: readonly ChatBlock[]): number {
  let count = 0;
  while (blocks[count]?.type === "plugin") count += 1;
  return count;
}

function pluginChatBlockInsertIndex(
  blocks: readonly ChatBlock[],
  placement: RelayPluginChatBlockInput["placement"] | undefined,
): number | null {
  if (!placement || placement.kind === "append") return blocks.length;
  const index = placement.index;
  if (!Number.isInteger(index) || index < 0) return null;
  const userCount = userMessageCount(blocks);
  if (placement.kind === "before-user-message-index") {
    if (index === 0 && userCount === 0) return leadingPluginBlockCount(blocks);
    if (index === userCount) return blocks.length;
    if (index > userCount) return null;
    return userMessageUiIndex(blocks, index);
  }
  if (index >= userCount) return null;
  const uiIndex = userMessageUiIndex(blocks, index);
  if (uiIndex === null) return null;
  return nextUserMessageUiIndex(blocks, uiIndex + 1);
}

export function App(props: AppProps) {
  const renderer = useRenderer();
  const handleSighup = () => void shutdownAndExit(renderer, 129);
  const handleSigint = () => void shutdownAndExit(renderer, 130);
  const handleSigterm = () => void shutdownAndExit(renderer, 143);
  process.on("SIGHUP", handleSighup);
  process.on("SIGINT", handleSigint);
  process.on("SIGTERM", handleSigterm);
  const appInstanceId = ++_appInstanceCounter;
  store.activeAppInstanceId = appInstanceId;
  resetPluginMcpAppliedSnapshot();
  resetStartupTipsDismissal();
  setWelcomeDismissed(false);
  store.cancelRequested = false;
  store.launchThinkingLevelOverride = props.initialThinkingLevel?.trim() ?? "";
  store.activeAgentName = "";
  store.activeAgentProfile = "default";
  store.activeAgentBehaviorProfile = resolveAgentBehaviorProfile();
  store.activeAgentCommandCacheKey = null;
  store.cachedAgentCommands = [];
  store.threadTranscriptViews.clear();
  store.threadSessionCapabilities.clear();
  store.threadYoloEnabled.clear();
  store.threadYoloLaunchEnabled.clear();
  store.threadAgentCommandsKnown.clear();
  store.threadPromptRunIds.clear();
  store.suppressedThreadPromptRunIds.clear();
  store.liveSessionContinuationThreads.clear();
  resetPromptDispatchState();
  store.historyLoadedSessionIdsByThread.clear();
  store.allowGlobalPromptHistoryContinuation = false;
  _exitSessionId = null;
  setHideThinking(!getConfig().ui.show_thinking);
  hideOverlay();
  closeDiffOverlay();
  resetVimState();
  setComposerText("");
  _cancelPendingQueueFocus?.();
  setQueueInteraction({ kind: "idle" });

  // Resolve once: the paging flag and ChatLog's mode must agree.
  const transcriptRendererMode = props.transcriptRendererMode ?? TRANSCRIPT_RENDERER_ROLLOUT_DEFAULT;
  // Create app state context value
  const contextValue = createAppStateValue(props.cwd, {
    transcriptPagingEnabled: transcriptRendererMode === "windowed",
  });
  const { state, setState, addBlock, updateBlock, cancelController } = contextValue;
  // Route out-of-band escape sequences (terminal title, OSC 52 clipboard)
  // through OpenTUI's serialized frame writer rather than process.stdout.
  // Writing directly to stdout races OpenTUI's native frame flushes on the
  // same fd; an interleaved write can split a frame escape sequence, leaving
  // the terminal to render its tail as stray characters until the next repaint.
  const rendererWriteOut = (data: string): void => {
    try {
      (renderer as unknown as { writeOut?: (chunk: string) => unknown }).writeOut?.(data);
    } catch {}
  };
  const terminalTitleOutput =
    props.terminalTitleOutput ?? ({ isTTY: process.stdout.isTTY, write: rendererWriteOut } as const);
  useManagedTerminalTitle(terminalTitleOutput, state);
  setClipboardOscWriter(rendererWriteOut);
  onCleanup(() => setClipboardOscWriter(null));
  const toastValue = createToastValue();
  onCleanup(() => {
    _transcriptSelectionCoordinator?.dispose();
    _transcriptSelectionCoordinator = null;
  });
  const clearShowToast = setShowToast(toastValue.show);
  onCleanup(clearShowToast);
  const [pluginRevision, setPluginRevision] = createSignal(0);
  const [configRevision, setConfigRevision] = createSignal(0);
  const [pluginChromeRevision, setPluginChromeRevision] = createSignal(0);
  const [pluginWidgetInteractionRevision, setPluginWidgetInteractionRevision] = createSignal(0);
  const pluginWidgetRevisions = new Map(
    PLUGIN_WIDGET_PLACEMENTS.map((placement) => [placement, createSignal(0)] as const),
  );
  const pluginWidgetRevision = (placement: RelayWidgetPlacement): number =>
    pluginWidgetRevisions.get(placement)?.[0]() ?? 0;
  const bumpPluginWidgetRevision = (placement: RelayWidgetPlacement): void => {
    pluginWidgetRevisions.get(placement)?.[1]((value) => value + 1);
  };
  const bumpAllPluginWidgetRevisions = (): void => {
    for (const placement of PLUGIN_WIDGET_PLACEMENTS) bumpPluginWidgetRevision(placement);
  };
  const nativeStatusValues = new Map<string, RelayPluginStatus>();
  const [nativeChromeRevision, setNativeChromeRevision] = createSignal(0);
  const setNativeStatus = (key: string, value: RelayPluginStatus | undefined): void => {
    if (value === undefined) nativeStatusValues.delete(key);
    else nativeStatusValues.set(key, value);
    setNativeChromeRevision((revision) => revision + 1);
  };
  const nativeStatusSegments = (): readonly RelayPluginStatus[] => {
    nativeChromeRevision();
    return [...nativeStatusValues.values()];
  };
  const pluginDialogs = createPluginDialogController();
  const nativeModals = createNativeModalController();
  const builtinSkillController = createBuiltinSkillController({
    submitPromptToAgent,
  });
  const liveSessionController = createLiveSessionController({
    app: contextValue as ReturnType<typeof useApp>,
    agentName: () => store.activeAgentName,
    createThread,
    ensureThreadSession,
    submitPromptToAgent,
    publishChildCompletion,
    threadClient,
    queuePromptForThread: (text, threadId) =>
      threadQueue.admit({ app: contextValue as ReturnType<typeof useApp>, threadId, input: text }).accepted,
    threadUiAdapter,
  });
  let liveSessionControlServer: LiveSessionControlServer | null = null;
  const liveSessionControlReady = startLiveSessionControlServer(liveSessionController.handleRequest)
    .then((server) => {
      liveSessionControlServer = server;
      if (store.activeAppInstanceId !== appInstanceId) return server.close();
      store.liveSessionInstanceId = server.instanceId;
      store.liveSessionEndpoint = server.endpoint;
      store.liveSessionToken = server.token;
    })
    .catch((error: unknown) => {
      getRelayLogger().error("live-session.control.start.error", { error: errorMessage(error) });
    });
  const nativeHandoffController = createHandoffController({
    showToast: toastValue.show,
    setNativeStatus,
    ensureThreadSession,
    createChildSession: liveSessionController.createChildSession,
    runHiddenPrompt: async (sessionId, text) => {
      const client =
        contextValue.state.threads
          .map((thread) => store.threadClients.get(thread.id) ?? null)
          .find((threadClient) => threadClient?.sessionId === sessionId) ??
        store.acpClient ??
        null;
      if (!client) return "";
      const parts: string[] = [];
      const releaseCapture = client.captureSessionUpdates(sessionId, (update) => {
        appendAgentMessageText(parts, update);
      });
      try {
        await client.prompt(text, sessionId);
      } finally {
        releaseCapture();
      }
      return parts.join("").trim();
    },
  });
  _builtinSkillController = builtinSkillController;
  _nativeHandoffController = nativeHandoffController;
  onCleanup(() => {
    void liveSessionControlReady.then(async () => {
      await liveSessionControlServer?.close();
      if (store.liveSessionInstanceId === liveSessionControlServer?.instanceId) {
        store.liveSessionInstanceId = "";
        store.liveSessionEndpoint = "";
        store.liveSessionToken = "";
      }
    });
    store.liveSessionInstanceId = "";
    store.liveSessionEndpoint = "";
    store.liveSessionToken = "";
    nativeStatusValues.clear();
    if (_builtinSkillController === builtinSkillController) _builtinSkillController = null;
    if (_nativeHandoffController === nativeHandoffController) _nativeHandoffController = null;
  });
  const createPluginRunner = () =>
    new PluginRunner({
      cwd: props.cwd,
      toast: toastValue.show,
      invalidate: () => setPluginRevision((value) => value + 1),
      invalidateChrome: () => setPluginChromeRevision((value) => value + 1),
      invalidateWidget: bumpPluginWidgetRevision,
      invalidateWidgetInteraction: () => setPluginWidgetInteractionRevision((value) => value + 1),
      editor: {
        getText: () => getTextareaText(),
        setText: (text) => setPromptText(text, "queue"),
        insertText: (text) => {
          try {
            _textareaRef?.insertText?.(text);
          } catch {}
        },
        attachImage: (path) => {
          const attached = insertImagePathAtCursor(_textareaRef, pasteStore, path, renderer, () => {
            refreshCurrentPasteHighlights();
            resetVimState();
          });
          if (attached) {
            try {
              _textareaRef?.focus?.();
            } catch {}
          }
          return attached;
        },
        submit: async (text) => {
          const promptText = text ?? getTextareaText();
          if (!promptText.trim()) return;
          handleSubmit(promptText, contextValue as ReturnType<typeof useApp>);
        },
      },
      chat: {
        addBlock: (plugin: RelayPluginInfo, block: RelayPluginChatBlockInput): string | undefined => {
          const targetThreadId = block.threadId ?? contextValue.state.activeThreadId;
          const targetThread = contextValue.state.threads.find(
            (thread) => thread.id === targetThreadId && !thread.archived,
          );
          if (!targetThread) return undefined;
          const adapter = threadUiAdapter(contextValue as ReturnType<typeof useApp>, targetThread.id);
          const requestedId = block.id?.trim();
          if (requestedId && adapter.state.blocks.some((existing) => existing.id === requestedId)) return requestedId;
          const insertIndex = pluginChatBlockInsertIndex(adapter.state.blocks, block.placement);
          if (insertIndex === null) return undefined;
          const id = requestedId || nextBlockId();
          adapter.addBlock(
            {
              type: "plugin",
              id,
              pluginId: plugin.id,
              pluginName: plugin.name,
              blockType: block.blockType,
              content: block.content,
              ...(block.data !== undefined ? { data: block.data } : {}),
            },
            insertIndex,
          );
          return id;
        },
        userMessageCount: (threadId?: string): number => {
          const targetThreadId = threadId ?? contextValue.state.activeThreadId;
          if (!targetThreadId) return 0;
          const targetThread = contextValue.state.threads.find(
            (thread) => thread.id === targetThreadId && !thread.archived,
          );
          if (!targetThread) return 0;
          return userMessageCount(
            threadUiAdapter(contextValue as ReturnType<typeof useApp>, targetThread.id).state.blocks,
          );
        },
      },
      agent: {
        name: () => store.activeAgentName,
        profile: () => store.activeAgentProfile,
        sessionId: () => store.acpClient?.sessionId ?? null,
        isRunning: () => isAgentRunningState(contextValue.state),
        waitForIdle: waitForActiveAgentIdle,
        hasQueuedPrompts: () => contextValue.state.pendingQueue.length > 0,
        supportsActiveTurnInput: () => Boolean(store.acpClient?.supportsActiveTurnInput()),
        supportsSessionFork: () => Boolean(store.acpClient?.supportsSessionFork()),
        supportsSessionDelete: () => Boolean(store.acpClient?.supportsSessionDelete()),
        supportsSessionClose: () => Boolean(store.acpClient?.supportsSessionClose()),
        addToCurrentTurn: async (text) => {
          const client = store.acpClient;
          if (!client) return { accepted: false, reason: "No ACP agent configured" };
          if (!client.supportsActiveTurnInput())
            return { accepted: false, reason: "Active-turn input is not supported" };
          return await client.sendActiveTurnInput(text);
        },
        forkSession: async (forkOptions: RelayPluginForkSessionOptions = {}): Promise<RelayPluginSessionResult> => {
          const client = store.acpClient;
          if (!client || !client.supportsSessionFork()) return { sessionId: null };
          const activeThread = currentThread(contextValue as ReturnType<typeof useApp>);
          const cwd = forkOptions.cwd ?? activeThread?.cwd ?? contextValue.state.cwd;
          const additionalDirectories =
            forkOptions.additionalDirectories ??
            (activeThread ? additionalDirectoriesForThread(activeThread, contextValue.state.threads) : undefined);
          const result = await client.forkSession(cwd, forkOptions.sessionId, additionalDirectories);
          return { sessionId: result.sessionId ?? null };
        },
        runHiddenPrompt: async (sessionId, text) => {
          const client =
            contextValue.state.threads
              .map((thread) => store.threadClients.get(thread.id) ?? null)
              .find((threadClient) => threadClient?.sessionId === sessionId) ??
            store.acpClient ??
            null;
          if (!client) return "";
          const parts: string[] = [];
          const releaseCapture = client.captureSessionUpdates(sessionId, (update) => {
            appendAgentMessageText(parts, update);
          });
          try {
            await client.prompt(text, sessionId);
          } finally {
            releaseCapture();
          }
          return parts.join("").trim();
        },
        deleteSession: async (sessionId) => {
          const client = store.acpClient;
          if (!client) throw new Error("No ACP agent configured"); // effect-shape-allow: plugin agent API reports missing host through the async bridge.
          if (!client.supportsSessionDelete()) throw new Error("ACP agent did not advertise session/delete"); // effect-shape-allow: plugin agent API reports unsupported capabilities through the async bridge.
          await client.deleteSession(sessionId);
        },
        closeSession: async (sessionId) => {
          const client = store.acpClient;
          if (!client) throw new Error("No ACP agent configured"); // effect-shape-allow: plugin agent API reports missing host through the async bridge.
          if (!client.supportsSessionClose()) throw new Error("ACP agent did not advertise session/close"); // effect-shape-allow: plugin agent API reports unsupported capabilities through the async bridge.
          await client.closeSession(sessionId);
        },
        availableModes: () => contextValue.state.availableModes.map((mode) => ({ ...mode })),
        availableModels: () => contextValue.state.availableModels.map((model) => ({ ...model })),
        availableThinkingLevels: () => contextValue.state.availableThinkingLevels.map((level) => level.id),
        prompt: async (text, promptOptions) =>
          submitPromptToAgent(text, contextValue as ReturnType<typeof useApp>, "in-place", {
            source: "plugin",
            ...(promptOptions?.targetThreadId ? { targetThreadId: promptOptions.targetThreadId } : {}),
            ...(promptOptions?.display?.kind === "skill"
              ? {
                  localEchoSkillInvocation: {
                    name: promptOptions.display.name,
                    ...(promptOptions.display.userMessage ? { userMessage: promptOptions.display.userMessage } : {}),
                  },
                }
              : {}),
          }),
        cancel: async () => {
          await interruptAcpPrompt(contextValue as ReturnType<typeof useApp>, "await-cancel");
        },
        restart: async () => {
          const thread = currentThread(contextValue as ReturnType<typeof useApp>);
          if (!thread) return;
          const client = threadClient(thread.id);
          if (!client || !store.activeAcpLaunchOptions) return;
          await client.disposeAsync();
          store.threadClients.delete(thread.id);
          let nextClientRef: AcpClient | null = null;
          const callbacks = createThreadCallbacks(
            contextValue as ReturnType<typeof useApp>,
            thread.id,
            () => nextClientRef,
          );
          const opts: AcpClientOptions = withLiveSessionEnv(
            withPluginMcpServers({
              ...store.activeAcpLaunchOptions,
              cwd: thread.cwd,
              agentBehaviorProfile: store.activeAgentBehaviorProfile,
              agentName: store.activeAgentName,
            }),
            thread,
            contextValue.state.threads,
          );
          const nextClient = store.activeAcpClientFactory?.(callbacks, opts) ?? new AcpClient(callbacks, opts);
          nextClientRef = nextClient;
          store.threadClients.set(thread.id, nextClient);
          store.acpClient = nextClient;
          const agentName = store.activeAgentName || "agent";
          if ((opts.transport ?? "stdio") === "stdio") {
            emitPluginEvent({ type: "agent:process:start", command: opts.command ?? "", args: opts.args ?? [] });
          }
          emitPluginEvent({ type: "agent:connect:start", agentName });
          try {
            await connectAcpClientWithTimeout(nextClient, agentName);
            applyAcpClientCapabilities(contextValue as ReturnType<typeof useApp>, nextClient);
            emitPluginEvent({ type: "agent:connect:ready", agentName, capabilities: null });
          } catch (error) {
            emitPluginEvent({ type: "agent:connect:error", agentName, error: String(error) });
            throw error; // effect-shape-allow: UI event bridge preserves existing async control flow.
          }
          const additionalDirectories = additionalDirectoriesForThread(thread, contextValue.state.threads);
          store.threadSessionCapabilities.delete(thread.id);
          store.threadAgentCommands.set(thread.id, []);
          if (thread.id === contextValue.state.activeThreadId) setState("availableCommands", []);
          const { result } = await startAcpSession(nextClient, {
            cwd: thread.cwd,
            sessionId: thread.sessionId,
            additionalDirectories,
            replayHistory: false,
          });
          const sessionId = thread.sessionId ?? result.sessionId ?? null;
          emitPluginEvent(
            thread.sessionId
              ? { type: "session:load", sessionId: thread.sessionId, cwd: thread.cwd, threadId: thread.id }
              : { type: "session:new", sessionId, cwd: thread.cwd, threadId: thread.id },
          );
          applyThreadSessionCapabilities(contextValue as ReturnType<typeof useApp>, thread.id, result, {
            replace: true,
          });
        },
        newSession: async (cwd) => {
          await createThread(contextValue as ReturnType<typeof useApp>, false, { snapshotCurrent: true, cwd });
        },
        loadSession: async (sessionId, cwd) => {
          if (cwd) setState("cwd", cwd);
          if (store.acpClient)
            await loadSession(
              sessionId,
              contextValue as ReturnType<typeof useApp>,
              store.acpClient,
              store.activeAgentName,
              undefined,
              cwd,
            );
        },
        setMode: async (modeId) => {
          await store.acpClient?.setSessionMode(modeId);
          setState("modeId", modeId);
          emitPluginEvent({ type: "mode:change", modeId });
        },
        setModel: async (modelId) => {
          await switchSessionModel(contextValue as ReturnType<typeof useApp>, modelId);
        },
        setThinkingLevel: async (level) => {
          const thinkingLevel = parseThinkingLevel(level);
          if (!thinkingLevel) throw new Error(`Unknown thinking level: ${level}`); // effect-shape-allow: plugin agent API reports unsupported thinking levels through the async bridge.
          await switchSessionThinkingLevel(contextValue as ReturnType<typeof useApp>, thinkingLevel);
        },
        setSessionModel: async (sessionId, modelId) => {
          const client = store.acpClient;
          if (!client) throw new Error("No ACP agent configured"); // effect-shape-allow: plugin agent API reports missing host through the async bridge.
          const modelConfigId = contextValue.state.modelConfigId;
          if (!modelConfigId) throw new Error("No ACP model switcher advertised by this agent"); // effect-shape-allow: plugin agent API reports unsupported model switching through the async bridge.
          await client.setSessionModel(modelId, modelConfigId, sessionId);
        },
        setSessionThinkingLevel: async (sessionId, level) => {
          const client = store.acpClient;
          if (!client) throw new Error("No ACP agent configured"); // effect-shape-allow: plugin agent API reports missing host through the async bridge.
          const thinkingLevel = parseThinkingLevel(level);
          if (!thinkingLevel) throw new Error(`Unknown thinking level: ${level}`); // effect-shape-allow: plugin agent API reports unsupported thinking levels through the async bridge.
          const thinkingConfigId = contextValue.state.thinkingConfigId;
          if (!thinkingConfigId) throw new Error("No ACP thinking level switcher advertised by this agent"); // effect-shape-allow: plugin agent API reports unsupported thinking switching through the async bridge.
          await client.setSessionThinkingLevel(thinkingLevel, thinkingConfigId, sessionId);
        },
      },
      thread: {
        current: () => {
          const thread = currentThread(contextValue as ReturnType<typeof useApp>);
          return thread ? toRelayPluginThreadInfo(thread) : null;
        },
        list: () => contextValue.state.threads.map(toRelayPluginThreadInfo),
        conversation: (threadId?: string): RelayConversationSnapshot | null =>
          relayConversationSnapshotForThread(contextValue as ReturnType<typeof useApp>, threadId),
        conversationMarkdown: (threadId?: string): string | null =>
          relayConversationMarkdownForThread(contextValue as ReturnType<typeof useApp>, threadId),
        create: async (createOptions: RelayPluginThreadCreateOptions = {}): Promise<RelayPluginThreadInfo | null> => {
          const previousThreadIds = new Set(contextValue.state.threads.map((thread) => thread.id));
          await createThread(contextValue as ReturnType<typeof useApp>, createOptions.worktree === true, {
            snapshotCurrent: createOptions.snapshotCurrent,
            cwd: createOptions.cwd,
            select: createOptions.select,
          });
          const created =
            contextValue.state.threads.find((thread) => !previousThreadIds.has(thread.id)) ??
            currentThread(contextValue as ReturnType<typeof useApp>);
          return created ? toRelayPluginThreadInfo(created) : null;
        },
        ensureSession: async (threadId?: string): Promise<RelayPluginThreadSessionInfo | null> => {
          const targetThread = threadId
            ? contextValue.state.threads.find((thread) => thread.id === threadId && !thread.archived)
            : currentThread(contextValue as ReturnType<typeof useApp>);
          if (!targetThread) return null;
          const { client, result } = await ensureThreadSession(contextValue as ReturnType<typeof useApp>, targetThread);
          const refreshedThread =
            contextValue.state.threads.find((thread) => thread.id === targetThread.id && !thread.archived) ??
            targetThread;
          return {
            thread: toRelayPluginThreadInfo(refreshedThread),
            sessionId: client.sessionId ?? result?.sessionId ?? refreshedThread.sessionId ?? null,
          };
        },
        select: async (threadId) => {
          await selectThread(contextValue as ReturnType<typeof useApp>, threadId);
        },
        archive: async (threadId) => {
          await archiveThread(contextValue as ReturnType<typeof useApp>, threadId);
        },
      },
      diffOverlay: {
        open: openPluginDiffOverlay,
        clearPlugin: clearPluginDiffOverlay,
      },
      dialogs: pluginDialogs,
    });
  const initialPluginRunner = createPluginRunner();
  const [pluginRunner, setPluginRunner] = createSignal<PluginRunner | null>(initialPluginRunner);
  const pluginOverlayOpen = () => {
    pluginWidgetInteractionRevision();
    const runner = pluginRunner();
    return (runner?.slots.focusedKeyboardWidget() ?? null) !== null;
  };
  const composerInputOwner = (): ComposerInputOwner => {
    if (findPendingApprovalBlock(contextValue.state.blocks)) return "approval";
    if (pendingElicitationBlock(contextValue)) return "elicitation";
    if (fileChangesModalOpen()) return "file-changes";
    if (pluginDialogs.active()) return "plugin";
    if (pluginOverlayOpen()) return "plugin";
    if (nativeModals.current() === "token-usage") return "token-usage";
    if (nativeModals.current() === "shortcut-reference") return "shortcut-reference";
    if (nativeModals.current() === "connection-error") return "connection-error";
    if (contextValue.state.selectedSubagentToolCallId !== null) return "subagent-detail";
    if (isOverlayVisible()) return isTextareaOverlay() ? "textarea-overlay" : "overlay";
    if (threadSidebarExpanded()) return "expanded-sidebar";
    if (queueFocusIndex() !== null) return "queue";
    if (sidebarFocused()) return "sidebar";
    if (contextValue.state.transcriptSelectedBlockId !== null) return "transcript";
    return "composer";
  };
  _composerInputOwner = composerInputOwner;
  createEffect(() => {
    if (contextValue.state.selectedSubagentToolCallId === null && contextValue.state.transcriptSelectedBlockId === null)
      return;
    if (contextValue.state.transcriptSelectedBlockId !== null) {
      exitQueueBrowse(contextValue as ReturnType<typeof useApp>);
      setSidebarFocused(false);
    }
    try {
      _textareaRef?.blur?.();
    } catch {}
  });
  store.pluginRunner = initialPluginRunner;
  setPluginRuntimeRunner(initialPluginRunner);
  let pluginReloadQueue: Promise<void> = Promise.resolve();
  let appDisposed = false;
  _reloadPlugins = async (reason) => {
    const task = pluginReloadQueue
      .catch(() => undefined)
      .then(async () => {
        if (appDisposed) return;
        await waitForActiveAgentIdle();
        if (appDisposed) return;

        // Import and validate every plugin before tearing down the working runtime.
        const prepared = await prepareRelayPlugins(props.cwd, (warning) =>
          addConfigWarningBlock(contextValue, warning),
        );
        if (prepared.diagnostics.length > 0) throw new Error(formatPluginLoadFailures(prepared.diagnostics)); // effect-shape-allow: slash-command promise reports reload rejection to the UI.
        if (appDisposed) return;

        const next = createPluginRunner();
        const appliedMcpSnapshot = currentPluginMcpAppliedSnapshot();
        if (appliedMcpSnapshot) next.mcp.markApplied(appliedMcpSnapshot);
        const setupSucceeded = await registerPreparedRelayPlugins(next, prepared);
        if (!setupSucceeded) {
          const details = next.diagnostics
            .map((diagnostic) => `${diagnostic.plugin.name}: ${diagnostic.message}`)
            .join("; ");
          next.dispose();
          throw new Error(`Plugin reload setup failed; keeping the previous runtime. ${details}`); // effect-shape-allow: slash-command promise reports reload rejection to the UI.
        }
        if (appDisposed) {
          next.dispose();
          return;
        }

        const previous = pluginRunner();
        if (previous) await shutdownPluginRunner(previous, reason);
        if (appDisposed) {
          next.dispose();
          return;
        }
        setPluginRunner(next);
        store.pluginRunner = next;
        setPluginRuntimeRunner(next);
        await startPreparedRelayPlugins(next, props.cwd);
        if (appDisposed) {
          await shutdownPluginRunner(next, "quit");
          return;
        }
        setPluginRevision((value) => value + 1);
        setPluginChromeRevision((value) => value + 1);
        setPluginWidgetInteractionRevision((value) => value + 1);
        bumpAllPluginWidgetRevisions();
        refreshOpenSlashAutocomplete();
      });
    pluginReloadQueue = task;
    await task;
  };
  _pluginRevisionBump = () => setPluginRevision((value) => value + 1);
  _appSetState = setState;
  setStatusIndicatorStateSetter(setState);
  _appGetState = () => state;
  createEffect(() => {
    flushAgentIdleWaitersIfIdle(
      [
        state.connecting ? "connecting" : "idle",
        state.running ? "running" : "paused",
        state.activeThreadId ?? "",
        state.threads.map((thread) => `${thread.id}:${thread.status}`).join("|"),
      ].join(":"),
    );
  });
  let lastQueueFingerprint: string | null = null;
  createEffect(() => {
    const fingerprint = `${state.activeThreadId}:${state.pendingQueue
      .map((item) => `${item.id}:${item.text}`)
      .join("\u0001")}`;
    if (lastQueueFingerprint === null) {
      lastQueueFingerprint = fingerprint;
      return;
    }
    if (lastQueueFingerprint === fingerprint) return;
    lastQueueFingerprint = fingerprint;
    const ctx = activePluginEventContext(state);
    if (!ctx) return;
    emitPluginEvent({ type: "queue:change", ...ctx, length: state.pendingQueue.length });
  });
  let lastThinkingThreadId: string | null = null;
  let lastThinkingLevel: string | null = null;
  createEffect(() => {
    const ctx = activePluginEventContext(state);
    const threadId = ctx?.threadId ?? "";
    const thinkingLevel = state.thinkingLevel || "";
    if (lastThinkingThreadId === null && lastThinkingLevel === null) {
      lastThinkingThreadId = threadId;
      lastThinkingLevel = thinkingLevel;
      return;
    }
    if (lastThinkingThreadId === threadId && lastThinkingLevel === thinkingLevel) return;
    const previousThinkingLevel = lastThinkingLevel ?? undefined;
    lastThinkingThreadId = threadId;
    lastThinkingLevel = thinkingLevel;
    if (!ctx) return;
    emitPluginEvent({
      type: "thinking:change",
      ...ctx,
      thinkingLevel,
      ...(previousThinkingLevel !== undefined ? { previousThinkingLevel } : {}),
    });
  });
  setSlashPanelPosition(getConfig().ui.slash_panel_position);

  // Route terminal notifications through OpenTUI's renderer. OpenTUI owns
  // terminal detection, protocol selection, and OPENTUI_NOTIFICATION_* overrides.
  setTerminalNotifier((title, message) => renderer.triggerNotification(message, title));
  onCleanup(() => setTerminalNotifier(null));

  // Store refs needed for exit message
  _exitRenderer = renderer;
  _exitGetSession = () => (store.acpClient?.sessionId ? { id: store.acpClient.sessionId } : null);
  _exitGetFileChanges = () => state.fileChanges;

  // Git branch watcher — event-driven with fs.watch + reftable fallbacks.
  // See relay/src/core/git-branch-watcher.ts for the full strategy.
  const gitWatcher = new GitBranchWatcher(props.cwd);
  _setGitWatcherCwd = (cwd) => {
    gitWatcher.setCwd(cwd);
    setState("gitBranch", gitWatcher.getBranch());
  };
  setState("gitBranch", gitWatcher.getBranch());
  gitWatcher.onChange((branch) => setState("gitBranch", branch));
  setVimEnabled(getConfig().ui.vim_keybindings);
  onCleanup(() => gitWatcher.dispose());

  const stopConfigWatcher = startConfigWatcher();
  const initialConfigLoad = getConfigLoadResult();
  if (initialConfigLoad.parseError) {
    setTimeout(
      () =>
        addConfigWarningBlock(
          contextValue,
          `Config reload failed; using fallback settings: ${errorMessage(initialConfigLoad.parseError)}`,
        ),
      0,
    );
  } else if (initialConfigLoad.warnings.length > 0) {
    setTimeout(() => addConfigWarningBlock(contextValue, formatConfigWarningMessage(initialConfigLoad.warnings)), 0);
  }
  const unsubscribeConfig = subscribeConfig((change) => {
    emitPluginEvent({ type: "config:change" });
    setConfigRevision((value) => value + 1);
    invalidateSyntaxStyle();
    setSlashPanelPosition(change.config.ui.slash_panel_position);
    setHideThinking(!change.config.ui.show_thinking);
    setVimEnabled(change.config.ui.vim_keybindings);
    if (!change.config.ui.vim_keybindings) resetVimState();
    refreshSettingsOverlay();
    refreshPluginsOverlay();
    if (
      change.previousConfig?.ui.disabled_builtin_slash_commands !== change.config.ui.disabled_builtin_slash_commands
    ) {
      refreshOpenSlashAutocomplete();
    }
    if (
      !change.parseError &&
      pluginsConfigFingerprint(change.previousConfig) !== pluginsConfigFingerprint(change.config)
    ) {
      void _reloadPlugins?.("reload").catch((error) =>
        showToast(`Plugin reload failed: ${errorMessage(error)}`, "error", 6000),
      );
    }
    if (change.source !== "watch") return;
    if (change.parseError) {
      addConfigWarningBlock(
        contextValue,
        `Config reload failed; keeping previous settings: ${errorMessage(change.parseError)}`,
      );
      return;
    }
    if (change.warnings.length > 0) {
      addConfigWarningBlock(contextValue, formatConfigWarningMessage(change.warnings));
      return;
    }
    if (!state.running && state.pendingQueue.length === 0) {
      showToast("Config reloaded", "info", 1500);
    }
  });
  onCleanup(() => {
    appDisposed = true;
    process.off("SIGHUP", handleSighup);
    process.off("SIGINT", handleSigint);
    process.off("SIGTERM", handleSigterm);
    void shutdownAppRuntimes(appInstanceId);
    stopConfigWatcher();
    unsubscribeConfig();
    hideOverlay();
    closeDiffOverlay();
    _selectionAllItems = [];
    _activeCompletion = null;
    store.threadBlocks.clear();
    store.threadTranscriptViews.clear();
    store.threadPendingQueues.clear();
    store.liveSessionWaitingThreads.clear();
    store.liveSessionContinuationThreads.clear();
    store.threadPreviews.clear();
    store.threadYoloEnabled.clear();
    store.threadYoloLaunchEnabled.clear();
    store.threadCurrentBlockIds.clear();
    store.threadSessionCapabilities.clear();
    store.threadPromptRunIds.clear();
    store.suppressedThreadPromptRunIds.clear();
    store.historyLoadedSessionIdsByThread.clear();
    setShowThreadSidebar(false);
    setThreadSidebarExpanded(false);
    setSidebarFocused(false);
    setSidebarFocusedIndex(0);
    setThreadSidebarListOffset(0);
    store.activeAcpLaunchOptions = null;
    store.activeAcpClientFactory = undefined;
    resetPluginMcpAppliedSnapshot();
    if (_pluginRevisionBump) _pluginRevisionBump = null;
    if (_reloadPlugins) _reloadPlugins = null;
    store.activeAgentName = "";
    store.activeAgentProfile = "default";
    store.activeAgentBehaviorProfile = resolveAgentBehaviorProfile();
    store.rootCwd = "";
    store.launchThinkingLevelOverride = "";
    setThreadMetadataRootCwd(null);
    _setGitWatcherCwd = null;
    if (store.activeAppInstanceId === appInstanceId) {
      _textareaRef = null;
      _completedTextSubmitter = null;
      _composerInputOwner = null;
      _openPromptInExternalEditor = null;
      _appSetState = null;
      _appGetState = null;
      flushAgentIdleWaitersIfIdle();
      setStatusIndicatorStateSetter(null);
      store.activeAppInstanceId = 0;
      stopTurnTimer();
      stopStartupTips(contextValue, false);
    }
  });

  // Initialize on mount
  onMount(() => {
    runUiEffect(
      Effect.promise(async () => {
        _sessionStartTime = Date.now();
        const cwd = props.cwd;
        await liveSessionControlReady;

        const currentPluginRunner = pluginRunner();
        if (currentPluginRunner)
          await initializeRelayPlugins(currentPluginRunner, cwd, (warning) =>
            addConfigWarningBlock(contextValue, warning),
          );
        let configuredAgent: ResolvedLaunchAgent | null;
        try {
          configuredAgent = resolveAcpLaunchAgent(props.initialAgent, props.initialAcpCommand);
        } catch (err) {
          const requestedAgentName = props.initialAgent.trim() || getConfig().agents.default || "agent";
          getRelayLogger().error("ui.agent.resolve.error", {
            agentName: requestedAgentName,
            error: errorMessage(err),
          });
          addBlock({
            type: "info",
            id: nextBlockId(),
            content: errorMessage(err) || String(err),
            variant: "error",
          });
          return;
        }
        store.activeAgentProfile = props.initialDefaultRenderer
          ? "default"
          : resolveAgentProfile(configuredAgent?.profile);
        store.activeAgentBehaviorProfile = resolveAgentBehaviorProfileForLaunchAgent(configuredAgent);

        if (!configuredAgent) {
          addBlock({
            type: "info",
            id: nextBlockId(),
            content:
              "No agent configured. Set [agents].default in ~/.config/relay/config.toml or launch with --agent <name>.",
            variant: "error",
          });
          return;
        }

        const configuredTransport = configuredAgent.transport ?? "stdio";
        getRelayLogger().info("ui.agent.configured", {
          agentName: configuredAgent.name,
          profile: configuredAgent.profile,
          transport: configuredTransport,
          command: path.basename(configuredAgent.command),
          argCount: configuredAgent.args.length,
          inline: props.initialAcpCommand !== undefined,
        });
        const acpOpts = acpLaunchOptionsForAgent(configuredAgent, cwd);
        store.rootCwd = cwd;
        setThreadMetadataRootCwd(cwd);
        store.activeAcpLaunchOptions = acpOpts;
        store.activeAcpClientFactory = props.acpClientFactory;
        store.activeAgentCommandCacheKey = agentCommandCacheKey({
          agentName: configuredAgent.name,
          profile: configuredAgent.profile,
          transport: configuredAgent.transport ?? "stdio",
          command: configuredAgent.command,
          args: configuredAgent.args,
          shell: "shell" in configuredAgent ? configuredAgent.shell : false,
          env: configuredAgent.env,
          url: configuredAgent.url,
          headers: configuredAgent.headers,
          protocols: configuredAgent.protocols,
          framing: configuredAgent.framing,
        });
        store.cachedAgentCommands = readCachedAgentCommands(store.activeAgentCommandCacheKey);

        const loadedPersistedThreads = loadThreadsForWorkspace(cwd);
        const persistedThreads = loadedPersistedThreads
          ? {
              activeThreadId: loadedPersistedThreads.activeThreadId,
              threads: loadedPersistedThreads.threads.map((thread) => sanitizePersistedThread(thread)),
            }
          : null;
        const persistedActiveThread = persistedThreads?.threads.find(
          (thread) => !thread.archived && thread.id === persistedThreads.activeThreadId,
        );
        const fallbackThread = persistedThreads?.threads.find((thread) => !thread.archived);
        const createRootThread = (): ThreadInfo => {
          const now = new Date().toISOString();
          const relaySessionId = createRelaySessionId();
          return {
            id: `thread-${Date.now().toString(36)}-root`,
            relaySessionId,
            relaySessionName: relaySessionNameFromId(
              relaySessionId,
              persistedThreads?.threads.map(threadRelaySessionName),
            ),
            title: "New thread",
            sessionId: null,
            agentName: configuredAgent.name,
            cwd,
            workspaceKind: "local",
            status: "connecting",
            archived: false,
            createdAt: now,
            updatedAt: now,
          };
        };
        const candidateInitialThread = persistedActiveThread ?? fallbackThread;
        const shouldStartFreshThread =
          !props.initialContinue &&
          !props.initialResume &&
          !props.initialResumeSessionId &&
          !!candidateInitialThread?.sessionId;
        const initialThread: ThreadInfo = shouldStartFreshThread
          ? createRootThread()
          : (candidateInitialThread ?? createRootThread());
        const initialThreads = persistedThreads?.threads.length ? [...persistedThreads.threads] : [];
        if (!initialThreads.some((thread) => thread.id === initialThread.id)) {
          initialThreads.unshift(initialThread);
        }
        setState("threads", initialThreads.length ? initialThreads : [initialThread]);
        contextValue.setActiveThreadState(initialThread, [...contextValue.state.blocks], []);
        gitWatcherSetCwd(initialThread.cwd);
        addWelcomeBlocks(addBlock, initialThread.cwd);
        if (props.initialYolo) {
          store.threadYoloEnabled.add(initialThread.id);
          store.threadYoloLaunchEnabled.add(initialThread.id);
          addBlock({
            type: "info",
            id: nextBlockId(),
            content: "/yoloo enabled: All requests, including unsafe commands, are auto-approved.",
            variant: "warning",
          });
        }
        setState("providerName", configuredAgent.name);

        store.activeAgentName = configuredAgent.name;

        let clientRef: AcpClient | null = null;
        const callbacks = createThreadCallbacks(contextValue, initialThread.id, () => clientRef);
        const clientOpts: AcpClientOptions = withLiveSessionEnv(
          withPluginMcpServers({
            ...acpOpts,
            cwd: initialThread.cwd,
            agentBehaviorProfile: store.activeAgentBehaviorProfile,
            agentName: configuredAgent.name,
          }),
          initialThread,
          contextValue.state.threads,
        );
        const client = props.acpClientFactory?.(callbacks, clientOpts) ?? new AcpClient(callbacks, clientOpts);
        clientRef = client;
        if (appInstanceId !== store.activeAppInstanceId) {
          await client.disposeAsync();
          return;
        }
        store.acpClient = client;
        store.threadClients.set(initialThread.id, client);
        const initialClientStillCurrent = () =>
          appInstanceId === store.activeAppInstanceId &&
          store.threadClients.get(initialThread.id) === client &&
          store.acpClient === client;

        setState("connecting", true);
        setState("connectingAgentName", configuredAgent.name);
        if ((acpOpts.transport ?? "stdio") === "stdio") {
          emitPluginEvent({
            type: "agent:process:start",
            command: acpOpts.command ?? "",
            args: acpOpts.args ?? [],
          });
        }
        emitPluginEvent({ type: "agent:connect:start", agentName: configuredAgent.name });

        let blocksBeforeHistory: ChatBlock[] | undefined;
        try {
          await connectAcpClientWithTimeout(client, configuredAgent.name);
          if (appInstanceId !== store.activeAppInstanceId) {
            await client.disposeAsync();
            return;
          }
          await startupProcessExitSettle();
          if (!initialClientStillCurrent()) return;
          setState("providerName", configuredAgent.name);
          applyAcpClientCapabilities(contextValue as ReturnType<typeof useApp>, client);
          emitPluginEvent({ type: "agent:connect:ready", agentName: configuredAgent.name, capabilities: null });

          syncCurrentThreadStatus(contextValue, "connecting");
          if (props.initialContinue) {
            await resumeMostRecentSession(contextValue as ReturnType<typeof useApp>, client, configuredAgent.name);
          } else if (props.initialResumeSessionId) {
            await loadSession(
              props.initialResumeSessionId,
              contextValue as ReturnType<typeof useApp>,
              client,
              configuredAgent.name,
            );
          } else if (props.initialResume) {
            await openResumePicker(contextValue as ReturnType<typeof useApp>, client);
          } else {
            if (initialThread.sessionId) {
              let renderedUpdateCount = 0;
              const { result: sessionResult, updates: loadedSessionUpdates } = await loadSessionHistory(
                client,
                initialThread.id,
                initialThread.sessionId,
                initialThread.cwd,
                additionalDirectoriesForThread(initialThread, contextValue.state.threads),
                (earlyUpdates) => {
                  if (!initialClientStillCurrent()) return;
                  blocksBeforeHistory ??= threadUiAdapter(
                    contextValue as ReturnType<typeof useApp>,
                    initialThread.id,
                  ).state.blocks.slice();
                  replayLoadedSessionUpdates(
                    contextValue as ReturnType<typeof useApp>,
                    initialThread.id,
                    earlyUpdates,
                    false,
                  );
                  renderedUpdateCount = earlyUpdates.length;
                },
              );
              syncCurrentThreadSession(contextValue, sessionResult.sessionId ?? initialThread.sessionId);
              syncCurrentThreadStatus(contextValue, "paused");
              applyThreadSessionCapabilities(
                contextValue as ReturnType<typeof useApp>,
                initialThread.id,
                sessionResult,
                { replace: true },
              );
              replayLoadedSessionUpdates(
                contextValue as ReturnType<typeof useApp>,
                initialThread.id,
                loadedSessionUpdates.slice(renderedUpdateCount),
                loadedSessionUpdates.length > 0,
              );
              emitPluginEvent({
                type: "session:load",
                sessionId: initialThread.sessionId,
                cwd: initialThread.cwd,
                threadId: initialThread.id,
              });
              let latestSessionResult: SessionCapabilitiesResult & { sessionId?: string } = sessionResult;
              const preferredModelResult = await applyPreferredModelForNewSession(
                contextValue as ReturnType<typeof useApp>,
                client,
                configuredAgent.name,
                latestSessionResult,
              );
              if (preferredModelResult) {
                applyThreadSessionCapabilities(
                  contextValue as ReturnType<typeof useApp>,
                  initialThread.id,
                  preferredModelResult,
                );
                latestSessionResult = {
                  ...mergeSessionCapabilities(latestSessionResult, preferredModelResult),
                  sessionId: latestSessionResult.sessionId,
                };
              }
              const preferredThinkingResult = await applyPreferredThinkingLevelForNewSession(
                contextValue as ReturnType<typeof useApp>,
                client,
                configuredAgent.name,
                latestSessionResult,
              );
              if (preferredThinkingResult) {
                applyThreadSessionCapabilities(
                  contextValue as ReturnType<typeof useApp>,
                  initialThread.id,
                  preferredThinkingResult,
                );
              }
              if (!initialClientStillCurrent()) return;
              addBlock({
                type: "info",
                id: nextBlockId(),
                content: `Connected to ${configuredAgent.name} agent (session: ${sessionResult.sessionId})`,
                variant: "info",
              });
            } else {
              store.historyLoadedSessionIdsByThread.delete(initialThread.id);
              store.allowGlobalPromptHistoryContinuation = true;
              if (!initialClientStillCurrent()) return;
              syncCurrentThreadStatus(contextValue, "paused");
              addBlock({
                type: "info",
                id: nextBlockId(),
                content: `Connected to ${configuredAgent.name} agent`,
                variant: "info",
              });
            }
          }
          if (!initialClientStillCurrent()) return;
          setState("connecting", false);
          startStartupTips(contextValue);

          // Auto-submit initial prompt if provided via CLI, otherwise drain startup-queued input.
          let queueDrained = false;
          if (props.initialPrompt) {
            handleSubmit(props.initialPrompt, contextValue as ReturnType<typeof useApp>);
            if (!props.initialPrompt.startsWith("!")) {
              queueDrained = drainReadyPromptQueue(contextValue as ReturnType<typeof useApp>, initialThread.id);
            }
          } else {
            queueDrained = drainReadyPromptQueue(contextValue as ReturnType<typeof useApp>, initialThread.id);
          }
          const currentInitialThread = contextValue.state.threads.find(
            (thread) => thread.id === initialThread.id && !thread.archived,
          );
          if (!props.initialResume && currentInitialThread && !currentInitialThread.sessionId && !queueDrained) {
            warmThreadSessionCapabilities(contextValue as ReturnType<typeof useApp>, initialThread.id);
          }
        } catch (err) {
          await startupProcessExitSettle();
          if (!initialClientStillCurrent()) return;
          if (blocksBeforeHistory) {
            restoreBlocksBeforeHistory(
              contextValue as ReturnType<typeof useApp>,
              initialThread.id,
              blocksBeforeHistory,
            );
          }
          setState("connecting", false);
          emitPluginEvent({
            type: "agent:connect:error",
            agentName: configuredAgent.name,
            error: err instanceof Error ? err.message : String(err),
          });
          addBlock({
            type: "info",
            id: nextBlockId(),
            content: formatConnectionFailure(configuredAgent.name, err, client),
            variant: "error",
          });
        }

        return;
      }),
    );
  });

  // Opens the current prompt buffer in $EDITOR, suspending the OpenTUI renderer
  // so the editor can take over the terminal. On exit, copy the saved contents
  // back into the textarea.
  let _externalEditorActive = false;
  async function openPromptInExternalEditor(initialTextOverride?: string): Promise<void> {
    if (_externalEditorActive) return;
    if (!_textareaRef) return;
    if (composerInputOwner() !== "composer") return;

    _externalEditorActive = true;
    const initialText = initialTextOverride ?? getTextareaText();
    try {
      try {
        renderer.suspend();
      } catch {
        // Suspending is a best-effort optimisation; the editor still runs in
        // inherited stdio if suspending fails.
      }
      const result = await (props.externalEditor ?? openTextInExternalEditor)({ text: initialText });
      if (result.changed || initialTextOverride !== undefined) {
        applyTextareaTextUpdate(_textareaRef, result.text, result.text.length);
        refreshCurrentPasteHighlights();
        resetVimState();
      }
    } catch {
      // Swallow - editor failures should not crash the TUI.
    } finally {
      try {
        renderer.resume();
      } catch {
        // ignore
      }
      _externalEditorActive = false;
    }
  }

  _openPromptInExternalEditor = openPromptInExternalEditor;

  function focusComposerAfterSidebarAction(): void {
    setThreadSidebarExpanded(false);
    setSidebarFocused(false);
    try {
      _textareaRef?.focus?.();
    } catch {}
  }

  // Keyboard handler
  useKeyboard(
    createAppKeyboardHandler({
      contextValue,
      renderer,
      appInstanceId,
      activeAppInstanceId: () => store.activeAppInstanceId,
      composerInputOwner,
      pluginOverlayOpen,
      handlePluginDialogKey: pluginDialogs.handleKey,
      openPromptInExternalEditor,
      textareaRef: () => _textareaRef,
      acpClient: () => store.acpClient,
      agentBehaviorProfile: () => store.activeAgentBehaviorProfile,
      pluginRunner: () => store.pluginRunner,
      isTabCompleting: () => _tabCompleting,
      activeSettingsValueSetting: () => _activeSettingsValueSetting,
      activeSettingsSubmenu: () => _activeSettingsSubmenu,
      userBashAbortController: () => _userBashAbortController,
      clearSelectionAllItems: () => {
        _selectionAllItems = [];
      },
      hideOverlay,
      isOverlayVisible,
      settingsOverlayActive,
      selectionMode,
      setSelectionMode,
      overlayItems,
      overlayIndex,
      setOverlayIndex,
      showSelectionOverlay,
      selectOverlayItem,
      toggleSelectedPlugin,
      openNotificationSettingsOverlay,
      openSettingsOverlay,
      openPluginsOverlay,
      openPromptHistorySearch,
      interruptAcpPrompt,
      shutdownAndExit,
      createThread,
      selectThread,
      archiveThread,
      openExistingWorktreePicker,
      setSessionModeFromKeyboard,
      cycleSessionModelFromKeyboard,
      cycleSessionThinkingLevelFromKeyboard,
      cancelElicitation,
      navigateElicitationField,
      selectElicitationChoice,
      restoreEditingQueuedPrompt,
      deleteEditingQueuedPrompt,
      cancelPendingQueueFocus,
      exitQueueBrowse,
      navigatePromptHistory,
      moveFocusedQueuedPrompt,
      moveQueueFocus,
      sendFocusedQueuedPromptNow,
      editFocusedQueuedPrompt,
      cancelFocusedQueuedPrompt,
      handleActiveTurnInput,
      doTabPathCompletion,
      refreshCurrentPasteHighlights,
      insertPromptTextAtCursor,
      getTextareaText,
      resetDoublePressState,
      markInputUpdateSource,
      nativeModal: nativeModals.current,
      openNativeModal: nativeModals.open,
      closeNativeModal: nativeModals.close,
      fileChangesModalOpen,
      threadSidebarExpanded,
      setThreadSidebarExpanded,
      showThreadSidebar,
      setShowThreadSidebar,
      sidebarFocused,
      setSidebarFocused,
      sidebarFocusedIndex,
      setSidebarFocusedIndex,
      setThreadSidebarListOffset,
      vimEnabled,
      vimState,
      setVimState,
      queueFocusIndex,
      setQueueFocusIndex,
      editingQueueItem,
      approvalOptionIndex,
      setApprovalOptionIndex,
      setElicitationOptionIndex,
      setWelcomeDismissed,
    }),
  );

  /**
   * Copies a completed renderer selection after expanding hidden paste placeholders.
   *
   * @param selection - Stabilized selection whose rendered text should be copied.
   * @returns Nothing; clipboard and toast state are updated when selected text is present.
   */
  const copyCompletedSelection = (selection: Selection) => {
    let text = selection.getSelectedText();
    if (!text) return;
    text = copySelectionWithPasteExpansion(_textareaRef, pasteStore, text);
    copyToClipboard(text);
    showToast("Copied to clipboard");
  };

  // Windowed transcripts may need one more layout pass before copied text is complete.
  useSelectionHandler((selection) => {
    const result = _transcriptSelectionCoordinator?.completeSelection(selection, copyCompletedSelection);
    if (result === "deferred") return;
    if (result === "too-large") {
      showToast("Selection is too large to copy while transcript paging is enabled", "warning");
      return;
    }
    copyCompletedSelection(selection);
  });

  return (
    <ChatRoute
      contextValue={contextValue}
      toastValue={toastValue}
      fileChangesModalOpen={fileChangesModalOpen}
      setFileChangesModalOpen={setDiffOverlayOpen}
      diffOverlayCommand={diffOverlayCommand}
      diffOverlayRequest={diffOverlayRequest}
      nativeModal={nativeModals.current}
      openNativeModal={nativeModals.open}
      closeNativeModal={nativeModals.close}
      toggleNativeModal={nativeModals.toggle}
      tips={() => {
        pluginChromeRevision();
        nativeChromeRevision();
        return activeStartupTips();
      }}
      welcomeDismissed={welcomeDismissed}
      hideThinking={hideThinking}
      activeAgentProfile={() => store.activeAgentProfile}
      approvalOptionIndex={approvalOptionIndex}
      elicitationOptionIndex={elicitationOptionIndex}
      setElicitationOptionIndex={setElicitationOptionIndex}
      getSpinnerChar={getSpinnerChar}
      renderer={renderer}
      transcriptRendererMode={transcriptRendererMode}
      onTranscriptSelectionCoordinatorChange={(coordinator) => {
        _transcriptSelectionCoordinator = coordinator;
      }}
      selectElicitationChoice={selectElicitationChoice}
      overlayItems={overlayItems}
      overlayIndex={overlayIndex}
      overlayLayout={overlayLayout}
      maxOverlayVisible={MAX_OVERLAY_VISIBLE}
      slashPanelPosition={slashPanelPosition}
      selectionMode={selectionMode}
      filterOverlayItems={filterOverlayItems}
      showOverlay={(items) => showOverlay(items)}
      hideOverlay={hideOverlay}
      isOverlayVisible={isOverlayVisible}
      selectOverlayItem={selectOverlayItem}
      getVisibleSlashCommands={getVisibleSlashCommands}
      ensureSlashCommandMetadata={() => ensureSlashCommandMetadata(contextValue as ReturnType<typeof useApp>)}
      setActiveCompletion={(completion) => {
        _activeCompletion = completion;
      }}
      setTabCompleting={(value) => {
        _tabCompleting = value;
      }}
      consumeInputUpdateSource={consumeInputUpdateSource}
      onPromptTextChanged={onPromptTextChanged}
      setTextareaRef={(ref, previousRef) => {
        if (appInstanceId !== store.activeAppInstanceId) return;
        if (previousRef !== undefined && _textareaRef !== previousRef) return;
        _textareaRef = ref;
      }}
      setCompletedTextSubmitter={(submitter, previousSubmitter) => {
        if (appInstanceId !== store.activeAppInstanceId) return;
        if (previousSubmitter !== undefined && _completedTextSubmitter !== previousSubmitter) return;
        _completedTextSubmitter = submitter;
      }}
      textareaRef={() => _textareaRef}
      composerText={composerText}
      resetDoublePressState={resetDoublePressState}
      currentSessionId={() => store.acpClient?.sessionId ?? null}
      commandContext={() => createRelayCommandContext(contextValue as ReturnType<typeof useApp>)}
      queueFocusIndex={queueFocusIndex}
      editingQueueItem={editingQueueItem}
      queueMaxSize={MAX_QUEUE}
      vimStatus={() => (vimEnabled() ? getVimStatus(vimState()) : null)}
      pluginRunner={() => pluginRunner()}
      nativeStatusSegments={nativeStatusSegments}
      pluginRevision={pluginRevision}
      configRevision={configRevision}
      pluginWidgetRevision={pluginWidgetRevision}
      pluginChromeRevision={pluginChromeRevision}
      pluginDialog={pluginDialogs.current}
      cancelPluginDialog={pluginDialogs.cancelActive}
      handleSubmit={handleSubmit}
      composerInputOwner={composerInputOwner}
      threads={() => state.threads}
      activeThreadId={() => state.activeThreadId}
      showSidebar={showThreadSidebar}
      sidebarFocused={sidebarFocused}
      sidebarFocusedIndex={sidebarFocusedIndex}
      sidebarExpanded={threadSidebarExpanded}
      sidebarWidth={() => (threadSidebarExpanded() ? Math.max(42, terminalColumns() - 2) : 32)}
      sidebarListOffset={threadSidebarListOffset}
      getThreadPreview={(threadId) =>
        threadId === state.activeThreadId
          ? previewFromBlocks(state.blocks) || store.threadPreviews.get(threadId) || ""
          : store.threadPreviews.get(threadId) || ""
      }
      selectThread={(threadId) => {
        void selectThread(contextValue, threadId)
          .then(focusComposerAfterSidebarAction)
          .catch((err) => showToast(`Failed to switch thread: ${err}`, "error"));
      }}
      createLocalThread={() => {
        void createThread(contextValue, false)
          .then(focusComposerAfterSidebarAction)
          .catch((err) => showToast(`Failed to create thread: ${err}`, "error"));
      }}
      createWorktreeThread={() => {
        void createThread(contextValue, true)
          .then(focusComposerAfterSidebarAction)
          .catch((err) => showToast(`Failed to create worktree: ${err}`, "error"));
      }}
      createExistingWorktreeThread={() => {
        openExistingWorktreePicker(contextValue);
      }}
      archiveThread={(threadId) => {
        void archiveThread(contextValue, threadId).catch((err) => {
          const message = errorMessage(err);
          showToast(message ? `Failed to archive thread: ${message}` : "Failed to archive thread", "error", 6000);
        });
      }}
      onRootMouseDown={() => {
        if (state.selectedSubagentToolCallId !== null) return;
        if (fileChangesModalOpen()) {
          closeDiffOverlay();
          return;
        }
        if (nativeModals.current()) {
          nativeModals.close();
          return;
        }
        setSidebarFocused(false);
        if (state.transcriptSelectedBlockId) {
          setState("transcriptSelectedRows", state.transcriptSelectedBlockId, false);
          setState("transcriptSelectedBlockId", null);
        }
        if (_textareaRef && typeof _textareaRef.focus === "function") {
          try {
            _textareaRef.focus();
          } catch {}
        }
      }}
      onRootMouseUp={() => {
        if (state.selectedSubagentToolCallId !== null) return;
        if (fileChangesModalOpen()) return;
        if (_textareaRef && typeof _textareaRef.focus === "function") {
          try {
            _textareaRef.focus();
          } catch {}
        }
      }}
    />
  );
}
