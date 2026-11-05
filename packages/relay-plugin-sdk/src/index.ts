export interface Disposable {
  dispose(): void;
}

export interface RelayPluginInfo {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly description?: string;
  readonly author?: string;
}

export interface RelayThreadEventContext {
  readonly threadId: string;
  readonly sessionId: string | null;
  readonly cwd: string;
}

export type RelayTurnEndOutcome = "complete" | "error" | "cancelled";

export type RelayTurnLifecycleEvent =
  | (RelayThreadEventContext & {
      readonly type: "turn:start";
      readonly text: string;
      readonly source: "user" | "plugin" | "queue";
    })
  | (RelayThreadEventContext & {
      readonly type: "turn:end";
      readonly outcome: RelayTurnEndOutcome;
      readonly error?: string;
    });

export type RelayMessageBlockType = "content" | "thinking";
export type RelayMessageRole = "assistant";

export type RelayMessageLifecycleEventBase = RelayThreadEventContext & {
  readonly blockId: string;
  readonly role: RelayMessageRole;
  readonly blockType: RelayMessageBlockType;
  readonly content: string;
  readonly delta?: string;
  readonly raw?: unknown;
};

export type RelayMessageLifecycleEvent =
  | (RelayMessageLifecycleEventBase & { readonly type: "message:start" })
  | (RelayMessageLifecycleEventBase & { readonly type: "message:update" })
  | (RelayMessageLifecycleEventBase & { readonly type: "message:end" });

export type RelayToolLifecycleStatus = "pending" | "running" | "success" | "error" | "approval";

export type RelayToolLifecycleEventBase = RelayThreadEventContext & {
  readonly blockId: string;
  readonly toolName: string;
  readonly toolCallId: string;
  readonly status: RelayToolLifecycleStatus;
  readonly input: unknown;
  readonly output: unknown;
  readonly raw?: unknown;
};

export type RelayToolLifecycleEvent =
  | (RelayToolLifecycleEventBase & { readonly type: "tool:start" })
  | (RelayToolLifecycleEventBase & { readonly type: "tool:update" })
  | (RelayToolLifecycleEventBase & { readonly type: "tool:end" });

export type RelayThreadChangeAction = "created" | "selected" | "archived" | "updated";

export type RelayThreadChangeEvent = RelayThreadEventContext & {
  readonly type: "thread:change";
  readonly action: RelayThreadChangeAction;
  readonly previousThreadId?: string | null;
};

export type RelayQueueChangeEvent = RelayThreadEventContext & {
  readonly type: "queue:change";
  readonly length: number;
};

export type RelayThinkingChangeEvent = RelayThreadEventContext & {
  readonly type: "thinking:change";
  readonly thinkingLevel: string;
  readonly previousThinkingLevel?: string;
};

export type RelayLifecycleEvent =
  | { readonly type: "relay:start"; readonly cwd: string }
  | { readonly type: "relay:shutdown"; readonly reason: "quit" | "reload" | "error" }
  | { readonly type: "ui:mount" }
  | { readonly type: "ui:unmount" }
  | { readonly type: "config:change"; readonly key?: string }
  | { readonly type: "theme:change"; readonly themeId: string };

export type RelayAcpActivityKind = "streaming" | "reasoning" | "tool" | "active";

export type RelayAcpEvent =
  | { readonly type: "agent:process:start"; readonly command: string; readonly args: readonly string[] }
  | {
      readonly type: "agent:process:exit";
      readonly code?: number;
      readonly signal?: string;
      readonly expected?: boolean;
      readonly reason?: string;
      readonly transport?: string;
      readonly connected?: boolean;
      readonly message?: string;
      readonly threadId?: string;
    }
  | { readonly type: "agent:connect:start"; readonly agentName: string }
  | { readonly type: "agent:connect:ready"; readonly agentName: string; readonly capabilities: unknown }
  | { readonly type: "agent:connect:error"; readonly agentName: string; readonly error: string }
  | {
      readonly type: "session:new";
      readonly sessionId: string | null;
      readonly cwd: string;
      readonly threadId?: string;
    }
  | { readonly type: "session:load"; readonly sessionId: string; readonly cwd: string; readonly threadId?: string }
  | { readonly type: "session:update"; readonly update: unknown }
  | {
      readonly type: "prompt:beforeSubmit";
      readonly text: string;
      readonly source: "user" | "plugin" | "queue";
      readonly threadId?: string;
      readonly sessionId?: string | null;
      readonly cwd?: string;
    }
  | (RelayThreadEventContext & { readonly type: "prompt:submitted"; readonly text: string })
  | (RelayThreadEventContext & { readonly type: "prompt:complete" })
  | (Partial<RelayThreadEventContext> & { readonly type: "prompt:error"; readonly error: string })
  | { readonly type: "agent:activity"; readonly kind: RelayAcpActivityKind; readonly label: string }
  | (Partial<RelayThreadEventContext> & {
      readonly type: "permission:request";
      readonly toolName: string;
      readonly toolCallId: string;
      readonly preview?: string;
      readonly options?: readonly RelayPermissionRequestOption[];
    })
  | (Partial<RelayThreadEventContext> & {
      readonly type: "permission:resolved";
      readonly toolName: string;
      readonly toolCallId: string;
      readonly outcome: "approved" | "denied";
    })
  | (Partial<RelayThreadEventContext> & {
      readonly type: "elicitation:request";
      readonly message: string;
      readonly mode: RelayElicitationMode;
      readonly schema?: RelayElicitationSchema;
      readonly url?: string;
      readonly elicitationId?: string;
      readonly toolCallId?: string;
    })
  | (Partial<RelayThreadEventContext> & {
      readonly type: "elicitation:resolved";
      readonly elicitationId?: string;
      readonly toolCallId?: string;
      readonly outcome: "accepted" | "declined" | "cancelled";
    })
  | { readonly type: "model:change"; readonly modelId: string }
  | { readonly type: "mode:change"; readonly modeId: string };

