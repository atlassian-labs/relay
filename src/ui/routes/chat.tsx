import { createEffect, createMemo, createSignal, For, onCleanup, Show, type JSX } from "solid-js";
import { createTextAttributes, type MouseEvent, type ScrollBoxRenderable } from "@opentui/core";
import { AppContext } from "../state";
import type { AppStateContextValue } from "../context/app-state";
import { TerminalDimensionsProvider, useSharedTerminalDimensions } from "../context/terminal-dimensions";
import type { AgentProfile } from "../tool-renderers";
import type { ElicitationBlock, QueuedPrompt, SessionModeOption, SessionModelOption, ToolBlock } from "../state";
import type { PromptInput } from "../../core/prompt-submission";
import type { ThreadInfo } from "../../core/threads";
import { SelectionMode, type CompletionResult, type ListItem, type SlashCommand } from "../autocomplete";
import { QueueDisplay } from "../component/queue-display";
import { StatusLine } from "../component/status-line";
import { EditorFooter } from "../component/footer";
import { DiffOverlay, type DiffOverlayCommand, type DiffOverlayRequest } from "../component/diff-overlay";
import { TokenUsageModal } from "../component/token-usage-modal";
import { ShortcutReferenceModal } from "../component/shortcut-reference-modal";
import { TranscriptDetailModal } from "../component/transcript-detail-modal";
import { SubagentDetailModal } from "../component/subagent-detail-modal";
import { PluginsOverlay } from "../component/plugins-overlay";
import { PluginDialogModal } from "../component/plugin-dialog";
import { ModalSurface } from "../component/modal-frame";
import { ChatLog } from "../component/chat-log";
import { ChatBlockView } from "../component/blocks/chat-block";
import { FloatingList, type SlashPanelPosition } from "../component/floating-list";
import { ShortcutHints } from "../component/shortcut-hints";
import { Composer, type InputUpdateSource } from "../component/composer";
import { ElicitationPanel } from "../component/elicitation-panel";
import { ApprovalPanel } from "../component/approval-panel";
import { findPendingApprovalBlock } from "../app/approval-block";
import { pendingElicitationBlock } from "../app/elicitation";
import type { VimMode } from "../util/vim-engine";
import { Toast } from "../ui/toast";
import { ThreadSidebar } from "../component/thread-sidebar";
import type { ToastContextValue } from "../ui/toast";
import { ToastContext } from "../ui/toast";
import { getColors, getSyntaxStyle } from "../context/theme";
import type { VersionUpdateInfo } from "../../platform/version-check";
import type { PluginRunner, RelayCommandContext, RelayEditorSegmentContent, RelayPluginStatus } from "../../plugins";
import {
  normalizeRelayLines,
  type RelayLine,
  type RelayLineSegment,
  type RelayModalCorner,
  type RelayWidget,
} from "../../plugins";
import type { PluginDialogState } from "../app/plugin-dialogs";
import type { NativeModalId } from "../app/native-modal-controller";
import type { PluginSettingsItem } from "../util/plugins";
import type { RelayWidgetEntry } from "../../plugins/slots";
import { handleChatRootMouseScrollWithEscapeRecovery } from "../app/scroll-escape-recovery";
import { openUrl } from "../util/links";
import { handleRelayLineMouseAction } from "../util/relay-line-click";
import type { EditorChromeElementInput, EditorChromeElementResolver } from "../util/editor-chrome";
import { MODAL_BACKDROP_COLOR } from "../component/modal-backdrop";
import type { TranscriptRendererMode } from "../util/transcript-renderer-mode";
import type { TranscriptSelectionCoordinator } from "../util/transcript-selection";
import {
  blocksChatScroll,
  isComposerPromptFocused,
  isSuspendedComposerInputOwner,
  type ComposerInputOwner,
} from "../util/composer-input";

