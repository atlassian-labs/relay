/**
 * Global TUI keyboard handler.
 *
 * This is the single `useKeyboard` callback for the app, extracted from
 * app-root so the root module is no longer dominated by ~700 lines of key
 * dispatch. The handler is a leaf — nothing calls back into it — so it takes a
 * fully-typed `KeyboardHandlerDeps` bundle of the root's signals, sibling
 * handlers, and live accessors for the module-level singletons (`_textareaRef`,
 * `_acpClient`, …). The typed interface means the compiler rejects app-root if
 * any dependency is left unwired.
 */

import { type ListItem, SelectionMode } from "../autocomplete";
import {
  type ChatBlock,
  type ToolBlock,
  type ElicitationBlock,
  type QueuedPrompt,
  type SessionModeOption,
  nextBlockId,
  useApp,
} from "../state";
import type { AgentBehaviorProfile } from "../../acp/agent-profile";
import type { AcpClient, AcpSessionInfo } from "../../acp/client";
import type { PluginRunner, RelayWidgetKeyEvent } from "../../plugins";
import type { RelayWidgetEntry } from "../../plugins/slots";
import type { ConfigSetting, EditableConfigKey } from "../../config/schema";
import type { AcpConfigOptionValueItem, SettingsSubmenuId } from "../util/settings";
import type { SettingsSelection } from "./settings-overlay-controller";
import type { VimState } from "../util/vim-engine";
import type { NativeModalId } from "./native-modal-controller";
import type { SelectionOverlayBehavior } from "./selection-overlay";
import type { InputUpdateSource } from "../component/composer";
import type { ComposerInputOwner } from "../util/composer-input";
import type { DiffOverlayAction } from "../component/diff-overlay";
import { type ActiveTurnInputSubmission, validateActiveTurnInput } from "./active-turn-input";
import type { PluginDialogKeyboardEvent } from "./plugin-dialogs";
import { nextConversationMessageIndex } from "./conversation-tree";

import {
  isSgrMouseReportInput,
  isSgrMouseReportPrefix,
  printableInputFromEvent,
  stripLeadingSgrMouseReportSequences,
} from "./printable-input";
import { isSoftComposerInputOwner } from "../util/composer-input";
import { hasOptionModifier, isEnterKey } from "../util/key-events";
import { getTextareaCursorRow, getTextareaLineCount, terminalColumns, terminalRows } from "./terminal";
import {
  EMPTY_QUEUE_EDIT_MESSAGE,
  queueMoveAction,
  queueNavigationAction,
  queuedPromptToText,
  removeQueuedPromptAt,
} from "../util/prompt-queue";
import { extractMarkdownLinks, openUrl } from "../util/links";
import { truncateTextEnd } from "../util/format";
import { linkSelectionItems } from "./link-selection";
import { findPendingApprovalBlock } from "./approval-block";
import {
  computeSidebarLayout,
  ensureSidebarIndexVisible,
  horizontalSidebarFocus,
  verticalSidebarFocus,
  visibleSidebarThreads,
} from "./sidebar-navigation";
import {
  armCtrlCHint,
  armCtrlDHint,
  isCtrlCSecondPress,
  isCtrlDSecondPress,
  resetCtrlCState,
  resetCtrlDState,
} from "./ctrl-c-exit";
import { hideStatusHint } from "./status-indicators";
import { createTextareaVimEditor } from "../util/vim-editor";
import { handleVimKey, shouldVimHandleEnter } from "../util/vim-engine";
import { refreshVimSelectionHighlight } from "../util/vim-selection-highlight";
import { getColors } from "../context/theme";
import { handlePasteKeyEvent, restorePasteMappings } from "../util/paste-textarea";
import { promptHistory } from "../component/composer";
import { pasteStore } from "../paste";
import { ApprovalResponse, isApprovalSelectionAllow, type ApprovalOption } from "../../core/events";
import { closeDiffOverlay, sendDiffOverlayCommand } from "./diff-overlay-controller";
import { elicitationOptionCount, isEditingCustomElicitationInput, pendingElicitationBlock } from "./elicitation";
import { showToast } from "./toast-controller";
import { errorMessage } from "../../effect/errors";
import { hierarchicalSessionSelectionItems, RESUME_PICKER_LAYOUT, resumableSessions } from "./session-list";
import { nativeChildSessionRelations } from "./resume-session-relations";
import { store } from "./runtime-store";
import { scheduleAcpEscapeInterrupt } from "./escape-interrupt-guard";
import { getConfig } from "../../config";
import { buildToolCallGroupProjection, toolCallGroupNavigableIds } from "../util/tool-call-groups";
import { SUBAGENT_PICKER_LAYOUT, subagentListItems, subagentPickerBehavior } from "./subagents";
import { CHILD_PICKER_LAYOUT, childListItems, childPickerBehavior, parentThreadForChild } from "./children";

type App = ReturnType<typeof useApp>;
type Updater<T> = T | ((prev: T) => T);

function isAcpSessionInfo(value: unknown): value is AcpSessionInfo {
  return value !== null && typeof value === "object" && "sessionId" in value && typeof value.sessionId === "string";
}

function isPromptInsertionOwner(owner: ComposerInputOwner): boolean {
  return owner === "composer" || owner === "textarea-overlay" || isSoftComposerInputOwner(owner);
}

function approvalOptionsForBlock(block: ToolBlock): readonly ApprovalOption[] {
  return block.approvalOptions ?? [];
}

interface KeyboardEventLike {
  readonly name?: unknown;
  readonly sequence?: unknown;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  readonly shift?: boolean;
  readonly alt?: boolean;
  readonly option?: boolean;
  preventDefault?: () => void;
  stopPropagation?: () => void;
}

function consumeKeyboardEvent(event: KeyboardEventLike): void {
  event.preventDefault?.();
  event.stopPropagation?.();
}

function toRelayWidgetKeyEvent(event: KeyboardEventLike): RelayWidgetKeyEvent {
  const sequence = typeof event.sequence === "string" ? event.sequence : undefined;
  return {
    name: String(event.name ?? ""),
    ...(sequence !== undefined ? { sequence } : {}),
    ctrl: event.ctrl === true,
    meta: event.meta === true,
    shift: event.shift === true,
    alt: event.alt === true,
    option: event.option === true,
    printable: printableInputFromEvent(event),
  };
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  if (typeof value !== "object" || value === null) return false;
  const then = (value as { readonly then?: unknown }).then;
  return typeof then === "function";
}

function focusedPluginWidgetHandlesKey(
  runner: PluginRunner,
  entry: RelayWidgetEntry,
  event: KeyboardEventLike,
  keyName: string,
): boolean {
  const handler = entry.widget.onKey;
  if (!handler) {
    consumeKeyboardEvent(event);
    if (keyName === "escape" || (event.ctrl === true && keyName === "c")) entry.widget.onClose?.();
    return true;
  }

  try {
    const result = handler(toRelayWidgetKeyEvent(event));
    if (isPromiseLike(result)) {
      consumeKeyboardEvent(event);
      void result.catch((error: unknown) =>
        runner.recordError(entry.plugin, `Widget key handler failed for ${entry.key}`, error),
      );
      return true;
    }
    if (result === false) return false;
    consumeKeyboardEvent(event);
    return true;
  } catch (error) {
    consumeKeyboardEvent(event);
    runner.recordError(entry.plugin, `Widget key handler failed for ${entry.key}`, error);
    return true;
  }
}

export interface KeyboardHandlerDeps {
  // Component-scoped values
  contextValue: App;
  renderer: any;
  appInstanceId: number;
  activeAppInstanceId: () => number;
  composerInputOwner: () => ComposerInputOwner;
  pluginOverlayOpen: () => boolean;
  handlePluginDialogKey: (event: PluginDialogKeyboardEvent) => boolean;
  openPromptInExternalEditor: () => Promise<void> | void;