export type AgentLifecycleEvent = {
  readonly type: "agent:lifecycle";
  readonly agent: string;
  readonly name: string;
  readonly phase?: string;
  readonly payload: unknown;
  readonly raw: unknown;
};

export type RelayPluginErrorEvent = {
  readonly type: "plugin:error";
  readonly plugin: RelayPluginInfo;
  readonly error: string;
};

export type RelayPluginEvent =
  | RelayLifecycleEvent
  | RelayAcpEvent
  | RelayTurnLifecycleEvent
  | RelayMessageLifecycleEvent
  | RelayToolLifecycleEvent
  | RelayThreadChangeEvent
  | RelayQueueChangeEvent
  | RelayThinkingChangeEvent
  | AgentLifecycleEvent
  | RelayPluginErrorEvent;

export type RelayEventHandler<E extends RelayPluginEvent["type"]> = (
  event: Extract<RelayPluginEvent, { readonly type: E }>,
) => void | Promise<void>;

export type RelayPluginToastVariant = "info" | "warning" | "error";

export interface RelayPluginStatus {
  readonly text: string;
  readonly spinner?: boolean;
}

export type RelayPluginStatusValue = string | RelayPluginStatus | (() => string | RelayPluginStatus);

export interface RelayToolBgColorConfig {
  readonly pending: string;
  readonly success: string;
  readonly error: string;
}

export interface RelayBadgeColorConfig {
  readonly bg: string;
  readonly label: string;
}

export interface RelayColorsConfig {
  readonly bg: string;
  readonly fg: string;
  /** Very low contrast text for gutters, separators, and least-important hints. */
  readonly textSubtle: string;
  /** Muted readable text for metadata, thinking text, and tool output. */
  readonly textMuted: string;
  /** Label/detail text for headings, tool details, and structural labels. */
  readonly textLabel: string;
  /** @deprecated Use textSubtle. */
  readonly faint: string;
  /** @deprecated Use textMuted. */
  readonly dim: string;
  /** @deprecated Use textLabel. */
  readonly muted: string;
  readonly title: string;
  readonly spinner: string;
  readonly accent: string;
  readonly info: string;
  readonly markdownHeading: string;
  readonly markdownCode: string;
  readonly selected: string;
  readonly error: string;
  readonly notice: string;
  readonly diffAdded: string;
  readonly diffRemoved: string;
  readonly toolBg: RelayToolBgColorConfig;
  readonly badge: RelayBadgeColorConfig;
  readonly running: string;
  readonly success: string;
  readonly failed: string;
  readonly panel: string;
  readonly panelAlt: string;
  readonly panelUser: string;
  readonly border: string;
  readonly thinking: string;
}

export interface RelayThemeConfig {
  readonly id: string;
  readonly colors: RelayColorsConfig;
}

export interface RelayLineSegment {
  readonly text: string;
  readonly fg?: string;
  readonly bg?: string;
  readonly bold?: boolean;
  readonly underline?: boolean;
  readonly strikethrough?: boolean;
  readonly href?: string;
  readonly ctrlHref?: string;
  readonly onClick?: () => void | Promise<void>;
}

export interface RelayLine {
  readonly text: string;
  readonly fg?: string;
  readonly bg?: string;
  readonly bold?: boolean;
  readonly underline?: boolean;
  readonly strikethrough?: boolean;
  readonly href?: string;
  readonly ctrlHref?: string;
  readonly onClick?: () => void | Promise<void>;
  readonly segments?: readonly RelayLineSegment[];
  readonly markdown?: string;
  readonly markdownMarginLeft?: number;
  readonly markdownWidth?: number;
  readonly markdownHeight?: number;
  readonly markdownGutterWidth?: number;
  readonly markdownGutterLines?: readonly RelayLine[];
}

export type RelayCardBorderStyle = "single" | "rounded";

export type RelayRenderable =
  | { readonly kind: "lines"; readonly lines: readonly RelayLine[] }
  | {
      readonly kind: "card";
      readonly title?: string | RelayLine;
      readonly lines: readonly RelayLine[];
      readonly border?: RelayCardBorderStyle;
    };

export type RelayModalCorner = "topLeft" | "topRight" | "bottomLeft" | "bottomRight";
export type RelayModalCornerContent = string | RelayLine;
export type RelayModalCorners = Partial<Record<RelayModalCorner, RelayModalCornerContent>>;

export type RelayWidgetPlacement =
  | "appHeader"
  | "editorHeader"
  | "aboveEditor"
  | "belowEditor"
  | "sidebar"
  | "modal"
  | "overlay"
  | "welcome"
  | "welcomeAddon";

export interface RelayWidgetRenderContext {
  readonly placement: RelayWidgetPlacement;
  readonly width: number;
  readonly height: number;
  readonly focused: boolean;
  readonly colors?: RelayColorsConfig;
  readonly editorText?: string;
}

export interface RelayWidgetKeyEvent {
  readonly name: string;
  readonly sequence?: string;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
  readonly option: boolean;
  readonly printable: string | null;
}

export type RelayWidgetKeyHandlerResult = void | boolean;
export type RelayWidgetKeyHandler = (
  event: RelayWidgetKeyEvent,
) => RelayWidgetKeyHandlerResult | Promise<RelayWidgetKeyHandlerResult>;

export interface RelayWidgetHandle extends Disposable {
  readonly focused: boolean;
  readonly hidden: boolean;
  focus(): void;
  unfocus(): void;
  setHidden(hidden: boolean): void;
  invalidate(): void;
}

export interface RelayWidget {
  readonly placement: RelayWidgetPlacement;
  readonly priority?: number;
  readonly width?: number;
  readonly height?: number;
  readonly title?: string;
  readonly intervalMs?: number;
  readonly modalCorners?: RelayModalCorners;
  readonly onClose?: () => void;
  readonly onKey?: RelayWidgetKeyHandler;
  render(ctx?: RelayWidgetRenderContext): readonly RelayLine[];
}

export type RelayOverlayWidget = Omit<RelayWidget, "placement"> & { readonly placement?: "overlay" };

export type RelayEditorSegmentContent = string | RelayLine;