export interface ChatRouteProps {
  contextValue: AppStateContextValue;
  toastValue: ToastContextValue;
  fileChangesModalOpen: () => boolean;
  setFileChangesModalOpen: (updater: (value: boolean) => boolean) => void;
  diffOverlayCommand: () => DiffOverlayCommand | null;
  diffOverlayRequest: () => DiffOverlayRequest | null;
  nativeModal: () => NativeModalId | null;
  openNativeModal: (id: NativeModalId) => void;
  closeNativeModal: (id?: NativeModalId) => void;
  toggleNativeModal: (id: NativeModalId) => void;
  tips: () => readonly string[];
  welcomeDismissed: () => boolean;
  hideThinking: () => boolean;
  activeAgentProfile: () => AgentProfile;
  approvalOptionIndex: () => number;
  elicitationOptionIndex: () => number;
  setElicitationOptionIndex?: (index: number) => void;
  getSpinnerChar: () => string;
  renderer?: unknown;
  transcriptRendererMode?: TranscriptRendererMode;
  onTranscriptSelectionCoordinatorChange?: (coordinator: TranscriptSelectionCoordinator | null) => void;
  selectElicitationChoice: (app: AppStateContextValue, block: ElicitationBlock) => void;
  overlayItems: () => ListItem<unknown>[];
  overlayIndex: () => number;
  overlayLayout: () => {
    labelMinWidth: number;
    labelMaxWidth: number;
    descriptionMaxWidth: number;
    viewportReservedWidth: number;
    descriptionColumns?: readonly { maxWidth?: number; minWidth?: number; align?: "left" | "right" }[];
    descriptionColumnGap?: string;
  };
  maxOverlayVisible: number;
  slashPanelPosition: () => SlashPanelPosition;
  selectionMode: () => SelectionMode | null;
  filterOverlayItems: (query: string) => void;
  showOverlay: (items: ListItem<unknown>[]) => void;
  hideOverlay: () => void;
  isOverlayVisible: () => boolean;
  selectOverlayItem: (app: AppStateContextValue, submitSlashCompletion?: boolean) => void;
  getVisibleSlashCommands: (state: AppStateContextValue["state"] | null) => SlashCommand[];
  ensureSlashCommandMetadata?: () => Promise<boolean>;
  setActiveCompletion: (completion: CompletionResult | null) => void;
  setTabCompleting: (value: boolean) => void;
  consumeInputUpdateSource: (text: string) => InputUpdateSource | null;
  onPromptTextChanged: (source: InputUpdateSource | null, text: string) => void;
  setTextareaRef: (ref: unknown, previousRef?: unknown) => void;
  setCompletedTextSubmitter: (
    submitter: ((text: string) => void) | null,
    previousSubmitter?: (text: string) => void,
  ) => void;
  textareaRef: () => unknown;
  composerText: () => string;
  resetDoublePressState: () => void;
  currentSessionId: () => string | null;
  commandContext?: () => RelayCommandContext;
  queueFocusIndex?: () => number | null;
  editingQueueItem?: () => QueuedPrompt | null;
  queueMaxSize: number;
  vimStatus?: () => { mode: VimMode; pending: string } | null;
  pluginRunner?: () => PluginRunner | null;
  nativeStatusSegments?: () => readonly RelayPluginStatus[];
  pluginRevision?: () => number;
  /** Bumps on every config change so drawn blocks pick up display settings. */
  configRevision?: () => number;
  pluginWidgetRevision?: (placement: RelayWidget["placement"]) => number;
  pluginChromeRevision?: () => number;
  pluginDialog?: () => PluginDialogState | null;
  cancelPluginDialog?: () => void;
  composerInputOwner: () => ComposerInputOwner;
  handleSubmit: (input: PromptInput, app: AppStateContextValue) => void;
  threads: () => ThreadInfo[];
  activeThreadId: () => string;
  showSidebar: () => boolean;
  sidebarFocused: () => boolean;
  sidebarFocusedIndex: () => number;
  sidebarExpanded: () => boolean;
  sidebarWidth: () => number;
  sidebarListOffset: () => number;
  getThreadPreview: (threadId: string) => string;
  selectThread: (threadId: string) => void;
  createLocalThread: () => void;
  createWorktreeThread: () => void;
  createExistingWorktreeThread: () => void;
  archiveThread: (threadId: string) => void;
  onRootMouseDown: () => void;
  onRootMouseUp: () => void;
  versionUpdate?: () => VersionUpdateInfo | null;
}

export function ChatRoute(props: ChatRouteProps) {
  return (
    <TerminalDimensionsProvider>
      <ChatRouteContent route={props} />
    </TerminalDimensionsProvider>
  );
}