  // Live accessors for module-level singletons
  textareaRef: () => any;
  acpClient: () => AcpClient | null;
  agentBehaviorProfile: () => AgentBehaviorProfile;
  pluginRunner: () => PluginRunner | null;
  isTabCompleting: () => boolean;
  activeSettingsValueSetting: () => ConfigSetting | null;
  activeSettingsSubmenu: () => SettingsSubmenuId | null;
  userBashAbortController: () => AbortController | null;
  clearSelectionAllItems: () => void;

  // Overlay controls
  hideOverlay: () => void;
  isOverlayVisible: () => boolean;
  settingsOverlayActive: () => boolean;
  selectionMode: () => SelectionMode | null;
  setSelectionMode: (mode: SelectionMode | null) => void;
  overlayItems: () => ListItem<any>[];
  overlayIndex: () => number;
  setOverlayIndex: (value: Updater<number>) => void;
  showSelectionOverlay: (
    items: ListItem<any>[],
    mode: SelectionMode,
    layout?: any,
    selectedIndex?: number,
    behavior?: SelectionOverlayBehavior,
  ) => void;
  selectOverlayItem: (app: App, submitSlashCompletion?: boolean) => void;
  toggleSelectedPlugin: (app: App) => void;
  openNotificationSettingsOverlay: (selected?: EditableConfigKey) => void;
  openSettingsOverlay: (selected?: SettingsSelection) => void;
  openPluginsOverlay: (selectedPluginId?: string) => void;
  openPromptHistorySearch: () => void;

  // Agent / thread orchestration
  interruptAcpPrompt: (app: App, mode: "fire-and-forget" | "await-cancel") => Promise<boolean>;
  shutdownAndExit: (renderer: { destroy: () => void }, exitCode?: number) => Promise<void>;
  createThread: (
    app: App,
    inWorktree: boolean,
    options?: { snapshotCurrent?: boolean; cwd?: string; select?: boolean },
  ) => Promise<unknown>;
  selectThread: (app: App, threadId: string, options?: { snapshotCurrent?: boolean }) => Promise<void>;
  archiveThread: (app: App, threadId: string) => Promise<void>;
  openExistingWorktreePicker: (app: App) => void;
  setSessionModeFromKeyboard: (
    nextMode: SessionModeOption,
    app: App,
    setModeId: (modeId: string) => void,
  ) => Promise<void>;
  cycleSessionModelFromKeyboard: (app: App, direction: 1 | -1) => void;
  cycleSessionThinkingLevelFromKeyboard: (app: App, direction: 1 | -1) => void;

  // Elicitation / queue / completion
  cancelElicitation: (app: App, block: ElicitationBlock) => void;
  navigateElicitationField: (app: App, block: ElicitationBlock, delta: -1 | 1) => void;
  selectElicitationChoice: (app: App, block: ElicitationBlock) => void;
  restoreEditingQueuedPrompt: (app: App) => boolean;
  deleteEditingQueuedPrompt: (app: App) => boolean;
  cancelPendingQueueFocus: () => boolean;
  exitQueueBrowse: (app: App) => void;
  navigatePromptHistory: (direction: -1 | 1) => boolean;
  moveFocusedQueuedPrompt: (delta: number, app: App) => boolean;
  moveQueueFocus: (delta: number, app: App) => number | null;
  sendFocusedQueuedPromptNow: (app: App) => boolean;
  editFocusedQueuedPrompt: (app: App) => boolean;
  cancelFocusedQueuedPrompt: (app: App) => boolean;
  handleActiveTurnInput: (submission: ActiveTurnInputSubmission, app: App) => void;
  doTabPathCompletion: (app: App) => void;
  refreshCurrentPasteHighlights: () => void;
  insertPromptTextAtCursor: (text: string) => boolean;
  getTextareaText: () => string;
  resetDoublePressState: () => void;
  markInputUpdateSource: (source: InputUpdateSource, text: string) => void;

  // Signals
  nativeModal: () => NativeModalId | null;
  openNativeModal: (id: NativeModalId) => void;
  closeNativeModal: (id?: NativeModalId) => void;
  fileChangesModalOpen: () => boolean;
  threadSidebarExpanded: () => boolean;
  setThreadSidebarExpanded: (value: boolean) => void;
  showThreadSidebar: () => boolean;
  setShowThreadSidebar: (value: boolean) => void;
  sidebarFocused: () => boolean;
  setSidebarFocused: (value: boolean) => void;
  sidebarFocusedIndex: () => number;
  setSidebarFocusedIndex: (value: Updater<number>) => void;
  setThreadSidebarListOffset: (value: Updater<number>) => void;
  vimEnabled: () => boolean;
  vimState: () => VimState;
  setVimState: (state: VimState) => void;
  queueFocusIndex: () => number | null;
  setQueueFocusIndex: (value: number | null) => void;
  editingQueueItem: () => QueuedPrompt | null;
  approvalOptionIndex: () => number;
  setApprovalOptionIndex: (value: Updater<number>) => void;
  setElicitationOptionIndex: (value: Updater<number>) => void;
  setWelcomeDismissed: (value: boolean) => void;
}