export interface RelayEditorSegmentRenderContext {
  readonly colors?: RelayColorsConfig;
}

export interface RelayEditorStatusSegment {
  readonly priority?: number;
  render(ctx?: RelayEditorSegmentRenderContext): RelayEditorSegmentContent;
}

export type RelayEditorFooterSegment = RelayEditorStatusSegment;

export type RelayEditorChromeSurface = "header" | "footer";

export type RelayEditorChromeElement =
  | "editorHeader.queueTitle"
  | "editorHeader.queueHint"
  | "editorHeader.queueIndicator"
  | "editorHeader.queueItemLabel"
  | "editorHeader.queueItemPreview"
  | "editorHeader.statusSpinner"
  | "editorHeader.vimMode"
  | "editorHeader.statusLabel"
  | "editorHeader.pluginStatus"
  | "editorHeader.interruptHint"
  | "editorHeader.tipMarker"
  | "editorHeader.tipLabel"
  | "editorHeader.tipText"
  | "editorHeader.rightHintKey"
  | "editorHeader.rightHintLabel"
  | "editorHeader.rightStatus"
  | "editorFooter.cwd"
  | "editorFooter.branch"
  | "editorFooter.worktree"
  | "editorFooter.provider"
  | "editorFooter.mode"
  | "editorFooter.tokenUsage"
  | "editorFooter.goalStatus"
  | "editorFooter.fileChanges"
  | "editorFooter.fileAdded"
  | "editorFooter.fileRemoved"
  | "editorFooter.pluginStatus"
  | "editorFooter.model"
  | "editorFooter.reasoning";

export interface RelayEditorChromeTokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly contextTokens: number | null;
  readonly contextWindow: number | null;
}

export interface RelayEditorChromeFileChanges {
  readonly files: number;
  readonly added: number;
  readonly removed: number;
}

export interface RelayEditorChromeState {
  readonly cwd: string;
  readonly gitBranch: string | null;
  readonly worktreePath: string | null;
  readonly worktreeBranch: string | null;
  readonly providerName: string;
  readonly modeId: string;
  readonly modelId: string;
  readonly reasoningLevel: string;
  readonly connecting: boolean;
  readonly running: boolean;
  readonly elapsedSeconds: number;
  readonly statusText: string;
  readonly queue: readonly string[];
  readonly queueFocusIndex: number | null;
  readonly tokenUsage: RelayEditorChromeTokenUsage;
  readonly fileChanges: RelayEditorChromeFileChanges;
}

export interface RelayEditorChromeRenderContext {
  readonly surface: RelayEditorChromeSurface;
  readonly width: number;
  readonly height: number;
  readonly colors: RelayColorsConfig;
  readonly editorText: string;
  readonly state: RelayEditorChromeState;
  /** Request a repaint after renderer-owned state changes. */
  invalidate(): void;
}

export interface RelayEditorChromeElementRenderContext extends RelayEditorChromeRenderContext {
  readonly element: RelayEditorChromeElement;
  /** The current element after earlier modifiers have run. */
  readonly line: RelayLine;
  /** Present for repeated elements such as queued prompts. */
  readonly index?: number;
  /** Whether the element represents the active or selected value. */
  readonly active?: boolean;
}

export interface RelayEditorChromeElementRenderer {
  /** Omit to receive every built-in editor header and footer element. */
  readonly elements?: readonly RelayEditorChromeElement[];
  /** Return null to preserve the element unchanged. Return an empty line to hide it. */
  render(ctx: RelayEditorChromeElementRenderContext): RelayLine | null;
}

export interface RelayEditorHeaderRenderer {
  /** Return null to use Relay's built-in editor header. Return an empty array to hide it. */
  render(ctx: RelayEditorChromeRenderContext): readonly RelayLine[] | null;
}

export interface RelayEditorFooterRenderer {
  /** Return null to use Relay's built-in editor footer. Return an empty array to hide it. */
  render(ctx: RelayEditorChromeRenderContext): readonly RelayLine[] | null;
}

export interface RelayToolDisplayContext {
  readonly toolName: string;
  readonly toolCallId: string;
  readonly status: string;
  readonly input: unknown;
  readonly output: unknown;
}

export interface RelayToolDisplayPolicy {
  readonly showDiff?: boolean;
  readonly showResultBody?: boolean;
  readonly collapsedByDefault?: boolean;
  readonly canToggle?: boolean;
  readonly header?: string | ((ctx: RelayToolDisplayContext) => string);
  readonly previewLines?: number;
}

export interface RelayToolRendererContext extends RelayToolDisplayContext {
  readonly blockId: string;
  readonly threadId: string | null;
  readonly sessionId: string | null;
  readonly display: string;
  readonly details?: string;
  readonly cwd: string;
  readonly isPartial: boolean;
  readonly expanded: boolean;
  readonly colors: RelayColorsConfig;
  invalidate(): void;
}

export interface RelayToolRendererOutput {
  readonly call?: RelayRenderable;
  readonly result?: RelayRenderable;
  readonly canToggle?: boolean;
}

export interface RelayMessageRendererContext {
  readonly blockId?: string;
  readonly blockType: string;
  readonly content: string;
  readonly data?: unknown;
  readonly delivery?: string;
  readonly threadId?: string | null;
  readonly sessionId?: string | null;
  readonly cwd: string;
  readonly colors: RelayColorsConfig;
  readonly previousBlockType?: string;
  readonly startsAgentTurn: boolean;
}

export interface RelayMessageRendererOutput {
  readonly header?: string | RelayLine;
  readonly lines?: readonly RelayLine[];
  readonly marginTop?: number;
  readonly paddingLeft?: number;
  readonly paddingRight?: number;
  readonly paddingTop?: number;
  readonly paddingBottom?: number;
  readonly backgroundColor?: string;
  readonly onClick?: () => void | Promise<void>;
}

export interface RelayToolRenderer {
  readonly toolNames?: readonly string[];
  readonly canToggle?: boolean;
  renderCall?(ctx: RelayToolRendererContext): RelayRenderable | null;
  renderResult?(ctx: RelayToolRendererContext): RelayRenderable | null;
}