function ChatRouteContent(input: { route: ChatRouteProps }) {
  const props = input.route;
  const dims = useSharedTerminalDimensions();
  const hideFooterForOverlay = () => props.slashPanelPosition() === "bottom" && props.isOverlayVisible();
  const pluginWidgets = (placement: RelayWidget["placement"]) => {
    if (props.pluginWidgetRevision) props.pluginWidgetRevision(placement);
    else props.pluginRevision?.();
    return props.pluginRunner?.()?.slots.widgets(placement) ?? [];
  };
  const editorStatusSegments = () => {
    props.pluginChromeRevision?.();
    return [...(props.nativeStatusSegments?.() ?? []), ...(props.pluginRunner?.()?.slots.editorStatusSegments() ?? [])];
  };
  const pluginEditorStatusSegments = (): readonly RelayEditorSegmentContent[] => {
    props.pluginChromeRevision?.();
    return props.pluginRunner?.()?.slots.editorStatusSegmentContents({ colors: getColors() }) ?? [];
  };
  const pluginEditorFooterSegments = (): readonly RelayEditorSegmentContent[] => {
    props.pluginChromeRevision?.();
    return props.pluginRunner?.()?.slots.editorFooterSegmentContents({ colors: getColors() }) ?? [];
  };
  const editorChromeContext = (surface: "header" | "footer") => {
    const runner = props.pluginRunner?.();
    const state = props.contextValue.state;
    return {
      surface,
      width: dims().width,
      height: dims().height,
      colors: getColors(),
      editorText: props.composerText(),
      state: {
        cwd: state.cwd,
        gitBranch: state.gitBranch,
        worktreePath: state.worktreePath,
        worktreeBranch: state.worktreeBranch,
        providerName: state.providerName,
        modeId: state.modeId,
        modelId: state.modelId,
        reasoningLevel: state.thinkingLevel,
        connecting: state.connecting,
        running: state.running,
        elapsedSeconds: state.elapsedSeconds,
        statusText: state.spinnerLabel || state.statusText,
        queue: state.pendingQueue.map((item) => item.text),
        queueFocusIndex: props.queueFocusIndex?.() ?? null,
        tokenUsage: {
          inputTokens: state.totalUsage.input_tokens,
          outputTokens: state.totalUsage.output_tokens,
          cacheReadTokens: state.totalUsage.cache_read_tokens,
          cacheWriteTokens: state.totalUsage.cache_write_tokens,
          contextTokens: state.contextTokens,
          contextWindow: state.contextWindow,
        },
        fileChanges: {
          files: new Set(state.fileChanges.map((change) => change.path)).size,
          added: state.fileChanges.reduce((sum, change) => sum + change.added, 0),
          removed: state.fileChanges.reduce((sum, change) => sum + change.removed, 0),
        },
      },
      invalidate: () => runner?.invalidateChrome(),
    } as const;
  };
  const resolveEditorChromeElement: EditorChromeElementResolver = (input: EditorChromeElementInput) => {
    props.pluginChromeRevision?.();
    const runner = props.pluginRunner?.();
    return runner
      ? runner.slots.renderEditorChromeElement({ ...editorChromeContext(input.surface), ...input }, (plugin, error) =>
          runner.recordError(plugin, `Editor ${input.surface} element renderer failed`, error),
        )
      : input.line;
  };
  const pluginEditorHeaderReplacement = createMemo(() => {
    props.pluginChromeRevision?.();
    const runner = props.pluginRunner?.();
    const output =
      runner?.slots.renderEditorHeader(editorChromeContext("header"), (plugin, error) =>
        runner.recordError(plugin, "Editor header renderer failed", error),
      ) ?? null;
    return output === null ? null : normalizeRelayLines(output);
  });
  const pluginEditorFooterReplacement = createMemo(() => {
    props.pluginChromeRevision?.();
    const runner = props.pluginRunner?.();
    const output =
      runner?.slots.renderEditorFooter(editorChromeContext("footer"), (plugin, error) =>
        runner.recordError(plugin, "Editor footer renderer failed", error),
      ) ?? null;
    return output === null ? null : normalizeRelayLines(output);
  });
  const editorFooterHeight = () =>
    pluginEditorFooterReplacement()?.reduce((height, line) => height + relayLineHeight(line), 0) ?? 2;
  const activeElicitationBlock = (): ElicitationBlock | null => pendingElicitationBlock(props.contextValue);
  const activeApprovalBlock = (): ToolBlock | null => findPendingApprovalBlock(props.contextValue.state.blocks);
  const activeComposerPanel = (): ToolBlock | ElicitationBlock | null =>
    activeApprovalBlock() ?? activeElicitationBlock();

  let chatScrollBox: ScrollBoxRenderable | null = null;
  const setChatScrollBox = (scrollBox: ScrollBoxRenderable | null) => {
    chatScrollBox = scrollBox;
  };
  const chatScrollBlocked = () => blocksChatScroll(props.composerInputOwner());
  const handleTranscriptSelect = () => {
    if (props.isOverlayVisible()) props.hideOverlay();
  };
  const handleRootMouseScroll = (event: MouseEvent) => {
    handleChatRootMouseScrollWithEscapeRecovery(chatScrollBox, event, {
      blocked: chatScrollBlocked,
      localScrollOwners: () => [props.textareaRef()],
    });
  };
  const renderPrompt = (variant: "composer" | "queue-inline" = "composer") => (
    <Composer
      variant={variant}
      initialText={props.composerText}
      selectionMode={props.selectionMode}
      filterOverlayItems={props.filterOverlayItems}
      showOverlay={props.showOverlay}
      hideOverlay={props.hideOverlay}
      isOverlayVisible={props.isOverlayVisible}
      selectOverlayItem={props.selectOverlayItem}
      getVisibleSlashCommands={props.getVisibleSlashCommands}
      ensureSlashCommandMetadata={props.ensureSlashCommandMetadata}
      setActiveCompletion={props.setActiveCompletion}
      setTabCompleting={props.setTabCompleting}
      consumeInputUpdateSource={props.consumeInputUpdateSource}
      onPromptTextChanged={props.onPromptTextChanged}
      setTextareaRef={props.setTextareaRef}
      setCompletedTextSubmitter={props.setCompletedTextSubmitter}
      resetDoublePressState={props.resetDoublePressState}
      currentSessionId={props.currentSessionId}
      commandContext={props.commandContext}
      focused={() => isComposerPromptFocused(props.composerInputOwner())}
      inputSuspended={() => isSuspendedComposerInputOwner(props.composerInputOwner())}
      vimStatus={props.vimStatus}
      handleSubmit={props.handleSubmit}
      pluginRunner={props.pluginRunner}
      pluginRevision={props.pluginRevision}
    />
  );

  return (
    <AppContext.Provider value={props.contextValue}>
      <ToastContext.Context.Provider value={props.toastValue}>
        <box
          flexDirection="column"
          width={dims().width}
          height={dims().height}
          minHeight={0}
          backgroundColor={getColors().bg}
          onMouseDown={() => props.onRootMouseDown()}
          onMouseUp={() => props.onRootMouseUp()}
          onMouseScroll={handleRootMouseScroll}
        >
          <box flexDirection="row" flexGrow={1} flexShrink={1} width="100%" backgroundColor={getColors().bg}>
            <Show when={props.showSidebar()}>
              <ThreadSidebar
                threads={props.threads}
                activeThreadId={props.activeThreadId}
                focused={props.sidebarFocused}
                focusedIndex={props.sidebarFocusedIndex}
                expanded={props.sidebarExpanded}
                width={props.sidebarWidth}
                listOffset={props.sidebarListOffset}
                spinnerChar={props.getSpinnerChar}
                getPreview={props.getThreadPreview}
                onSelect={props.selectThread}
                onCreateLocal={props.createLocalThread}
                onCreateWorktree={props.createWorktreeThread}
                onCreateExistingWorktree={props.createExistingWorktreeThread}
                onArchive={props.archiveThread}
                pluginWidgets={() => pluginWidgets("sidebar")}
              />
            </Show>
            <Show when={!props.sidebarExpanded()}>
              <box flexDirection="column" flexGrow={1} flexShrink={1} backgroundColor={getColors().bg}>
                <PluginInlineWidgets widgets={() => pluginWidgets("appHeader")} placement="appHeader" height={1} />
                <ChatLog
                  welcomeDismissed={props.welcomeDismissed}
                  versionUpdate={props.versionUpdate}
                  welcomeWidgets={() => pluginWidgets("welcome")}
                  welcomeAddonWidgets={() => pluginWidgets("welcomeAddon")}
                  onConnectionErrorModalOpenChange={(open) =>
                    open ? props.openNativeModal("connection-error") : props.closeNativeModal("connection-error")
                  }
                  onScrollBoxRef={setChatScrollBox}
                  availableWidth={() => dims().width}
                  rendererMode={props.transcriptRendererMode}
                  renderer={props.renderer}
                  layoutRevision={() =>
                    `${props.activeAgentProfile()}:${props.hideThinking()}:${props.pluginRevision?.() ?? 0}`
                  }
                  onSelectionCoordinatorChange={props.onTranscriptSelectionCoordinatorChange}
                  onTranscriptSelect={handleTranscriptSelect}
                  renderBlock={(block, prevBlock) => (
                    <ChatBlockView
                      block={block}
                      prevBlock={prevBlock}
                      activeProfile={props.activeAgentProfile()}
                      hideThinking={props.hideThinking}
                      approvalOptionIndex={props.approvalOptionIndex}
                      elicitationOptionIndex={props.elicitationOptionIndex}
                      getSpinnerChar={props.getSpinnerChar}
                      pluginRunner={props.pluginRunner}
                      pluginRevision={props.pluginRevision}
                      configRevision={props.configRevision}
                      renderer={props.renderer}
                      selectThread={props.selectThread}
                      onTranscriptSelect={handleTranscriptSelect}
                      selectElicitationChoice={props.selectElicitationChoice}
                    />
                  )}
                />
                <Show
                  when={activeComposerPanel()}
                  fallback={
                    <>
                      <EditorHeader
                        widgets={() => pluginWidgets("editorHeader")}
                        queueFocusIndex={props.queueFocusIndex}
                        editingQueueItem={props.editingQueueItem}
                        composerText={props.composerText}
                        queueMaxSize={props.queueMaxSize}
                        spinnerChar={props.getSpinnerChar}
                        vimStatus={props.vimStatus}
                        pluginStatusSegments={editorStatusSegments}
                        pluginStatusLineSegments={pluginEditorStatusSegments}
                        replacement={pluginEditorHeaderReplacement}
                        resolveElement={resolveEditorChromeElement}
                      />
                      <For each={pluginWidgets("aboveEditor")}>
                        {(entry) => (
                          <box paddingLeft={1} paddingRight={1} flexDirection="column">
                            <For
                              each={normalizeRelayLines(
                                entry.widget.render({
                                  placement: entry.widget.placement,
                                  width: Math.max(1, dims().width - 2),
                                  height: 8,
                                  focused: entry.focused,
                                  colors: getColors(),
                                }),
                              )}
                            >
                              {(line) => (
                                <box
                                  height={relayLineHeight(line)}
                                  onMouseDown={(event) => openRelayLineHref(line, event)}
                                >
                                  <RelayLineText line={line} fallbackFg={getColors().fg} />
                                </box>
                              )}
                            </For>
                          </box>
                        )}
                      </For>
                      <Show when={props.editingQueueItem?.()} fallback={renderPrompt()}>
                        {renderPrompt("queue-inline")}
                      </Show>
                      <For each={pluginWidgets("belowEditor")}>
                        {(entry) => (
                          <box paddingLeft={1} paddingRight={1} flexDirection="column">
                            <For
                              each={normalizeRelayLines(
                                entry.widget.render({
                                  placement: entry.widget.placement,
                                  width: Math.max(1, dims().width - 2),
                                  height: 8,
                                  focused: entry.focused,
                                  colors: getColors(),
                                  editorText: props.composerText(),
                                }),
                              )}
                            >
                              {(line) => (
                                <box
                                  height={relayLineHeight(line)}
                                  onMouseDown={(event) => openRelayLineHref(line, event)}
                                >
                                  <RelayLineText line={line} fallbackFg={getColors().fg} />
                                </box>
                              )}
                            </For>
                          </box>
                        )}
                      </For>
                    </>
                  }
                >
                  {(block) =>
                    block().type === "tool" ? (
                      <ApprovalPanel block={block() as ToolBlock} optionIndex={props.approvalOptionIndex} />
                    ) : (
                      <ElicitationPanel
                        block={block() as ElicitationBlock}
                        optionIndex={props.elicitationOptionIndex}
                        setOptionIndex={props.setElicitationOptionIndex}
                      />
                    )
                  }
                </Show>
              </box>
            </Show>
          </box>
          <FloatingList
            visible={() =>
              props.isOverlayVisible() &&
              props.selectionMode() !== SelectionMode.PLUGINS &&
              props.selectionMode() !== SelectionMode.PLUGIN_DETAILS
            }
            items={props.overlayItems}
            selectedIndex={props.overlayIndex}
            layout={props.overlayLayout}
            maxVisible={props.maxOverlayVisible}
            footerHints={() =>
              props.selectionMode() === SelectionMode.SESSION
                ? [
                    ["↑/↓", "navigate"],
                    ["enter", "resume"],
                    ["ctrl+d", "delete"],
                    ["esc", "close"],
                  ]
                : props.selectionMode() === SelectionMode.TREE
                  ? [
                      ["↑/↓", "navigate"],
                      ["←/→", "jump messages"],
                      ["enter/esc", "close"],
                    ]
                  : [
                      ["↑/↓", "navigate"],
                      ["enter", "select"],
                      ["esc", "close"],
                    ]
            }
            panelPosition={props.slashPanelPosition()}
            viewportLeft={() => (props.showSidebar() ? props.sidebarWidth() : 0)}
            viewportWidth={() =>
              props.showSidebar() ? Math.max(1, dims().width - props.sidebarWidth()) : dims().width
            }
          />
          <PluginsOverlay
            visible={() =>
              props.isOverlayVisible() &&
              (props.selectionMode() === SelectionMode.PLUGINS ||
                props.selectionMode() === SelectionMode.PLUGIN_DETAILS)
            }
            items={() => props.overlayItems() as ListItem<PluginSettingsItem>[]}
            selectedIndex={props.overlayIndex}
            detailsOpen={() => props.selectionMode() === SelectionMode.PLUGIN_DETAILS}
          />
          {!hideFooterForOverlay() && !activeComposerPanel() && (
            <box
              flexDirection="row"
              width="100%"
              height={editorFooterHeight()}
              flexShrink={0}
              backgroundColor={getColors().bg}
            >
              <Show when={props.showSidebar()}>
                <box
                  width={props.sidebarWidth()}
                  height={editorFooterHeight()}
                  flexDirection="column"
                  flexShrink={0}
                  borderStyle="single"
                  border={["right"] as never}
                  borderColor={getColors().border}
                  paddingLeft={1}
                >
                  <box height={1} />
                  <box height={1}>
                    <text fg={getColors().textMuted} wrapMode="none">
                      <ShortcutHints
                        hints={
                          props.sidebarExpanded()
                            ? [["ctrl+g", "compact"]]
                            : [
                                ["ctrl+b", "focus"],
                                ["ctrl+g", "agents"],
                              ]
                        }
                      />
                    </text>
                  </box>
                </box>
              </Show>
              <Show when={!props.sidebarExpanded()}>
                <box flexGrow={1} flexShrink={1}>
                  <Show
                    when={pluginEditorFooterReplacement() === null}
                    fallback={<PluginEditorChromeLines lines={() => pluginEditorFooterReplacement() ?? []} />}
                  >
                    <EditorFooter
                      onToggleTokenUsage={() => props.toggleNativeModal("token-usage")}
                      pluginFooterSegments={pluginEditorFooterSegments}
                      resolveElement={resolveEditorChromeElement}
                    />
                  </Show>
                </box>
              </Show>
            </box>
          )}
          <PluginModalWidgets widgets={() => pluginWidgets("modal")} />
          <PluginOverlayWidgets widgets={() => pluginWidgets("overlay")} />
          <DiffOverlay
            open={props.fileChangesModalOpen}
            onClose={() => props.setFileChangesModalOpen(() => false)}
            command={props.diffOverlayCommand}
            request={props.diffOverlayRequest}
          />
          <TokenUsageModal
            open={() => props.nativeModal() === "token-usage"}
            onClose={() => props.closeNativeModal("token-usage")}
          />
          <ShortcutReferenceModal
            open={() => props.nativeModal() === "shortcut-reference"}
            onClose={() => props.closeNativeModal("shortcut-reference")}
            tips={props.tips}
          />
          <TranscriptDetailModal
            activeProfile={props.activeAgentProfile}
            open={() => props.contextValue.state.transcriptDetailBlockId !== null}
            onClose={() => props.contextValue.setState("transcriptDetailBlockId", null)}
          />
          <SubagentDetailModal
            open={() => props.contextValue.state.selectedSubagentToolCallId !== null}
            onClose={() => props.contextValue.setState("selectedSubagentToolCallId", null)}
            renderBlock={(block, prevBlock) => (
              <ChatBlockView
                block={block}
                prevBlock={prevBlock}
                activeProfile={props.activeAgentProfile()}
                hideThinking={props.hideThinking}
                approvalOptionIndex={props.approvalOptionIndex}
                elicitationOptionIndex={props.elicitationOptionIndex}
                getSpinnerChar={props.getSpinnerChar}
                pluginRunner={props.pluginRunner}
                pluginRevision={props.pluginRevision}
                configRevision={props.configRevision}
                renderer={props.renderer}
                selectThread={props.selectThread}
                selectElicitationChoice={props.selectElicitationChoice}
              />
            )}
          />
          <PluginDialogModal
            dialog={() => props.pluginDialog?.() ?? null}
            onCancel={() => props.cancelPluginDialog?.()}
          />
          <Toast colors={getColors()} />
        </box>
      </ToastContext.Context.Provider>
    </AppContext.Provider>
  );
}