export function createAppKeyboardHandler(deps: KeyboardHandlerDeps): (evt: any) => void {
  const {
    contextValue,
    renderer,
    appInstanceId,
    activeAppInstanceId,
    composerInputOwner,
    pluginOverlayOpen,
    handlePluginDialogKey,
    openPromptInExternalEditor,
    textareaRef,
    acpClient,
    agentBehaviorProfile,
    pluginRunner,
    isTabCompleting,
    activeSettingsValueSetting,
    activeSettingsSubmenu,
    userBashAbortController,
    clearSelectionAllItems,
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
    nativeModal,
    openNativeModal,
    closeNativeModal,
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
  } = deps;

  const { state, setState, addBlock, updateBlock, cancelController } = contextValue;
  let pendingSgrMouseReportTail = "";
  let pendingSgrMouseReportTailOwner: ComposerInputOwner | null = null;

  function clearQueueFocus(): void {
    cancelPendingQueueFocus();
    setQueueFocusIndex(null);
  }

  function insertPromptTextForOwner(owner: ComposerInputOwner, text: string): boolean {
    if (!isPromptInsertionOwner(owner)) return false;
    if (owner === "queue") exitQueueBrowse(contextValue);
    if (owner === "sidebar") {
      setSidebarFocused(false);
      hideStatusHint();
    }
    return insertPromptTextAtCursor(text);
  }

  function flushPendingSgrMouseReportTail() {
    if (!pendingSgrMouseReportTail) return;
    const text = pendingSgrMouseReportTail;
    const owner = pendingSgrMouseReportTailOwner;
    pendingSgrMouseReportTail = "";
    pendingSgrMouseReportTailOwner = null;
    if (owner !== null) insertPromptTextForOwner(owner, text);
  }

  function handlePotentialSplitSgrMouseReportTail(
    evt: any,
    owner: ComposerInputOwner,
    printableInput: string | null,
  ): boolean {
    if (!pendingSgrMouseReportTail && (printableInput === null || !printableInput.startsWith("<"))) return false;
    if (printableInput === null || !isPromptInsertionOwner(owner)) {
      flushPendingSgrMouseReportTail();
      return false;
    }

    const candidate = `${pendingSgrMouseReportTail}${printableInput}`;
    const strippedCandidate = stripLeadingSgrMouseReportSequences(candidate);
    if (strippedCandidate.stripped) {
      const restoreOwner = pendingSgrMouseReportTailOwner ?? owner;
      pendingSgrMouseReportTail = "";
      pendingSgrMouseReportTailOwner = null;
      if (strippedCandidate.text) insertPromptTextForOwner(restoreOwner, strippedCandidate.text);
      evt.preventDefault?.();
      evt.stopPropagation?.();
      return true;
    }
    if (isSgrMouseReportPrefix(candidate)) {
      pendingSgrMouseReportTail = candidate;
      pendingSgrMouseReportTailOwner = owner;
      evt.preventDefault?.();
      evt.stopPropagation?.();
      return true;
    }
    if (pendingSgrMouseReportTail) {
      const restoreOwner = pendingSgrMouseReportTailOwner ?? owner;
      pendingSgrMouseReportTail = "";
      pendingSgrMouseReportTailOwner = null;
      insertPromptTextForOwner(restoreOwner, candidate);
      evt.preventDefault?.();
      evt.stopPropagation?.();
      return true;
    }
    return false;
  }

  function steerFocusedQueuedPrompt(client: AcpClient | null): boolean {
    const focusedQueueIndex = queueFocusIndex();
    if (focusedQueueIndex === null) return false;
    const item = state.pendingQueue[focusedQueueIndex];
    if (!item) return false;
    if (item.images && item.images.length > 0) {
      showToast("Queued prompts with images cannot be steered", "warning");
      return true;
    }

    const text = queuedPromptToText(item);
    const validation = validateActiveTurnInput(
      { text, historyText: text },
      {
        running: Boolean(client && state.running),
        supportsActiveTurnInput: Boolean(client?.supportsActiveTurnInput()),
      },
    );
    if (!validation.ok) {
      if (validation.reason !== "empty") showToast(validation.message ?? "Could not add to current turn", "warning");
      return true;
    }

    const result = removeQueuedPromptAt(state.pendingQueue, focusedQueueIndex);
    setState("pendingQueue", result.queue);
    clearQueueFocus();
    handleActiveTurnInput({ text, historyText: text }, contextValue);
    return true;
  }

  return (evt: any) => {
    if (appInstanceId !== activeAppInstanceId()) return;

    // Live snapshots of the module-level singletons for this synchronous
    // dispatch. None are reassigned mid-handler, so a one-time read matches the
    // original closure semantics.
    const _textareaRef = textareaRef();
    const _acpClient = acpClient();
    const _pluginRunner = pluginRunner();
    const _tabCompleting = isTabCompleting();
    const _activeSettingsValueSetting = activeSettingsValueSetting();
    const _activeSettingsSubmenu = activeSettingsSubmenu();
    const _userBashAbortController = userBashAbortController();

    const keyName = String(evt.name ?? "").toLowerCase();
    if (state.selectedSubagentToolCallId !== null) {
      if (keyName === "escape") {
        const selectedToolCallId = state.selectedSubagentToolCallId;
        resetDoublePressState();
        contextValue.setState("selectedSubagentToolCallId", null);
        const items = subagentListItems(state.blocks);
        const selectedIndex = items.findIndex((item) => item.value.tool.toolCallId === selectedToolCallId);
        if (items.length > 0) {
          showSelectionOverlay(
            items,
            SelectionMode.SUBAGENT,
            SUBAGENT_PICKER_LAYOUT,
            Math.max(0, selectedIndex),
            subagentPickerBehavior(),
          );
        }
      }
      evt.preventDefault?.();
      evt.stopPropagation?.();
      return;
    }
    const printableInputOwner = composerInputOwner();
    if (isSgrMouseReportInput(evt)) {
      const sanitizedInput = printableInputFromEvent(evt);
      if (sanitizedInput !== null) insertPromptTextForOwner(printableInputOwner, sanitizedInput);
      evt.preventDefault?.();
      evt.stopPropagation?.();
      return;
    }
    if (handlePluginDialogKey(evt)) return;
    if (nativeModal() === "connection-error") {
      const reservedKeys = new Set(["up", "down", "pageup", "pagedown", "home", "end", "c", "escape"]);
      if (reservedKeys.has(keyName)) {
        evt.preventDefault?.();
        return;
      }
    }
    const isLeftKey = keyName === "left" || keyName === "arrowleft" || keyName === "leftarrow";
    const isRightKey = keyName === "right" || keyName === "arrowright" || keyName === "rightarrow";
    if (fileChangesModalOpen()) {
      if ((evt.ctrl && keyName === "c") || (!evt.ctrl && !evt.meta && (keyName === "escape" || keyName === "q"))) {
        closeDiffOverlay();
        evt.preventDefault?.();
        return;
      }

      let action: DiffOverlayAction | null = null;
      if (evt.ctrl && keyName === "f") action = "page-down";
      else if (evt.ctrl && keyName === "b") action = "page-up";
      else if (!evt.meta && !evt.ctrl) {
        if (keyName === "down" || keyName === "j") action = "scroll-down";
        else if (keyName === "up" || keyName === "k") action = "scroll-up";
        else if (keyName === "pagedown" || keyName === "space") action = "page-down";
        else if (keyName === "pageup") action = "page-up";
        else if (keyName === "home") action = "scroll-top";
        else if (keyName === "end") action = "scroll-bottom";
        else if (keyName === "n" || isRightKey) action = "next-file";
        else if (keyName === "p" || isLeftKey) action = "previous-file";
        else if (keyName === "m") action = "toggle-reviewed";
        else if (keyName === "s") action = "toggle-view";
      }
      if (action) sendDiffOverlayCommand(action);
      evt.preventDefault?.();
      return;
    }

    const parentThread = parentThreadForChild(state.threads, state.activeThreadId);
    if (
      evt.ctrl &&
      !evt.meta &&
      keyName === "p" &&
      parentThread &&
      nativeModal() === null &&
      !isOverlayVisible() &&
      !sidebarFocused()
    ) {
      const childThreadId = state.activeThreadId;
      void selectThread(contextValue, parentThread.id)
        .then(() => {
          const items = childListItems(contextValue.state.threads, parentThread.id);
          const selectedIndex = items.findIndex((item) => item.value.id === childThreadId);
          if (items.length === 0) return;
          showSelectionOverlay(
            items,
            SelectionMode.CHILD,
            CHILD_PICKER_LAYOUT,
            Math.max(0, selectedIndex),
            childPickerBehavior(selectThread, (error) =>
              showToast(
                `Failed to open child session: ${error instanceof Error ? error.message : String(error)}`,
                "error",
              ),
            ),
          );
        })
        .catch((error: unknown) =>
          showToast(
            `Failed to return to parent session: ${error instanceof Error ? error.message : String(error)}`,
            "error",
          ),
        );
      consumeKeyboardEvent(evt);
      return;
    }

    const printableInput = printableInputFromEvent(evt);
    if (handlePotentialSplitSgrMouseReportTail(evt, printableInputOwner, printableInput)) return;

    const selectedTranscriptBlockId = state.transcriptSelectedBlockId;
    const setTranscriptSelection = (id: string | null): void => {
      if (state.transcriptSelectedBlockId === id) return;
      if (state.transcriptSelectedBlockId) setState("transcriptSelectedRows", state.transcriptSelectedBlockId, false);
      if (id) setState("transcriptSelectedRows", id, true);
      setState("transcriptSelectedBlockId", id);
    };
    const navigableTranscriptIds = (): string[] => {
      const toolCallGroups = buildToolCallGroupProjection(state.blocks, getConfig().ui.tool_call_groups);
      return toolCallGroupNavigableIds(
        state.blocks,
        toolCallGroups,
        state.expandedToolCallGroups,
        getConfig().ui.show_thinking,
      );
    };
    if (
      selectedTranscriptBlockId !== null &&
      nativeModal() === null &&
      !isOverlayVisible() &&
      !pendingElicitationBlock(contextValue) &&
      !findPendingApprovalBlock(state.blocks)
    ) {
      const toolCallGroups = buildToolCallGroupProjection(state.blocks, getConfig().ui.tool_call_groups);
      const selectedToolCallGroup = toolCallGroups.byId.get(selectedTranscriptBlockId);
      const navigableIds = navigableTranscriptIds();
      const selectedIndex = navigableIds.indexOf(selectedTranscriptBlockId);
      if (selectedIndex < 0) {
        setTranscriptSelection(null);
        try {
          _textareaRef?.focus?.();
        } catch {}
        consumeKeyboardEvent(evt);
        return;
      }

      const noModifiers = !evt.ctrl && !evt.meta && !evt.shift && !hasOptionModifier(evt);
      const isUp = keyName === "up" || keyName === "arrowup" || (noModifiers && keyName === "k");
      const isDown = keyName === "down" || keyName === "arrowdown" || (noModifiers && keyName === "j");
      const optionArrowNavigation =
        !evt.ctrl && !evt.shift && hasOptionModifier(evt) && (keyName === "up" || keyName === "down");
      const detailPopupOpen = state.transcriptDetailBlockId === selectedTranscriptBlockId;
      const updateExpanded = (expanded: boolean): void => {
        setState("transcriptDetailBlockId", expanded ? selectedTranscriptBlockId : null);
      };

      if (detailPopupOpen) {
        if (keyName === "escape" || (noModifiers && isLeftKey)) {
          resetDoublePressState();
          updateExpanded(false);
          consumeKeyboardEvent(evt);
        }
        return;
      }

      if ((noModifiers || optionArrowNavigation) && (isUp || isDown)) {
        if (optionArrowNavigation && isUp && selectedIndex === 0) {
          setTranscriptSelection(null);
          try {
            _textareaRef?.focus?.();
          } catch {}
          consumeKeyboardEvent(evt);
          return;
        }
        if (optionArrowNavigation && isDown && selectedIndex === navigableIds.length - 1) {
          setTranscriptSelection(null);
          const queueIndex =
            state.pendingQueue.length > 0 && editingQueueItem() === null ? moveQueueFocus(1, contextValue) : null;
          if (queueIndex === null) {
            try {
              _textareaRef?.focus?.();
            } catch {}
          }
          consumeKeyboardEvent(evt);
          return;
        }
        const nextIndex = Math.max(0, Math.min(navigableIds.length - 1, selectedIndex + (isUp ? -1 : 1)));
        setTranscriptSelection(navigableIds[nextIndex] ?? selectedTranscriptBlockId);
        consumeKeyboardEvent(evt);
        return;
      }
      if (selectedToolCallGroup && noModifiers) {
        const expanded = state.expandedToolCallGroups[selectedToolCallGroup.id] === true;
        if (isEnterKey(evt) || keyName === "space" || keyName === "e") {
          setState("expandedToolCallGroups", selectedToolCallGroup.id, !expanded);
          consumeKeyboardEvent(evt);
          return;
        }
        if (isRightKey) {
          if (!expanded) setState("expandedToolCallGroups", selectedToolCallGroup.id, true);
          consumeKeyboardEvent(evt);
          return;
        }
        if (isLeftKey) {
          if (expanded) setState("expandedToolCallGroups", selectedToolCallGroup.id, false);
          consumeKeyboardEvent(evt);
          return;
        }
      }
      if (noModifiers && (isEnterKey(evt) || keyName === "space" || keyName === "e")) {
        updateExpanded(true);
        consumeKeyboardEvent(evt);
        return;
      }
      if (noModifiers && isRightKey) {
        updateExpanded(true);
        consumeKeyboardEvent(evt);
        return;
      }
      if (noModifiers && isLeftKey) {
        consumeKeyboardEvent(evt);
        return;
      }
      if (keyName === "escape") {
        resetDoublePressState();
        setTranscriptSelection(null);
        try {
          _textareaRef?.focus?.();
        } catch {}
        consumeKeyboardEvent(evt);
        return;
      }
      if (printableInput !== null) {
        consumeKeyboardEvent(evt);
        return;
      }
    }

    const currentSelectionMode = selectionMode();
    const pluginViewOpen =
      isOverlayVisible() &&
      (currentSelectionMode === SelectionMode.PLUGINS || currentSelectionMode === SelectionMode.PLUGIN_DETAILS);
    if (pluginViewOpen && !evt.ctrl && !evt.meta && keyName === "space") {
      toggleSelectedPlugin(contextValue);
      if (evt.preventDefault) evt.preventDefault();
      return;
    }
    if (
      pluginViewOpen &&
      currentSelectionMode === SelectionMode.PLUGIN_DETAILS &&
      !evt.ctrl &&
      !evt.meta &&
      (keyName === "backspace" || keyName === "delete" || isLeftKey)
    ) {
      openPluginsOverlay();
      if (evt.preventDefault) evt.preventDefault();
      return;
    }
    if (pluginViewOpen && printableInput !== null) {
      if (evt.preventDefault) evt.preventDefault();
      return;
    }
    if (
      isOverlayVisible() &&
      currentSelectionMode === SelectionMode.TREE &&
      !evt.ctrl &&
      !evt.meta &&
      (isLeftKey || isRightKey || keyName === "pageup" || keyName === "pagedown")
    ) {
      const direction = isLeftKey || keyName === "pageup" ? -1 : 1;
      setOverlayIndex((index) => nextConversationMessageIndex(overlayItems(), index, direction));
      consumeKeyboardEvent(evt);
      return;
    }

    const focusedPluginWidget = _pluginRunner?.slots.focusedKeyboardWidget() ?? null;
    const focusedWidgetWithoutKeyHandler =
      focusedPluginWidget && !focusedPluginWidget.widget.onKey ? focusedPluginWidget : null;
    if (
      _pluginRunner &&
      focusedPluginWidget &&
      focusedPluginWidget.widget.onKey &&
      focusedPluginWidgetHandlesKey(_pluginRunner, focusedPluginWidget, evt, keyName)
    )
      return;

    const promptText = getTextareaText();
    if (
      !pluginOverlayOpen() &&
      !pluginViewOpen &&
      !evt.ctrl &&
      !evt.meta &&
      (keyName === "?" || evt.sequence === "?") &&
      !pendingElicitationBlock(contextValue) &&
      !promptText.trim()
    ) {
      openNativeModal("shortcut-reference");
      if (evt.preventDefault) evt.preventDefault();
      return;
    }
    if (
      queueFocusIndex() !== null &&
      composerInputOwner() === "queue" &&
      !sidebarFocused() &&
      !threadSidebarExpanded() &&
      keyName === "tab" &&
      !evt.shift &&
      !evt.ctrl &&
      !evt.meta &&
      !hasOptionModifier(evt)
    ) {
      steerFocusedQueuedPrompt(_acpClient);
      consumeKeyboardEvent(evt);
      return;
    }

    const pluginKeybinding = pluginViewOpen
      ? undefined
      : _pluginRunner?.keybindings.match(
          evt,
          focusedWidgetWithoutKeyHandler ? { pluginId: focusedWidgetWithoutKeyHandler.plugin.id } : undefined,
        );
    if (pluginKeybinding) {
      if (focusedWidgetWithoutKeyHandler) consumeKeyboardEvent(evt);
      else if (evt.preventDefault) evt.preventDefault();
      void Promise.resolve(pluginKeybinding.binding.run()).catch((error: unknown) =>
        _pluginRunner?.recordError(pluginKeybinding.plugin, `Keybinding failed for ${pluginKeybinding.key}`, error),
      );
      return;
    }

    if (
      _pluginRunner &&
      focusedWidgetWithoutKeyHandler &&
      focusedPluginWidgetHandlesKey(_pluginRunner, focusedWidgetWithoutKeyHandler, evt, keyName)
    )
      return;

    if (pluginOverlayOpen()) {
      if (evt.preventDefault) evt.preventDefault();
      return;
    }

    if (printableInput !== null && isSoftComposerInputOwner(printableInputOwner)) {
      if (insertPromptTextForOwner(printableInputOwner, printableInput)) {
        evt.preventDefault?.();
        return;
      }
    }

    if (evt.ctrl && keyName === "d" && isOverlayVisible() && selectionMode() === SelectionMode.SESSION) {
      const selected = overlayItems()[overlayIndex()]?.value;
      if (!isAcpSessionInfo(selected) || !_acpClient) {
        if (evt.preventDefault) evt.preventDefault();
        return;
      }
      const now = Date.now();
      if (isCtrlDSecondPress(now)) {
        resetCtrlDState();
        void _acpClient
          .deleteSession(selected.sessionId)
          .then(async () => {
            const sessions = resumableSessions(
              await _acpClient.listSessions(),
              agentBehaviorProfile().sessionListPolicy,
            );
            const items = hierarchicalSessionSelectionItems(
              sessions,
              _acpClient.sessionId,
              nativeChildSessionRelations(contextValue.state.threads),
            );
            if (items.length === 0) {
              hideOverlay();
              clearSelectionAllItems();
              return;
            }
            showSelectionOverlay(
              items,
              SelectionMode.SESSION,
              RESUME_PICKER_LAYOUT,
              Math.min(overlayIndex(), items.length - 1),
            );
          })
          .catch((err: unknown) => {
            const message = errorMessage(err);
            showToast(message ? `Failed to delete session: ${message}` : "Failed to delete session", "error", 6000);
          });
        if (evt.preventDefault) evt.preventDefault();
        return;
      }
      armCtrlDHint(now, " again to delete session");
      if (evt.preventDefault) evt.preventDefault();
      return;
    }

    // Ctrl+C - clear input, interrupt agent, or exit (double-press)
    if (evt.ctrl && keyName === "c") {
      // If overlay is visible (e.g. /resume session listing), require double-press to close
      if (isOverlayVisible()) {
        if (settingsOverlayActive()) {
          hideOverlay();
          clearSelectionAllItems();
          hideStatusHint();
          if (_textareaRef) {
            try {
              _textareaRef.setText("");
            } catch {}
          }
          if (evt.preventDefault) evt.preventDefault();
          return;
        }
        if (isCtrlCSecondPress(Date.now())) {
          // Second press - close the overlay
          hideOverlay();
          clearSelectionAllItems();
          resetCtrlCState();
          if (_textareaRef) {
            try {
              _textareaRef.setText("");
            } catch {}
          }
          if (evt.preventDefault) evt.preventDefault();
          return;
        }
        // First press - show hint
        armCtrlCHint(Date.now(), " again to close");
        if (evt.preventDefault) evt.preventDefault();
        return;
      }

      if (threadSidebarExpanded()) {
        setThreadSidebarExpanded(false);
        setShowThreadSidebar(true);
        setSidebarFocused(true);
        resetCtrlCState();
        if (evt.preventDefault) evt.preventDefault();
        return;
      }
      if (sidebarFocused()) {
        setSidebarFocused(false);
        resetCtrlCState();
        if (evt.preventDefault) evt.preventDefault();
        return;
      }

      // If there's text in the input, clear it
      const currentText = _textareaRef?.plainText ?? "";
      if (currentText.trim()) {
        if (_textareaRef) {
          try {
            _textareaRef.clear();
          } catch {}
        }
        pasteStore.reset();
        resetCtrlCState();
        if (evt.preventDefault) evt.preventDefault();
        return;
      }

      // Interrupt a running ACP prompt before considering app exit. Preserve queued prompts.
      if (_acpClient && state.running) {
        void interruptAcpPrompt(contextValue, "fire-and-forget");
        if (evt.preventDefault) evt.preventDefault();
        return;
      }

      // Double-press to exit
      if (isCtrlCSecondPress(Date.now())) {
        // Second press - exit
        void shutdownAndExit(renderer);
        if (evt.preventDefault) evt.preventDefault();
        return;
      }
      // First press - show hint
      armCtrlCHint(Date.now(), " again to exit");
      if (evt.preventDefault) evt.preventDefault();
      return;
    }

    if (evt.ctrl && keyName === "g") {
      const nextExpanded = !threadSidebarExpanded();
      setThreadSidebarExpanded(nextExpanded);
      setShowThreadSidebar(true);
      setSidebarFocused(true);
      hideOverlay();
      setSidebarFocusedIndex(0);
      setThreadSidebarListOffset(0);
      if (evt.preventDefault) evt.preventDefault();
      return;
    }

    if (evt.ctrl && keyName === "b") {
      const visibleThreads = visibleSidebarThreads(state.threads, state.activeThreadId, {
        includeDefaultDrafts: threadSidebarExpanded(),
      });
      const { visibleThreadCount } = computeSidebarLayout({
        visibleThreadCount: visibleThreads.length,
        expanded: threadSidebarExpanded(),
        columns: terminalColumns(),
        rows: terminalRows(),
      });
      const activeIndex = visibleThreads.findIndex((thread) => thread.id === state.activeThreadId);
      const focusIndex = activeIndex >= 0 ? activeIndex : -2;
      if (!showThreadSidebar()) {
        setShowThreadSidebar(true);
        setSidebarFocused(true);
        hideOverlay();
        setSidebarFocusedIndex(-2);
        setThreadSidebarListOffset(0);
      } else if (!sidebarFocused()) {
        setSidebarFocused(true);
        hideOverlay();
        setSidebarFocusedIndex(focusIndex);
        setThreadSidebarListOffset((offset) => ensureSidebarIndexVisible(offset, focusIndex, visibleThreadCount));
      } else {
        setShowThreadSidebar(false);
        setSidebarFocused(false);
        setThreadSidebarExpanded(false);
      }
      if (evt.preventDefault) evt.preventDefault();
      return;
    }

    if (sidebarFocused()) {
      const visibleThreads = visibleSidebarThreads(state.threads, state.activeThreadId, {
        includeDefaultDrafts: threadSidebarExpanded(),
      });
      const { gridColumns, visibleThreadCount, focusOrder } = computeSidebarLayout({
        visibleThreadCount: visibleThreads.length,
        expanded: threadSidebarExpanded(),
        columns: terminalColumns(),
        rows: terminalRows(),
      });
      const ensureThreadVisible = (index: number) => {
        setThreadSidebarListOffset((offset) => ensureSidebarIndexVisible(offset, index, visibleThreadCount));
      };
      if (threadSidebarExpanded() && (isLeftKey || isRightKey)) {
        setSidebarFocusedIndex((index) => {
          const next = horizontalSidebarFocus(focusOrder, index, isLeftKey ? -1 : 1);
          ensureThreadVisible(next);
          return next;
        });
        if (evt.preventDefault) evt.preventDefault();
        return;
      }
      if (evt.name === "up") {
        setSidebarFocusedIndex((index) => {
          const next = verticalSidebarFocus(focusOrder, index, -1, threadSidebarExpanded() ? gridColumns : 1);
          ensureThreadVisible(next);
          return next;
        });
        if (evt.preventDefault) evt.preventDefault();
        return;
      }
      if (evt.name === "down") {
        setSidebarFocusedIndex((index) => {
          const next = verticalSidebarFocus(focusOrder, index, 1, threadSidebarExpanded() ? gridColumns : 1);
          ensureThreadVisible(next);
          return next;
        });
        if (evt.preventDefault) evt.preventDefault();
        return;
      }
      if (isEnterKey(evt)) {
        const focusComposerAfterSidebarAction = () => {
          setThreadSidebarExpanded(false);
          setShowThreadSidebar(true);
          setSidebarFocused(false);
          try {
            _textareaRef?.focus?.();
          } catch {}
        };
        const index = sidebarFocusedIndex();
        if (index === -2) {
          void createThread(contextValue, false)
            .then(focusComposerAfterSidebarAction)
            .catch((err) => showToast(`Failed to create thread: ${err}`, "error"));
        } else if (index === -1) {
          void createThread(contextValue, true)
            .then(focusComposerAfterSidebarAction)
            .catch((err) => showToast(`Failed to create worktree: ${err}`, "error"));
        } else if (index === -3) openExistingWorktreePicker(contextValue);
        else if (visibleThreads[index])
          void selectThread(contextValue, visibleThreads[index].id)
            .then(focusComposerAfterSidebarAction)
            .catch((err) => showToast(`Failed to switch thread: ${err}`, "error"));
        if (evt.preventDefault) evt.preventDefault();
        return;
      }
      if (evt.name === "delete" || evt.name === "del" || evt.name === "backspace") {
        const thread = visibleThreads[sidebarFocusedIndex()];
        if (thread)
          void archiveThread(contextValue, thread.id).catch((err) => {
            const message = errorMessage(err);
            showToast(message ? `Failed to archive thread: ${message}` : "Failed to archive thread", "error", 6000);
          });
        if (evt.preventDefault) evt.preventDefault();
        return;
      }
    }

    // Paste placeholder-aware keyboard handling
    if (_textareaRef && !isOverlayVisible() && queueFocusIndex() === null) {
      if (handlePasteKeyEvent(_textareaRef, pasteStore, evt, renderer, refreshCurrentPasteHighlights)) return;
    }

    if (
      vimEnabled() &&
      _textareaRef &&
      !isOverlayVisible() &&
      !pendingElicitationBlock(contextValue) &&
      !findPendingApprovalBlock(state.blocks) &&
      !fileChangesModalOpen() &&
      queueFocusIndex() === null
    ) {
      const editor = createTextareaVimEditor(_textareaRef);
      if (isEnterKey(evt) && !shouldVimHandleEnter(vimState())) {
        // Let Relay's normal submit path handle Enter when Vim has no pending command.
      } else {
        const result = handleVimKey(editor, vimState(), evt);
        if (result.handled) {
          setVimState(result.state);
          refreshCurrentPasteHighlights();
          refreshVimSelectionHighlight(_textareaRef, result.state, getColors());
          return;
        }
      }
    }

    // F2 / ctrl+x - open the prompt in an external editor ($EDITOR / $VISUAL / vi).
    // Available in any input mode.
    if (
      ((evt.name === "f2" && !evt.ctrl) || (evt.ctrl && keyName === "x")) &&
      !evt.meta &&
      !isOverlayVisible() &&
      !pendingElicitationBlock(contextValue) &&
      !findPendingApprovalBlock(state.blocks) &&
      !fileChangesModalOpen() &&
      queueFocusIndex() === null
    ) {
      void openPromptInExternalEditor();
      if (evt.preventDefault) evt.preventDefault();
      return;
    }

    // Escape - close overlay, cancel elicitation, or interrupt
    if (evt.name === "escape") {
      resetDoublePressState();
      const activeNativeModal = nativeModal();
      if (activeNativeModal && activeNativeModal !== "connection-error") {
        closeNativeModal(activeNativeModal);
        if (evt.preventDefault) evt.preventDefault();
        return;
      }

      const elicitationBlock = pendingElicitationBlock(contextValue);
      if (elicitationBlock) {
        cancelElicitation(contextValue, elicitationBlock);
        if (evt.preventDefault) evt.preventDefault();
        return;
      }
      if (fileChangesModalOpen()) {
        closeDiffOverlay();
        if (evt.preventDefault) evt.preventDefault();
        return;
      }
      if (sidebarFocused()) {
        setSidebarFocused(false);
        if (evt.preventDefault) evt.preventDefault();
        return;
      }
      if (isOverlayVisible()) {
        if (selectionMode() === SelectionMode.PLUGIN_DETAILS) {
          openPluginsOverlay();
          if (evt.preventDefault) evt.preventDefault();
          return;
        }
        if (settingsOverlayActive() && selectionMode() === SelectionMode.ACP_CONFIG_VALUE) {
          const selected = overlayItems()[overlayIndex()]?.value as AcpConfigOptionValueItem | undefined;
          openSettingsOverlay(selected ? { acpConfigOptionId: selected.option.id } : undefined);
          if (evt.preventDefault) evt.preventDefault();
          return;
        }
        if (settingsOverlayActive() && _activeSettingsValueSetting) {
          const parentSubmenu = _activeSettingsSubmenu;
          const selectedSetting = _activeSettingsValueSetting.key;
          if (parentSubmenu === "notifications") openNotificationSettingsOverlay(selectedSetting);
          else openSettingsOverlay(selectedSetting);
          if (evt.preventDefault) evt.preventDefault();
          return;
        }
        if (settingsOverlayActive() && _activeSettingsSubmenu) {
          openSettingsOverlay(_activeSettingsSubmenu);
          if (evt.preventDefault) evt.preventDefault();
          return;
        }
        const wasSelectionMode = selectionMode() !== null;
        hideOverlay();
        clearSelectionAllItems();
        if (wasSelectionMode) {
          setSelectionMode(null);
          // Clear filter text
          if (_textareaRef) {
            try {
              _textareaRef.setText("");
            } catch {}
          }
        }
        if (evt.preventDefault) evt.preventDefault();
        return;
      }
      if (cancelPendingQueueFocus()) {
        setQueueFocusIndex(null);
        consumeKeyboardEvent(evt);
        return;
      }
      if (queueFocusIndex() !== null) {
        exitQueueBrowse(contextValue);
        if (evt.preventDefault) evt.preventDefault();
        return;
      }
      if (editingQueueItem()) {
        restoreEditingQueuedPrompt(contextValue);
        if (evt.preventDefault) evt.preventDefault();
        return;
      }
      const restoredHistoryDraft = promptHistory.cancelBrowsing();
      if (restoredHistoryDraft && _textareaRef) {
        markInputUpdateSource("history", restoredHistoryDraft.text);
        try {
          _textareaRef.setText(restoredHistoryDraft.text);
        } catch {}
        restorePasteMappings(pasteStore, restoredHistoryDraft.pasteMappings);
        refreshCurrentPasteHighlights();
        if (evt.preventDefault) evt.preventDefault();
        return;
      }
      // Cancel running user bash command
      if (_userBashAbortController) {
        _userBashAbortController.abort();
        if (evt.preventDefault) evt.preventDefault();
        return;
      }
      // ACP mode cancel. Defer briefly so OpenTUI can recover split mouse
      // wheel escape sequences before Relay treats the leading ESC byte as an
      // intentional interrupt.
      if (_acpClient && state.running) {
        const activeThreadId = state.activeThreadId;
        const activePromptRunId = store.threadPromptRunIds.get(activeThreadId) ?? 0;
        scheduleAcpEscapeInterrupt({
          shouldInterrupt: () =>
            appInstanceId === activeAppInstanceId() &&
            acpClient() === _acpClient &&
            state.running &&
            state.activeThreadId === activeThreadId &&
            (store.threadPromptRunIds.get(activeThreadId) ?? 0) === activePromptRunId,
          interrupt: () => interruptAcpPrompt(contextValue, "fire-and-forget"),
        });
        if (evt.preventDefault) evt.preventDefault();
        return;
      }
      const ctrl = cancelController();
      if (ctrl) {
        ctrl.abort();
      }
    }

    const editingElicitation = pendingElicitationBlock(contextValue);
    const editingElicitationField = editingElicitation?.fields[editingElicitation.currentFieldIndex];
    const editingCustomElicitation =
      editingElicitation &&
      editingElicitationField &&
      isEditingCustomElicitationInput(editingElicitation, editingElicitationField);
    if (editingCustomElicitation && (evt.name === "up" || evt.name === "down")) {
      setElicitationOptionIndex(evt.name === "up" ? editingElicitationField.choices.length - 1 : 0);
      contextValue.updateBlock(editingElicitation.id, {
        editingCustomFieldKey: undefined,
      } as Partial<ElicitationBlock>);
      consumeKeyboardEvent(evt);
      return;
    }
    if (editingElicitationField?.type === "string" && editingCustomElicitation) return;

    if (isEnterKey(evt) && hasOptionModifier(evt) && !pendingElicitationBlock(contextValue)) {
      if (editingQueueItem() || queueFocusIndex() !== null) {
        showToast(editingQueueItem() ? "Save or cancel the queue edit first" : "Exit queue browsing first", "warning");
        consumeKeyboardEvent(evt);
        return;
      }
      const text = getTextareaText();
      if (text.trim()) {
        const prefixedText = contextValue.state.userBashMode ? `!${text}` : text;
        const trimmedText = prefixedText.trim();
        const pasteMappings = pasteStore.getPasteMappingsForText(trimmedText);
        const expanded = pasteStore.expandPasteMarkers(trimmedText);
        try {
          _textareaRef?.clear?.();
        } catch {
          try {
            _textareaRef?.editBuffer?.clear?.();
          } catch {}
        }
        pasteStore.reset();
        handleActiveTurnInput(
          {
            text: expanded,
            historyText: trimmedText,
            pasteMappings,
          },
          contextValue,
        );
      }
      if (evt.preventDefault) evt.preventDefault();
      return;
    }

    if (isEnterKey(evt) && evt.shift && editingQueueItem()) {
      if (_textareaRef?.newLine) {
        _textareaRef.newLine();
      } else {
        _textareaRef?.insertText?.("\n");
      }
      if (evt.preventDefault) evt.preventDefault();
      return;
    }

    if (isEnterKey(evt) && isOverlayVisible()) {
      selectOverlayItem(contextValue, true);
      if (evt.preventDefault) evt.preventDefault();
      return;
    }

    if (
      queueFocusIndex() === null &&
      editingQueueItem() === null &&
      nativeModal() === null &&
      !isOverlayVisible() &&
      !pendingElicitationBlock(contextValue) &&
      !findPendingApprovalBlock(state.blocks) &&
      queueNavigationAction(evt) === "next"
    ) {
      const firstTranscriptId = navigableTranscriptIds()[0];
      if (firstTranscriptId) {
        setTranscriptSelection(firstTranscriptId);
        consumeKeyboardEvent(evt);
        return;
      }
    }

    // Queue browsing and editing are separate states. Browsing never mutates prompt
    // text; editing must be explicitly saved or cancelled before another row can be used.
    if (
      !isOverlayVisible() &&
      !pendingElicitationBlock(contextValue) &&
      !findPendingApprovalBlock(state.blocks) &&
      state.pendingQueue.length + (editingQueueItem() ? 1 : 0) > 0
    ) {
      const focusedQueueIndex = queueFocusIndex();
      const editingQueue = editingQueueItem() !== null;
      const cursorRow = getTextareaCursorRow(_textareaRef);
      const lineCount = getTextareaLineCount(_textareaRef);
      const queueAction = queueNavigationAction(evt);
      const moveAction = queueMoveAction(evt);

      if (editingQueue) {
        if (
          isEnterKey(evt) &&
          !evt.shift &&
          !evt.ctrl &&
          !evt.meta &&
          !hasOptionModifier(evt) &&
          !getTextareaText().trim()
        ) {
          showToast(EMPTY_QUEUE_EDIT_MESSAGE, "warning");
          consumeKeyboardEvent(evt);
          return;
        }
        if (evt.ctrl && keyName === "d") {
          deleteEditingQueuedPrompt(contextValue);
          consumeKeyboardEvent(evt);
          return;
        }
        if (queueAction !== null || moveAction !== null || (evt.ctrl && isEnterKey(evt))) {
          showToast("Save or cancel the queue edit first", "warning");
          consumeKeyboardEvent(evt);
          return;
        }
        if (evt.name === "up") {
          if (cursorRow > 0) return;
          consumeKeyboardEvent(evt);
          return;
        }
        if (evt.name === "down") {
          if (cursorRow < lineCount - 1) return;
          consumeKeyboardEvent(evt);
          return;
        }
      } else {
        if (focusedQueueIndex !== null && evt.ctrl && keyName === "d") {
          cancelFocusedQueuedPrompt(contextValue);
          consumeKeyboardEvent(evt);
          return;
        }
        if (moveAction !== null && focusedQueueIndex !== null) {
          moveFocusedQueuedPrompt(moveAction === "up" ? -1 : 1, contextValue);
          consumeKeyboardEvent(evt);
          return;
        }
        const browseDirection =
          queueAction !== null
            ? queueAction === "previous"
              ? -1
              : 1
            : focusedQueueIndex !== null && (evt.name === "up" || evt.name === "down")
              ? evt.name === "up"
                ? -1
                : 1
              : null;
        if (browseDirection !== null) {
          if (queueAction === "previous" && focusedQueueIndex === 0) {
            const lastTranscriptId = navigableTranscriptIds().at(-1);
            if (lastTranscriptId) {
              exitQueueBrowse(contextValue);
              setTranscriptSelection(lastTranscriptId);
              consumeKeyboardEvent(evt);
              return;
            }
          }
          moveQueueFocus(browseDirection, contextValue);
          consumeKeyboardEvent(evt);
          return;
        }
        if (focusedQueueIndex !== null && evt.ctrl && isEnterKey(evt)) {
          sendFocusedQueuedPromptNow(contextValue);
          consumeKeyboardEvent(evt);
          return;
        }
        if (focusedQueueIndex !== null && isEnterKey(evt)) {
          editFocusedQueuedPrompt(contextValue);
          consumeKeyboardEvent(evt);
          return;
        }
        if (focusedQueueIndex !== null && (keyName === "delete" || keyName === "del" || keyName === "backspace")) {
          cancelFocusedQueuedPrompt(contextValue);
          consumeKeyboardEvent(evt);
          return;
        }
      }
    }

    if (
      state.pendingQueue.length === 0 &&
      editingQueueItem() === null &&
      nativeModal() === null &&
      !isOverlayVisible() &&
      !pendingElicitationBlock(contextValue) &&
      !findPendingApprovalBlock(state.blocks) &&
      queueNavigationAction(evt) === "previous"
    ) {
      const lastTranscriptId = navigableTranscriptIds().at(-1);
      if (lastTranscriptId) setTranscriptSelection(lastTranscriptId);
      consumeKeyboardEvent(evt);
      return;
    }

    // Tab - path completion or overlay navigation
    if (evt.name === "tab" && !evt.shift) {
      if (isOverlayVisible()) {
        if (_tabCompleting) {
          // Cycle through tab-completion candidates
          setOverlayIndex((idx) => (idx < overlayItems().length - 1 ? idx + 1 : 0));
        } else {
          // Slash / @ autocomplete: accept selected item
          selectOverlayItem(contextValue);
        }
      } else {
        // No overlay visible — attempt Tab path completion
        doTabPathCompletion(contextValue);
      }
      if (evt.preventDefault) evt.preventDefault();
      return;
    }

    // Ctrl+L - open links from the latest assistant message
    if (evt.ctrl && evt.name === "l") {
      setWelcomeDismissed(true);
      const contentBlocks = state.blocks.filter((block: ChatBlock) => block.type === "content");
      const lastContent = contentBlocks[contentBlocks.length - 1] as ChatBlock | undefined;
      if (lastContent && lastContent.type === "content") {
        const links = extractMarkdownLinks(lastContent.content);
        if (links.length === 1) {
          openUrl(links[0].url);
          showToast(`Opening ${truncateTextEnd(links[0].url, 60)}…`);
        } else if (links.length > 1) {
          showSelectionOverlay(linkSelectionItems(links), SelectionMode.LINK, undefined, 0, {
            onSelect: (item) => {
              const url = item.value as string;
              openUrl(url);
              showToast(`Opening ${truncateTextEnd(url, 60)}…`);
            },
          });
        } else {
          showToast("No links found in the last message", "info");
        }
      } else {
        showToast("No message with links", "info");
      }
      if (evt.preventDefault) evt.preventDefault();
      return;
    }

    // Ctrl+R - search prompt history
    if (evt.ctrl && keyName === "r" && !isOverlayVisible() && !pendingElicitationBlock(contextValue)) {
      openPromptHistorySearch();
      if (evt.preventDefault) evt.preventDefault();
      return;
    }

    // Ctrl+M / Ctrl+Shift+M - cycle session models forward/backward.
    if (evt.ctrl && keyName === "m") {
      setWelcomeDismissed(true);
      cycleSessionModelFromKeyboard(contextValue, evt.shift ? -1 : 1);
      if (evt.preventDefault) evt.preventDefault();
      return;
    }

    // Ctrl+T / Ctrl+Shift+T - cycle thinking levels forward/backward.
    if (evt.ctrl && keyName === "t") {
      setWelcomeDismissed(true);
      cycleSessionThinkingLevelFromKeyboard(contextValue, evt.shift ? -1 : 1);
      if (evt.preventDefault) evt.preventDefault();
      return;
    }

    // Shift+Tab - cycle session modes
    if (evt.name === "tab" && evt.shift) {
      setWelcomeDismissed(true);
      const modes = state.availableModes;
      if (modes.length > 0) {
        const currentIdx = modes.findIndex((mode) => mode.id === state.modeId);
        const nextMode = modes[((currentIdx >= 0 ? currentIdx : 0) + 1) % modes.length];
        if (nextMode) {
          setSessionModeFromKeyboard(nextMode, contextValue, (modeId) => setState("modeId", modeId)).catch((err) =>
            showToast(`Failed to set mode: ${err}`, "error"),
          );
          if (evt.preventDefault) evt.preventDefault();
          return;
        }
      }
    }

    const activeElicitationBlock = pendingElicitationBlock(contextValue);
    if (!isOverlayVisible() && activeElicitationBlock) {
      if (isLeftKey || isRightKey) {
        navigateElicitationField(contextValue, activeElicitationBlock, isLeftKey ? -1 : 1);
        if (evt.preventDefault) evt.preventDefault();
        return;
      }
      const field = activeElicitationBlock.fields[activeElicitationBlock.currentFieldIndex];
      if (field && field.choices.length > 0 && (evt.name === "up" || evt.name === "down")) {
        const optionCount = elicitationOptionCount(activeElicitationBlock, field);
        setElicitationOptionIndex((idx) => {
          const nextIndex =
            evt.name === "up" ? (idx > 0 ? idx - 1 : optionCount - 1) : idx < optionCount - 1 ? idx + 1 : 0;
          contextValue.updateBlock(activeElicitationBlock.id, {
            editingCustomFieldKey:
              activeElicitationBlock.allowCustomEnumInput && nextIndex === field.choices.length ? field.key : undefined,
          } as Partial<ElicitationBlock>);
          return nextIndex;
        });
        if (evt.preventDefault) evt.preventDefault();
        return;
      }
      if (isEnterKey(evt)) {
        selectElicitationChoice(contextValue, activeElicitationBlock);
        if (evt.preventDefault) evt.preventDefault();
        return;
      }
    }

    // Permission approval list accepts vertical navigation; left/right remain
    // supported for compatibility with the previous horizontal action row.
    if (!isOverlayVisible()) {
      const approvalBlock = findPendingApprovalBlock(state.blocks);
      if (approvalBlock && (evt.name === "left" || evt.name === "right" || evt.name === "up" || evt.name === "down")) {
        const optionCount = approvalOptionsForBlock(approvalBlock).length;
        if (optionCount === 0) {
          if (evt.preventDefault) evt.preventDefault();
          return;
        }
        setApprovalOptionIndex((idx) =>
          evt.name === "left" || evt.name === "up"
            ? idx > 0
              ? idx - 1
              : optionCount - 1
            : idx < optionCount - 1
              ? idx + 1
              : 0,
        );
        if (evt.preventDefault) evt.preventDefault();
        return;
      }
      if (approvalBlock && isEnterKey(evt)) {
        const options = approvalOptionsForBlock(approvalBlock);
        const selectedIndex = Math.min(approvalOptionIndex(), options.length - 1);
        const selected = options[selectedIndex];
        const response = selected ?? ApprovalResponse.DENY;
        const resolveApproval = approvalBlock.resolveApproval;
        if (isApprovalSelectionAllow(response)) {
          contextValue.removeBlock(approvalBlock.id);
        } else {
          updateBlock(approvalBlock.id, {
            status: "error",
            resolveApproval: undefined,
          } as Partial<ToolBlock>);
        }
        resolveApproval?.(response);
        setApprovalOptionIndex(0);
        if (evt.preventDefault) evt.preventDefault();
        return;
      }
    }

    // Up/Down arrow - overlay navigation, multi-line cursor movement, or prompt history
    if (evt.name === "up") {
      if (isOverlayVisible()) {
        if (selectionMode() !== SelectionMode.PLUGIN_DETAILS) {
          setOverlayIndex((idx) => (idx > 0 ? idx - 1 : overlayItems().length - 1));
        }
        if (evt.preventDefault) evt.preventDefault();
        return;
      }

      // If cursor is NOT on the first line, let the textarea handle it (move cursor up)
      const cursorRow = getTextareaCursorRow(_textareaRef);
      if (cursorRow > 0) {
        // Don't preventDefault — let the textarea's built-in cursor-up work
        return;
      }
      // Cursor is on line 0 — navigate prompt history, even while the agent is running.
      if (navigatePromptHistory(-1) && evt.preventDefault) evt.preventDefault();
      return;
    }
    if (evt.name === "down") {
      if (isOverlayVisible()) {
        if (selectionMode() !== SelectionMode.PLUGIN_DETAILS) {
          setOverlayIndex((idx) => (idx < overlayItems().length - 1 ? idx + 1 : 0));
        }
        if (evt.preventDefault) evt.preventDefault();
        return;
      }

      // If cursor is NOT on the last line, let the textarea handle it (move cursor down)
      const cursorRow = getTextareaCursorRow(_textareaRef);
      const lineCount = getTextareaLineCount(_textareaRef);
      if (cursorRow < lineCount - 1) {
        // Don't preventDefault — let the textarea's built-in cursor-down work
        return;
      }
      // Cursor is on the last line — navigate prompt history, even while the agent is running.
      if (navigatePromptHistory(1) && evt.preventDefault) evt.preventDefault();
      return;
    }
  };
}