export interface RelayMessageRenderer {
  readonly blockTypes?: readonly string[];
  render(ctx: RelayMessageRendererContext): RelayMessageRendererOutput | null;
}

export interface RelayEditorOptions {
  readonly placeholder: string;
  readonly minHeight: number;
  readonly maxHeight: number;
  readonly paddingX: number;
  readonly composerFrame: "legacy" | "bordered";
  readonly borderStyle: "rounded" | "single" | "double";
  readonly borderColor: string | ((ctx: RelayEditorBorderColorContext) => string);
  readonly borderRenderer: RelayEditorBorderRenderer;
  readonly suppressSlashAutocomplete: boolean | (() => boolean);
}

export interface RelayEditorTheme {
  readonly borderColor?: string;
  readonly textColor?: string;
  readonly cursorColor?: string;
}

export type RelayEditorSurface = "prompt";

export interface RelayEditorSurfaceState {
  readonly surface: RelayEditorSurface;
  readonly focused: boolean;
  readonly disabled: boolean;
  readonly userBashMode: boolean;
  readonly modeId: string;
  readonly running: boolean;
  readonly hasSession: boolean;
}

export interface RelayEditorBorderColorContext {
  readonly colors: RelayColorsConfig;
  readonly state: RelayEditorSurfaceState;
}

export interface RelayEditorBorderRenderContext extends RelayEditorBorderColorContext {
  readonly frame: number;
  readonly baseBorderColor: string;
  readonly width: number;
  readonly height: number;
  drawText(text: string, x: number, y: number, color: string): void;
}

export interface RelayEditorBorderRenderer {
  active?: (ctx: RelayEditorBorderColorContext) => boolean;
  readonly intervalMs?: number | ((ctx: RelayEditorBorderColorContext) => number);
  render(ctx: RelayEditorBorderRenderContext): void;
}

export interface RelayAutocompleteItem {
  readonly label: string;
  readonly description?: string;
  readonly insertText?: string;
  readonly onSelect?: () => void | Promise<void>;
}

export interface RelayAutocompleteContext {
  readonly text: string;
  readonly lines: readonly string[];
  readonly cursorOffset: number;
  readonly cursorLine: number;
  readonly cursorColumn: number;
  readonly cwd: string;
  /** Active token under the cursor. Triggered providers receive the token including the trigger. */
  readonly token: string;
  readonly tokenStart: number;
}

export interface RelayAutocompleteResult {
  readonly items: readonly RelayAutocompleteItem[];
  readonly tokenStart?: number;
  readonly tokenEnd?: number;
  readonly query?: string;
}

export interface RelayAutocompleteApplyContext {
  readonly text: string;
  readonly item: RelayAutocompleteItem;
  readonly cwd: string;
  readonly cursorOffset: number;
  readonly token: string;
  readonly tokenStart: number;
  readonly tokenEnd: number;
}

export type RelayAutocompleteApplyResult =
  | void
  | null
  | string
  | { readonly text: string; readonly cursorOffset?: number };

export type RelayAutocompleteProviderResult = RelayAutocompleteResult | readonly RelayAutocompleteItem[] | null;

export interface RelayAutocompleteProvider {
  readonly trigger?: string;
  provide(ctx: RelayAutocompleteContext): RelayAutocompleteProviderResult | Promise<RelayAutocompleteProviderResult>;
  applyCompletion?(ctx: RelayAutocompleteApplyContext): RelayAutocompleteApplyResult;
}

export interface RelayCommandContext {
  readonly cwd: string;
  readonly sessionId: string | null;
  readonly threadId: string | null;
  readonly userMessageCount: number;
  readonly running: boolean;
  waitForIdle(): Promise<void>;
  toast(message: string, variant?: RelayPluginToastVariant, durationMs?: number): void;
}

export type RelayCommandDiagnosticKind = "duplicate" | "native-conflict" | "agent-conflict";

export interface RelayCommandDiagnostic {
  readonly kind: RelayCommandDiagnosticKind;
  readonly message: string;
}

export interface RelayRegisteredCommand {
  readonly plugin: RelayPluginInfo;
  readonly name: string;
  readonly invocationName: string;
  readonly description?: string;
  readonly argumentPlaceholder?: string;
  readonly diagnostics?: readonly RelayCommandDiagnostic[];
}

export interface RelayCommand {
  readonly description?: string;
  readonly argumentPlaceholder?: string;
  getArgumentCompletions?(
    argsPrefix: string,
    ctx: RelayCommandContext,
  ): readonly RelayAutocompleteItem[] | Promise<readonly RelayAutocompleteItem[]> | null;
  run(args: string, ctx: RelayCommandContext): Promise<void> | void;
}

export interface RelayKeybinding {
  readonly description?: string;
  readonly enabled?: () => boolean;
  run(): Promise<void> | void;
}

export interface RelayPluginTipOptions {
  readonly enabled?: () => boolean;
}

export type RelayPromptBeforeSubmitResult =
  | void
  | { readonly text?: string; readonly handled?: boolean }
  | string
  | false;

export type RelayPromptBeforeSubmitHandler = (ctx: {
  readonly text: string;
  readonly source: "user" | "plugin" | "queue";
}) => RelayPromptBeforeSubmitResult | Promise<RelayPromptBeforeSubmitResult>;

export type RelaySystemReminderResult = void | null | string | readonly string[];

export type RelaySystemReminderContext = RelayThreadEventContext & {
  readonly text: string;
  readonly source: "user" | "plugin" | "queue";
};

export type RelaySystemReminderProvider =
  | string
  | readonly string[]
  | ((ctx: RelaySystemReminderContext) => RelaySystemReminderResult | Promise<RelaySystemReminderResult>);

export interface RelayUserBashEvent {
  readonly command: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly sendToAgent: boolean;
  readonly excludeFromContext: boolean;
}

export type RelayUserBashBeforeRunResult = void | null | {
  readonly command?: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
};

export interface RelayUserBashRunEvent extends RelayUserBashEvent {
  readonly signal: AbortSignal;
}