function EditorHeader(props: {
  widgets: () => readonly RelayWidgetEntry[];
  queueFocusIndex?: () => number | null;
  editingQueueItem?: () => QueuedPrompt | null;
  composerText: () => string;
  queueMaxSize: number;
  spinnerChar: () => string;
  vimStatus?: () => { mode: VimMode; pending: string } | null;
  pluginStatusSegments?: () => readonly RelayPluginStatus[];
  pluginStatusLineSegments?: () => readonly RelayEditorSegmentContent[];
  replacement: () => readonly RelayLine[] | null;
  resolveElement: EditorChromeElementResolver;
}) {
  return (
    <box flexDirection="column" flexShrink={0} width="100%">
      <Show
        when={props.replacement() === null}
        fallback={<PluginEditorChromeLines lines={() => props.replacement() ?? []} />}
      >
        <PluginInlineWidgets
          widgets={props.widgets}
          placement="editorHeader"
          height={8}
          horizontalPadding={0}
          topSpacing={1}
        />
        <QueueDisplay
          focusedIndex={props.queueFocusIndex}
          editingItem={props.editingQueueItem}
          editorText={props.composerText}
          maxSize={props.queueMaxSize}
          resolveElement={props.resolveElement}
        />
        <StatusLine
          spinnerChar={props.spinnerChar}
          composerText={props.composerText}
          vimStatus={props.vimStatus}
          pluginStatusSegments={props.pluginStatusSegments}
          pluginStatusLineSegments={props.pluginStatusLineSegments}
          resolveElement={props.resolveElement}
        />
      </Show>
    </box>
  );
}