export interface RelayUserBashResult {
  readonly output: string;
  readonly exitCode?: number;
  readonly cancelled?: boolean;
}

export type RelayUserBashBeforeRunHandler = (
  event: RelayUserBashEvent,
) => RelayUserBashBeforeRunResult | Promise<RelayUserBashBeforeRunResult>;

export type RelayUserBashRunHandler = (
  event: RelayUserBashRunEvent,
) => RelayUserBashResult | null | undefined | Promise<RelayUserBashResult | null | undefined>;

export interface RelayPermissionRequestOption {
  readonly optionId: string;
  readonly name: string;
  readonly kind?: string;
}

export interface RelayPermissionRequest extends RelayThreadEventContext {
  readonly toolName: string;
  readonly toolCallId: string;
  readonly preview?: string;
  readonly options: readonly RelayPermissionRequestOption[];
  readonly raw?: unknown;
}

export type RelayPermissionRequestHandlerResult =
  | void
  | null
  | { readonly action: "continue" }
  | { readonly action: "deny"; readonly reason?: string }
  | { readonly action: "approve"; readonly optionId?: string }
  | { readonly action: "select"; readonly optionId: string };

export type RelayPermissionRequestHandler = (
  request: RelayPermissionRequest,
) => RelayPermissionRequestHandlerResult | Promise<RelayPermissionRequestHandlerResult>;

export type RelayElicitationMode = "form" | "url";

export interface RelayElicitationSchema {
  readonly type: "object";
  readonly title?: string;
  readonly properties?: Record<string, unknown>;
  readonly required?: readonly string[];
}

export interface RelayElicitationChoice {
  readonly value: string;
  readonly title: string;
  readonly description?: string;
}

export interface RelayElicitationField {
  readonly key: string;
  readonly type?: string;
  readonly title: string;
  readonly description?: string;
  readonly required?: boolean;
  readonly choices: readonly RelayElicitationChoice[];
}

export type RelayElicitationResponse =
  | { readonly action: "accept"; readonly content: Record<string, unknown> }
  | { readonly action: "decline" }
  | { readonly action: "cancel" };

export interface RelayElicitationRequest extends RelayThreadEventContext {
  readonly mode: RelayElicitationMode;
  readonly message: string;
  readonly schema?: RelayElicitationSchema;
  readonly url?: string;
  readonly elicitationId?: string;
  readonly toolCallId?: string;
  readonly fields: readonly RelayElicitationField[];
  readonly raw?: unknown;
}

export type RelayElicitationRequestHandlerResult =
  | void
  | null
  | { readonly action: "continue" }
  | { readonly action: "respond"; readonly response: RelayElicitationResponse };

export type RelayElicitationRequestHandler = (
  request: RelayElicitationRequest,
) => RelayElicitationRequestHandlerResult | Promise<RelayElicitationRequestHandlerResult>;

export interface RelayMcpServerConfig {
  readonly name: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Record<string, string>;
}

export type RelayMcpServerApplyMode = "nextSession" | "promptRestart" | "restartNow";

export interface RelayMcpServerLifecycleOptions {
  /**
   * Controls how Relay surfaces MCP changes made after the current ACP process was launched.
   * The default is `nextSession`, which records the change for future ACP launches without prompting.
   */
  readonly apply?: RelayMcpServerApplyMode;
}

export interface RelayMcpStatus {
  /** True once a pending server list differs from the MCP list passed to the active ACP process. */
  readonly restartNeeded: boolean;
  /** Whether Relay has already launched an ACP process with a plugin MCP server snapshot. */
  readonly applied: boolean;
  /** MCP servers passed to the active ACP process, or an empty list before ACP launch. */
  readonly activeServers: readonly RelayMcpServerConfig[];
  /** MCP servers currently registered by plugins for the next ACP launch/restart. */
  readonly pendingServers: readonly RelayMcpServerConfig[];
}

export interface RelayDiffOverlayOptions {
  readonly title?: string;
  readonly subtitle?: string;
  readonly diffText?: string;
  readonly loadDiffText?: () => string | Promise<string>;
  readonly emptyMessage?: string;
}

export interface RelayPluginDialogOptions {
  /** Dismiss the dialog automatically after this many milliseconds. */
  readonly timeoutMs?: number;
  /** Dismiss the dialog when the signal aborts. */
  readonly signal?: AbortSignal;
}

export interface RelayPluginConfirmDialogOptions extends RelayPluginDialogOptions {
  /** Value returned if the dialog times out. Escape/abort still return false. */
  readonly defaultValue?: boolean;
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
}

export type RelayPluginSelectDialogOptions = RelayPluginDialogOptions;

export interface RelayPluginInputDialogOptions extends RelayPluginDialogOptions {
  readonly defaultValue?: string;
}

export type RelayPluginEditorDialogOptions = RelayPluginDialogOptions;

export interface RelayPluginSelectItem {
  readonly value: string;
  readonly label?: string;
  readonly description?: string;
}

export type RelayPluginSelectOption = string | RelayPluginSelectItem;

export type RelayPluginChatBlockPlacement =
  | { readonly kind: "append" }
  | { readonly kind: "before-user-message-index"; readonly index: number }
  | { readonly kind: "after-user-message-index"; readonly index: number };

export interface RelayPluginChatBlockInput {
  readonly id?: string;
  readonly threadId?: string;
  readonly blockType: string;
  readonly content: string;
  readonly data?: unknown;
  readonly placement?: RelayPluginChatBlockPlacement;
}

export interface RelayPluginUiApi {
  getTheme(): RelayThemeConfig;
  toast(message: string, variant?: RelayPluginToastVariant, durationMs?: number): void;
  openDiff(options: RelayDiffOverlayOptions): Disposable;
  confirm(title: string, message: string, options?: RelayPluginConfirmDialogOptions): Promise<boolean>;
  select(
    title: string,
    options: readonly RelayPluginSelectOption[],
    dialogOptions?: RelayPluginSelectDialogOptions,
  ): Promise<string | undefined>;
  input(title: string, placeholder?: string, options?: RelayPluginInputDialogOptions): Promise<string | undefined>;
  editor(title: string, prefill?: string, options?: RelayPluginEditorDialogOptions): Promise<string | undefined>;
  addTip(text: string, options?: RelayPluginTipOptions): Disposable;
  addChatBlock(block: RelayPluginChatBlockInput): string | undefined;
  userMessageCount(threadId?: string): number;
  setEditorStatus(key: string, value: RelayPluginStatusValue | undefined): void;
  showOverlay(key: string, widget: RelayOverlayWidget): RelayWidgetHandle;
  setWidget(key: string, widget: RelayWidget | undefined): RelayWidgetHandle | undefined;
  setEditorStatusSegment(key: string, segment: RelayEditorStatusSegment | undefined): void;
  setEditorFooterSegment(key: string, segment: RelayEditorFooterSegment | undefined): void;
  registerEditorHeaderRenderer(renderer: RelayEditorHeaderRenderer): Disposable;
  registerEditorFooterRenderer(renderer: RelayEditorFooterRenderer): Disposable;
  registerEditorChromeElementRenderer(renderer: RelayEditorChromeElementRenderer): Disposable;
  registerToolRenderer(renderer: RelayToolRenderer): Disposable;
  registerMessageRenderer(renderer: RelayMessageRenderer): Disposable;
}

export interface RelayPluginEditorApi {
  configure(options: Partial<RelayEditorOptions>): Disposable;
  setTheme(options: Partial<RelayEditorTheme>): Disposable;
  addAutocompleteProvider(provider: RelayAutocompleteProvider): Disposable;
  getText(): string;
  setText(text: string): void;
  insertText(text: string): void;
  /** Attach a local image at the cursor using Relay's image sidecar flow. */
  attachImage(path: string): boolean;
  submit(text?: string): Promise<void>;
}

export interface RelayPluginInputApi {
  onBeforeSubmit(handler: RelayPromptBeforeSubmitHandler): Disposable;
  addSystemReminder(provider: RelaySystemReminderProvider): Disposable;
}

export interface RelayPluginUserBashApi {
  onBeforeRun(handler: RelayUserBashBeforeRunHandler): Disposable;
  onRun(handler: RelayUserBashRunHandler): Disposable;
}

export interface RelayPluginPermissionApi {
  onRequest(handler: RelayPermissionRequestHandler): Disposable;
}

export interface RelayPluginElicitationApi {
  onRequest(handler: RelayElicitationRequestHandler): Disposable;
}

export interface RelayPluginCommandApi {
  register(name: string, command: RelayCommand): Disposable;
  list(): readonly RelayRegisteredCommand[];
}

export interface RelayPluginKeybindingApi {
  register(key: string, binding: RelayKeybinding): Disposable;
}

export interface RelayPluginToolsApi {
  setDisplayPolicy(toolName: string, policy: RelayToolDisplayPolicy | undefined): Disposable;
  registerRenderer(renderer: RelayToolRenderer): Disposable;
}

export interface RelayPluginAgentPromptDisplay {
  readonly kind: "skill";
  readonly name: string;
  readonly userMessage?: string;
}

export interface RelayPluginAgentPromptOptions {
  readonly display?: RelayPluginAgentPromptDisplay;
  readonly targetThreadId?: string;
}

export interface RelayPluginActiveTurnInputResult {
  readonly accepted: boolean;
  readonly reason?: string;
}

export interface RelayPluginSessionResult {
  readonly sessionId: string | null;
}

export interface RelayPluginForkSessionOptions {
  readonly sessionId?: string;
  readonly cwd?: string;
  readonly additionalDirectories?: readonly string[];
}

export interface RelayPluginModelInfo {
  readonly modelId: string;
  readonly name?: string;
  readonly description?: string;
}

export interface RelayPluginModeInfo {
  readonly id: string;
  readonly name?: string;
  readonly description?: string;
}

export type RelayPluginThreadStatus = "running" | "paused" | "connecting";
export type RelayPluginThreadWorkspaceKind = "local" | "worktree";

export interface RelayPluginThreadInfo {
  readonly id: string;
  readonly title: string;
  readonly sessionId: string | null;
  readonly cwd: string;
  readonly workspaceKind: RelayPluginThreadWorkspaceKind;
  readonly worktreePath?: string;
  readonly worktreeBranch?: string;
  readonly status: RelayPluginThreadStatus;
  readonly archived: boolean;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface RelayPluginThreadCreateOptions {
  readonly cwd?: string;
  readonly worktree?: boolean;
  readonly snapshotCurrent?: boolean;
  readonly select?: boolean;
}

export interface RelayPluginThreadSessionInfo {
  readonly thread: RelayPluginThreadInfo;
  readonly sessionId: string | null;
}

export type RelayConversationContentItem =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly data: string; readonly mimeType: string }
  | { readonly type: "audio"; readonly data: string; readonly mimeType: string }
  | {
      readonly type: "resourceLink";
      readonly name: string;
      readonly uri: string;
      readonly description?: string;
      readonly mimeType?: string;
    }
  | {
      readonly type: "resource";
      readonly uri: string;
      readonly mimeType?: string;
      readonly text?: string;
      readonly blob?: string;
    };

export interface RelayConversationToolDiff {
  readonly path: string;
  readonly oldText: string;
  readonly newText: string;
}

export type RelayConversationToolContentItem =
  | { readonly type: "diff"; readonly diff: RelayConversationToolDiff }
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly data: string; readonly mimeType: string }
  | { readonly type: "audio"; readonly data: string; readonly mimeType: string }
  | {
      readonly type: "resourceLink";
      readonly name: string;
      readonly uri: string;
      readonly description?: string;
      readonly mimeType?: string;
    }
  | {
      readonly type: "resource";
      readonly uri: string;
      readonly mimeType?: string;
      readonly text?: string;
      readonly blob?: string;
    }
  | { readonly type: "terminal"; readonly terminalId: string };