function PluginEditorChromeLines(props: { lines: () => readonly RelayLine[] }) {
  return (
    <box width="100%" flexDirection="column" flexShrink={0}>
      <For each={props.lines()}>
        {(line) => (
          <box height={relayLineHeight(line)} onMouseDown={(event) => openRelayLineHref(line, event)}>
            <RelayLineText line={line} fallbackFg={getColors().fg} />
          </box>
        )}
      </For>
    </box>
  );
}

function PluginInlineWidgets(props: {
  widgets: () => readonly RelayWidgetEntry[];
  placement: RelayWidget["placement"];
  height: number;
  editorText?: () => string;
  horizontalPadding?: number;
  topSpacing?: number;
}) {
  const dims = useSharedTerminalDimensions();
  const [frame, setFrame] = createSignal(0);

  createEffect(() => {
    const intervals = props
      .widgets()
      .map((entry) => entry.widget.intervalMs)
      .filter((value): value is number => typeof value === "number" && value > 0);
    if (intervals.length === 0) return;
    // effect-shape-allow: Inline plugin widget animation timer is scoped to Solid cleanup.
    const handle = setInterval(() => setFrame((value) => value + 1), Math.min(...intervals));
    onCleanup(() => clearInterval(handle));
  });

  const horizontalPadding = () => Math.max(0, props.horizontalPadding ?? 1);
  const topSpacing = () => Math.max(0, props.topSpacing ?? 0);
  const contentWidth = () => Math.max(1, dims().width - horizontalPadding() * 2);
  const contentHeight = (entry: RelayWidgetEntry) => Math.max(1, entry.widget.height ?? props.height);
  const contentLines = (entry: RelayWidgetEntry) => {
    frame();
    return normalizeRelayLines(
      entry.widget.render({
        placement: props.placement,
        width: contentWidth(),
        height: contentHeight(entry),
        focused: entry.focused,
        colors: getColors(),
        editorText: props.editorText?.(),
      }),
    );
  };

  return (
    <>
      <Show when={props.widgets().length > 0 && topSpacing() > 0}>
        <box height={topSpacing()} flexShrink={0} />
      </Show>
      <For each={props.widgets()}>
        {(entry) => (
          <box
            width="100%"
            paddingLeft={horizontalPadding()}
            paddingRight={horizontalPadding()}
            flexDirection="column"
            flexShrink={0}
          >
            <For each={contentLines(entry)}>
              {(line) => (
                <box height={relayLineHeight(line)} onMouseDown={(event) => openRelayLineHref(line, event)}>
                  <RelayLineText line={line} fallbackFg={getColors().fg} />
                </box>
              )}
            </For>
          </box>
        )}
      </For>
    </>
  );
}

function modalCornerLine(entry: RelayWidgetEntry, corner: RelayModalCorner): RelayLine | null {
  const value = entry.widget.modalCorners?.[corner];
  if (!value) return null;
  return typeof value === "string" ? { text: value } : value;
}

function RelayLineText(props: {
  line: RelayLine;
  fallbackFg?: string;
  segmentFallbackFg?: (segment: RelayLineSegment) => string | undefined;
}) {
  const attributes = () =>
    createTextAttributes({
      bold: props.line.bold === true,
      underline: props.line.underline === true,
      strikethrough: props.line.strikethrough === true,
    });
  const segmentFg = (segment: RelayLineSegment) =>
    segment.fg ?? props.line.fg ?? props.segmentFallbackFg?.(segment) ?? props.fallbackFg;
  const markdownHeight = () => Math.max(1, props.line.markdownHeight ?? 1);
  const markdownWidth = () => (props.line.markdownWidth ? Math.max(1, props.line.markdownWidth) : "100%");
  const markdownBlock = (content: string) => (
    <box width={markdownWidth()} height={markdownHeight()} flexDirection="column" backgroundColor={props.line.bg}>
      <markdown
        syntaxStyle={getSyntaxStyle()}
        streaming={false}
        content={content}
        conceal={true}
        fg={props.line.fg ?? props.fallbackFg}
      />
    </box>
  );
  return (
    <Show
      when={props.line.markdown}
      fallback={
        <text fg={props.line.fg ?? props.fallbackFg} bg={props.line.bg} attributes={attributes()} wrapMode="none">
          <Show when={props.line.segments} fallback={props.line.text}>
            {(segments) => (
              <For each={segments()}>
                {(segment) => (
                  <span
                    style={
                      {
                        fg: segmentFg(segment),
                        bg: segment.bg ?? props.line.bg,
                        bold: segment.bold === true || props.line.bold === true,
                        underline: segment.underline === true || props.line.underline === true,
                        strikethrough: segment.strikethrough === true || props.line.strikethrough === true,
                      } as never
                    }
                  >
                    {segment.text}
                  </span>
                )}
              </For>
            )}
          </Show>
        </text>
      }
    >
      {(markdown) => (
        <box width="100%" height={markdownHeight()} flexDirection="column" backgroundColor={props.line.bg}>
          <Show
            when={props.line.markdownGutterLines}
            fallback={
              <box marginLeft={props.line.markdownMarginLeft ?? 0} height={markdownHeight()} flexDirection="column">
                {markdownBlock(markdown())}
              </box>
            }
          >
            {(gutterLines) => (
              <box marginLeft={props.line.markdownMarginLeft ?? 0} height={markdownHeight()} flexDirection="row">
                <box width={props.line.markdownGutterWidth ?? 0} height={markdownHeight()} flexDirection="column">
                  <For each={gutterLines().slice(0, markdownHeight())}>
                    {(line) => (
                      <box height={1}>
                        <RelayLineText line={line} fallbackFg={props.fallbackFg} />
                      </box>
                    )}
                  </For>
                </box>
                {markdownBlock(markdown())}
              </box>
            )}
          </Show>
        </box>
      )}
    </Show>
  );
}