export type RelayConversationBlock =
  | {
      readonly type: "user";
      readonly id: string;
      readonly role: "user";
      readonly content: string;
      readonly delivery?: "turn" | "current-turn-guidance";
      readonly origin?: "local" | "acp";
      readonly skillInvocation?: RelayPluginAgentPromptDisplay;
      readonly contentItems?: readonly RelayConversationContentItem[];
    }
  | {
      readonly type: "content" | "thinking";
      readonly id: string;
      readonly role: "assistant";
      readonly content: string;
      readonly finalized: boolean;
      readonly contentItems?: readonly RelayConversationContentItem[];
    }
  | {
      readonly type: "tool";
      readonly id: string;
      readonly toolCallId: string;
      readonly toolName: string;
      readonly toolKind?: string;
      readonly display: string;
      readonly status: RelayToolLifecycleStatus;
      readonly summary?: string;
      readonly details?: string;
      readonly input: unknown;
      readonly output: unknown;
      readonly content?: readonly RelayConversationToolContentItem[];
    }
  | {
      readonly type: "user-bash";
      readonly id: string;
      readonly command: string;
      readonly output: string;
      readonly exitCode?: number;
      readonly status: "running" | "done" | "error";
      readonly excludeFromContext: boolean;
    }
  | {
      readonly type: "info";
      readonly id: string;
      readonly content: string;
      readonly variant: "info" | "warning" | "error" | "session" | "resources" | "plain" | "spinner";
    }
  | {
      readonly type: "plugin";
      readonly id: string;
      readonly pluginId: string;
      readonly pluginName: string;
      readonly blockType: string;
      readonly content: string;
      readonly data?: unknown;
    }
  | {
      readonly type: "elicitation";
      readonly id: string;
      readonly mode: RelayElicitationMode;
      readonly message: string;
      readonly schema?: RelayElicitationSchema;
      readonly url?: string;
      readonly elicitationId?: string;
      readonly status: "pending" | "accepted" | "declined" | "cancelled";
      readonly fields: readonly RelayElicitationField[];
      readonly answers: Readonly<Record<string, unknown>>;
    };

export interface RelayConversationSnapshot {
  readonly thread: RelayPluginThreadInfo;
  readonly threadId: string;
  readonly sessionId: string | null;
  readonly cwd: string;
  readonly blocks: readonly RelayConversationBlock[];
}

export interface RelayPluginThreadApi {
  current(): RelayPluginThreadInfo | null;
  list(): readonly RelayPluginThreadInfo[];
  conversation(threadId?: string): RelayConversationSnapshot | null;
  conversationMarkdown(threadId?: string): string | null;
  create(options?: RelayPluginThreadCreateOptions): Promise<RelayPluginThreadInfo | null>;
  ensureSession(threadId?: string): Promise<RelayPluginThreadSessionInfo | null>;
  select(threadId: string): Promise<void>;
  archive(threadId: string): Promise<void>;
}

export interface RelayPluginAgentApi {
  readonly name: string;
  readonly profile: string;
  readonly sessionId: string | null;
  isRunning(): boolean;
  waitForIdle(): Promise<void>;
  hasQueuedPrompts(): boolean;
  supportsActiveTurnInput(): boolean;
  supportsSessionFork(): boolean;
  supportsSessionDelete(): boolean;
  supportsSessionClose(): boolean;
  addToCurrentTurn(text: string): Promise<RelayPluginActiveTurnInputResult>;
  forkSession(options?: RelayPluginForkSessionOptions): Promise<RelayPluginSessionResult>;
  runHiddenPrompt(sessionId: string, text: string): Promise<string>;
  deleteSession(sessionId: string): Promise<void>;
  closeSession(sessionId: string): Promise<void>;
  availableModes(): readonly RelayPluginModeInfo[];
  availableModels(): readonly RelayPluginModelInfo[];
  availableThinkingLevels(): readonly string[];
  prompt(text: string, options?: RelayPluginAgentPromptOptions): Promise<void>;
  cancel(): Promise<void>;
  restart(): Promise<void>;
  newSession(cwd?: string): Promise<void>;
  loadSession(sessionId: string, cwd?: string): Promise<void>;
  setMode(modeId: string): Promise<void>;
  setModel(modelId: string): Promise<void>;
  setThinkingLevel(level: string): Promise<void>;
  setSessionModel(sessionId: string, modelId: string): Promise<void>;
  setSessionThinkingLevel(sessionId: string, level: string): Promise<void>;
}

export interface RelayPluginAcpApi {
  readonly supportsRawRequests: boolean;
  onSessionUpdate(handler: (update: unknown) => void): Disposable;
  request(method: string, params: unknown): Promise<unknown>;
}

export interface RelayPluginMcpApi {
  addServer(server: RelayMcpServerConfig, options?: RelayMcpServerLifecycleOptions): Disposable;
  removeServer(name: string, options?: RelayMcpServerLifecycleOptions): boolean;
  listServers(): readonly RelayMcpServerConfig[];
  status(): RelayMcpStatus;
}

export type RelayPluginJsonObject = { readonly [key: string]: RelayPluginJsonValue };
export type RelayPluginJsonArray = readonly RelayPluginJsonValue[];
export type RelayPluginJsonValue = null | boolean | number | string | RelayPluginJsonArray | RelayPluginJsonObject;

export interface RelayPluginPersistedStorageApi {
  get(key: string): RelayPluginJsonValue | undefined;
  set(key: string, value: RelayPluginJsonValue): void;
  delete(key: string): void;
  clear(): void;
}

export interface RelayPluginStorageApi {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  delete(key: string): void;
  clear(): void;
  readonly persisted: RelayPluginPersistedStorageApi;
}

export type RelayPluginSettingValueType = "boolean" | "choice" | "integer" | "number";

export interface RelayPluginSettingDefinition {
  readonly title: string;
  readonly description: string;
  readonly type: RelayPluginSettingValueType;
  readonly default: boolean | number | string;
  readonly min?: number;
  readonly max?: number;
  readonly choices?: () => readonly string[];
}