function relayLineHeight(line: RelayLine): number {
  return line.markdown ? Math.max(1, line.markdownHeight ?? 1) : 1;
}

function openRelayLineHref(line: RelayLine, event: unknown): void {
  handleRelayLineMouseAction(line, event, openUrl);
}

function visibleRelayLines(lines: readonly RelayLine[], maxHeight: number): readonly RelayLine[] {
  let remaining = maxHeight;
  const visible: RelayLine[] = [];
  for (const line of lines) {
    if (remaining <= 0) break;
    const height = relayLineHeight(line);
    if (line.markdown && height > remaining) {
      visible.push({ ...line, markdownHeight: remaining });
      break;
    }
    visible.push(line);
    remaining -= height;
  }
  return visible;
}

function PluginModalWidgets(props: { widgets: () => readonly RelayWidgetEntry[] }) {
  const dims = useSharedTerminalDimensions();
  const colors = getColors();
  const [frame, setFrame] = createSignal(0);

  createEffect(() => {
    const intervals = props
      .widgets()
      .map((entry) => entry.widget.intervalMs)
      .filter((value): value is number => typeof value === "number" && value > 0);
    if (intervals.length === 0) return;
    // effect-shape-allow: UI modal animation timer is scoped to Solid cleanup.
    const handle = setInterval(() => setFrame((value) => value + 1), Math.min(...intervals));
    onCleanup(() => clearInterval(handle));
  });
  const modalWidth = (entry: RelayWidgetEntry) =>
    Math.min(Math.max(20, entry.widget.width ?? 64), Math.max(1, dims().width - 4));
  const modalBodyWidth = (entry: RelayWidgetEntry) => Math.max(1, modalWidth(entry) - 4);
  const contentLines = (entry: RelayWidgetEntry) => {
    frame();
    return normalizeRelayLines(
      entry.widget.render({
        placement: "modal",
        width: modalBodyWidth(entry),
        height: Math.max(1, entry.widget.height ?? dims().height - 4),
        focused: entry.focused,
        colors,
      }),
    );
  };
  const hasHeader = (entry: RelayWidgetEntry) =>
    Boolean(entry.widget.title || modalCornerLine(entry, "topLeft") || modalCornerLine(entry, "topRight"));
  const hasFooter = (entry: RelayWidgetEntry) =>
    Boolean(modalCornerLine(entry, "bottomLeft") || modalCornerLine(entry, "bottomRight"));
  const modalHeight = (entry: RelayWidgetEntry) =>
    Math.min(
      Math.max(3, entry.widget.height ?? contentLines(entry).length + (hasHeader(entry) ? 3 : 2)),
      Math.max(1, dims().height - 4),
    );
  const modalTop = (entry: RelayWidgetEntry) => Math.max(0, Math.floor((dims().height - modalHeight(entry)) / 2));
  const maxBodyLines = (entry: RelayWidgetEntry) =>
    Math.max(0, modalHeight(entry) - (hasHeader(entry) ? 3 : 2) - (hasFooter(entry) ? 1 : 0));
  const visibleContentLines = (entry: RelayWidgetEntry) => visibleRelayLines(contentLines(entry), maxBodyLines(entry));
  const headerLeftLine = (entry: RelayWidgetEntry): RelayLine | null =>
    modalCornerLine(entry, "topLeft") ?? (entry.widget.title ? { text: entry.widget.title, bold: true } : null);
  const closeTopModal = () => props.widgets().at(-1)?.widget.onClose?.();

  return (
    <Show when={props.widgets().length > 0}>
      <box
        position="absolute"
        zIndex={2599}
        top={0}
        left={0}
        width={dims().width}
        height={dims().height}
        backgroundColor={MODAL_BACKDROP_COLOR}
        onMouseDown={closeTopModal}
      />
      <For each={props.widgets()}>
        {(entry) => (
          <ModalSurface
            width={() => modalWidth(entry)}
            height={() => modalHeight(entry)}
            top={() => modalTop(entry)}
            zIndex={2600}
          >
            <Show when={hasHeader(entry)}>
              <box height={1} width="100%" flexDirection="row" justifyContent="space-between">
                <Show when={headerLeftLine(entry)} fallback={<text wrapMode="none" />}>
                  {(line) => <RelayLineText line={line()} fallbackFg={colors.fg} />}
                </Show>
                <Show when={modalCornerLine(entry, "topRight")}>
                  {(line) => <RelayLineText line={line()} fallbackFg={colors.fg} />}
                </Show>
              </box>
            </Show>
            <For each={visibleContentLines(entry)}>
              {(line) => (
                <box height={relayLineHeight(line)} onMouseDown={(event) => openRelayLineHref(line, event)}>
                  <RelayLineText line={line} fallbackFg={colors.fg} />
                </box>
              )}
            </For>
            <Show when={hasFooter(entry)}>
              <box flexGrow={1} />
              <box height={1} width="100%" flexDirection="row" justifyContent="space-between">
                <Show when={modalCornerLine(entry, "bottomLeft")} fallback={<text wrapMode="none" />}>
                  {(line) => <RelayLineText line={line()} fallbackFg={colors.textSubtle} />}
                </Show>
                <Show when={modalCornerLine(entry, "bottomRight")}>
                  {(line) => <RelayLineText line={line()} fallbackFg={colors.textSubtle} />}
                </Show>
              </box>
            </Show>
          </ModalSurface>
        )}
      </For>
    </Show>
  );
}