export function coercePluginSettingValue(
  raw: unknown,
  definition: RelayPluginSettingDefinition,
): boolean | number | string {
  if (raw === undefined || raw === null) return definition.default;
  switch (definition.type) {
    case "boolean":
      return typeof raw === "boolean" ? raw : definition.default;
    case "number":
    case "integer": {
      if (typeof raw !== "number" || !Number.isFinite(raw)) return definition.default;
      const typed = definition.type === "integer" ? Math.round(raw) : raw;
      if (definition.min !== undefined && typed < definition.min) return definition.default;
      if (definition.max !== undefined && typed > definition.max) return definition.default;
      return typed;
    }
    case "choice": {
      const choices = definition.choices?.() ?? [];
      return typeof raw === "string" && choices.includes(raw) ? raw : definition.default;
    }
  }
}

export interface RelayPluginSettingsApi {
  define(key: string, definition: RelayPluginSettingDefinition): void;
  get(key: string): boolean | number | string;
  set(key: string, value: boolean | number | string): void;
}

export interface RelayPluginApi {
  readonly plugin: RelayPluginInfo;
  readonly cwd: string;
  on<E extends RelayPluginEvent["type"]>(type: E, handler: RelayEventHandler<E>): Disposable;
  readonly ui: RelayPluginUiApi;
  readonly editor: RelayPluginEditorApi;
  readonly input: RelayPluginInputApi;
  readonly userBash: RelayPluginUserBashApi;
  readonly permissions: RelayPluginPermissionApi;
  readonly elicitation: RelayPluginElicitationApi;
  readonly commands: RelayPluginCommandApi;
  readonly keybindings: RelayPluginKeybindingApi;
  readonly tools: RelayPluginToolsApi;
  readonly agent: RelayPluginAgentApi;
  readonly thread: RelayPluginThreadApi;
  readonly acp: RelayPluginAcpApi;
  readonly mcp: RelayPluginMcpApi;
  readonly storage: RelayPluginStorageApi;
  readonly settings: RelayPluginSettingsApi;
}

export type RelayPluginFactory = (relay: RelayPluginApi) => void | Promise<void>;

export interface RelayPluginDiagnostic {
  readonly plugin: RelayPluginInfo;
  readonly message: string;
  readonly cause?: unknown;
}

export interface LoadedRelayPlugin {
  readonly info: RelayPluginInfo;
  readonly factory: RelayPluginFactory;
}

export function defineRelayPlugin(factory: RelayPluginFactory): RelayPluginFactory {
  return factory;
}

export function defineRelayCommand<const T extends RelayCommand>(command: T): T {
  return command;
}

export function defineRelayKeybinding<const T extends RelayKeybinding>(binding: T): T {
  return binding;
}

export function defineRelayAutocompleteProvider<const T extends RelayAutocompleteProvider>(provider: T): T {
  return provider;
}

export function defineRelayWidget<const T extends RelayWidget>(widget: T): T {
  return widget;
}

export function defineRelayEditorStatusSegment<const T extends RelayEditorStatusSegment>(segment: T): T {
  return segment;
}

export function defineRelayEditorFooterSegment<const T extends RelayEditorFooterSegment>(segment: T): T {
  return segment;
}

export function defineRelayEditorHeaderRenderer<const T extends RelayEditorHeaderRenderer>(renderer: T): T {
  return renderer;
}

export function defineRelayEditorFooterRenderer<const T extends RelayEditorFooterRenderer>(renderer: T): T {
  return renderer;
}

export function defineRelayEditorChromeElementRenderer<const T extends RelayEditorChromeElementRenderer>(
  renderer: T,
): T {
  return renderer;
}

export function defineRelayToolRenderer<const T extends RelayToolRenderer>(renderer: T): T {
  return renderer;
}

export function defineRelayMessageRenderer<const T extends RelayMessageRenderer>(renderer: T): T {
  return renderer;
}

export function createRelayDisposable(dispose: () => void): Disposable {
  return { dispose };
}

export function combineRelayDisposables(...disposables: readonly Disposable[]): Disposable {
  return createRelayDisposable(() => {
    for (const disposable of disposables.toReversed()) disposable.dispose();
  });
}

export type RelayLineInput = string | RelayLine;

export interface RelayInlineInputLineOptions {
  readonly value: string;
  readonly placeholder: string;
  readonly width: number;
  readonly colors: Pick<RelayColorsConfig, "accent" | "bg" | "fg" | "textMuted">;
}

export function relayInlineInputLine(options: RelayInlineInputLineOptions): RelayLine {
  const width = Math.max(1, Math.floor(options.width));
  if (options.value) {
    const value = fitInlineInputText(options.value, Math.max(0, width - 1));
    const segments: readonly RelayLineSegment[] = [
      { text: value, fg: options.colors.fg },
      { text: " ", bg: options.colors.accent },
    ];
    return { text: segments.map((segment) => segment.text).join(""), segments };
  }

  const placeholder = fitInlineInputText(options.placeholder, width);
  const segments: readonly RelayLineSegment[] = [
    { text: placeholder.slice(0, 1), fg: options.colors.bg, bg: options.colors.accent },
    { text: placeholder.slice(1), fg: options.colors.textMuted },
  ];
  return { text: segments.map((segment) => segment.text).join(""), segments };
}

function fitInlineInputText(text: string, width: number): string {
  if (text.length <= width) return text;
  if (width <= 1) return text.slice(0, width);
  return `${text.slice(0, width - 1)}…`;
}

export function relayLine(input: RelayLineInput, options: Omit<RelayLine, "text"> = {}): RelayLine {
  if (typeof input !== "string") return input;
  return { ...options, text: input };
}

export function relayLines(...lines: readonly RelayLineInput[]): RelayRenderable {
  return { kind: "lines", lines: lines.map((line) => relayLine(line)) };
}

export interface RelayCardOptions {
  readonly title?: string | RelayLine;
  readonly lines: readonly RelayLineInput[];
  readonly border?: RelayCardBorderStyle;
}

export function relayCard(options: RelayCardOptions): RelayRenderable {
  return {
    kind: "card",
    title: options.title,
    lines: options.lines.map((line) => relayLine(line)),
    border: options.border,
  };
}