function PluginOverlayWidgets(props: { widgets: () => readonly RelayWidgetEntry[] }) {
  const dims = useSharedTerminalDimensions();
  const colors = getColors();
  const [frame, setFrame] = createSignal(0);

  createEffect(() => {
    const intervals = props
      .widgets()
      .map((entry) => entry.widget.intervalMs)
      .filter((value): value is number => typeof value === "number" && value > 0);
    if (intervals.length === 0) return;
    // effect-shape-allow: UI overlay animation timer is scoped to Solid cleanup.
    const handle = setInterval(() => setFrame((value) => value + 1), Math.min(...intervals));
    onCleanup(() => clearInterval(handle));
  });

  const contentWidth = () => Math.max(1, dims().width - 2);
  const hasHeader = (entry: RelayWidgetEntry) =>
    Boolean(entry.widget.title || modalCornerLine(entry, "topLeft") || modalCornerLine(entry, "topRight"));
  const hasFooter = (entry: RelayWidgetEntry) =>
    Boolean(modalCornerLine(entry, "bottomLeft") || modalCornerLine(entry, "bottomRight"));
  const headerHeight = (entry: RelayWidgetEntry) => (hasHeader(entry) ? 1 : 0);
  const footerHeight = (entry: RelayWidgetEntry) => (hasFooter(entry) ? 1 : 0);
  const bodyHeight = (entry: RelayWidgetEntry) =>
    Math.max(0, dims().height - headerHeight(entry) - footerHeight(entry));
  const contentLines = (entry: RelayWidgetEntry) => {
    frame();
    return normalizeRelayLines(
      entry.widget.render({
        placement: "overlay",
        width: contentWidth(),
        height: bodyHeight(entry),
        focused: entry.focused,
        colors,
      }),
    );
  };
  const headerLeftLine = (entry: RelayWidgetEntry): RelayLine | null =>
    modalCornerLine(entry, "topLeft") ?? (entry.widget.title ? { text: entry.widget.title, bold: true } : null);
  const visibleContentLines = (entry: RelayWidgetEntry) => visibleRelayLines(contentLines(entry), bodyHeight(entry));
  const footerSegmentFallbackFg = (segment: RelayLineSegment) => (segment.bold ? colors.textLabel : colors.textSubtle);

  return (
    <For each={props.widgets()}>
      {(entry) => (
        <box
          position="absolute"
          zIndex={2400}
          top={0}
          left={0}
          width={dims().width}
          height={dims().height}
          flexDirection="column"
          backgroundColor={colors.bg}
          paddingLeft={1}
          paddingRight={1}
          onMouseDown={(event: { stopPropagation?: () => void }) => event.stopPropagation?.()}
        >
          <Show when={hasHeader(entry)}>
            <box height={1} width="100%" flexDirection="row" justifyContent="space-between">
              <Show when={headerLeftLine(entry)} fallback={<text wrapMode="none" />}>
                {(line) => <RelayLineText line={line()} fallbackFg={colors.fg} />}
              </Show>
              <Show when={modalCornerLine(entry, "topRight")}>
                {(line) => <RelayLineText line={line()} fallbackFg={colors.fg} />}
              </Show>
            </box>
          </Show>
          <For each={visibleContentLines(entry)}>
            {(line) => (
              <box height={relayLineHeight(line)} onMouseDown={(event) => openRelayLineHref(line, event)}>
                <RelayLineText line={line} fallbackFg={colors.fg} />
              </box>
            )}
          </For>
          <Show when={hasFooter(entry)}>
            <box flexGrow={1} />
            <box height={1} width="100%" flexDirection="row" justifyContent="space-between">
              <Show when={modalCornerLine(entry, "bottomLeft")} fallback={<text wrapMode="none" />}>
                {(line) => (
                  <RelayLineText
                    line={line()}
                    fallbackFg={colors.textSubtle}
                    segmentFallbackFg={footerSegmentFallbackFg}
                  />
                )}
              </Show>
              <Show when={modalCornerLine(entry, "bottomRight")}>
                {(line) => (
                  <RelayLineText
                    line={line()}
                    fallbackFg={colors.textSubtle}
                    segmentFallbackFg={footerSegmentFallbackFg}
                  />
                )}
              </Show>
            </box>
          </Show>
        </box>
      )}
    </For>
  );
}
