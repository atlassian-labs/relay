import { describe, expect, test } from "bun:test";

import type { AcpClient } from "../../../src/acp/client";
import { defaultAgentBehaviorProfile } from "../../../src/acp/profiles/default";
import { getConfig } from "../../../src/config";
import type { ThreadInfo } from "../../../src/core/threads";
import { type ListItem, SelectionMode } from "../../../src/ui/autocomplete";
import { PluginRunner, type RelayWidgetHandle } from "../../../src/plugins";
import { createAppKeyboardHandler, type KeyboardHandlerDeps } from "../../../src/ui/app/keyboard-handler";
import { createAppStateValue } from "../../../src/ui/context/app-state";
import type { ComposerInputOwner } from "../../../src/ui/util/composer-input";
import { initialVimState } from "../../../src/ui/util/vim-engine";

function createKeyboardDeps(overrides: Partial<KeyboardHandlerDeps> = {}): KeyboardHandlerDeps {
  return {
    contextValue: createAppStateValue(process.cwd()),
    renderer: {},
    appInstanceId: 1,
    activeAppInstanceId: () => 1,
    composerInputOwner: () => "composer",
    pluginOverlayOpen: () => false,
    handlePluginDialogKey: () => false,
    openPromptInExternalEditor: () => {},
    textareaRef: () => null,
    acpClient: () => null,
    agentBehaviorProfile: () => defaultAgentBehaviorProfile,
    pluginRunner: () => null,
    isTabCompleting: () => false,
    activeSettingsValueSetting: () => null,
    activeSettingsSubmenu: () => null,
    userBashAbortController: () => null,
    clearSelectionAllItems: () => {},
    hideOverlay: () => {},
    isOverlayVisible: () => false,
    settingsOverlayActive: () => false,
    selectionMode: () => null,
    setSelectionMode: () => {},
    overlayItems: () => [],
    overlayIndex: () => 0,
    setOverlayIndex: () => {},
    showSelectionOverlay: () => {},
    selectOverlayItem: () => {},
    toggleSelectedPlugin: () => {},
    openNotificationSettingsOverlay: () => {},
    openSettingsOverlay: () => {},
    openPluginsOverlay: () => {},
    openPromptHistorySearch: () => {},
    interruptAcpPrompt: async () => false,
    shutdownAndExit: async () => {},
    createThread: async () => {},
    selectThread: async () => {},
    archiveThread: async () => {},
    openExistingWorktreePicker: () => {},
    setSessionModeFromKeyboard: async () => {},
    cycleSessionModelFromKeyboard: () => {},
    cycleSessionThinkingLevelFromKeyboard: () => {},
    cancelElicitation: () => {},
    navigateElicitationField: () => {},
    selectElicitationChoice: () => {},
    restoreEditingQueuedPrompt: () => false,
    deleteEditingQueuedPrompt: () => false,
    cancelPendingQueueFocus: () => false,
    exitQueueBrowse: () => {},
    navigatePromptHistory: () => false,
    moveFocusedQueuedPrompt: () => false,
    moveQueueFocus: () => null,
    sendFocusedQueuedPromptNow: () => false,
    editFocusedQueuedPrompt: () => false,
    cancelFocusedQueuedPrompt: () => false,
    handleActiveTurnInput: () => {},
    doTabPathCompletion: () => {},
    refreshCurrentPasteHighlights: () => {},
    insertPromptTextAtCursor: () => false,
    getTextareaText: () => "",
    resetDoublePressState: () => {},
    markInputUpdateSource: () => {},
    nativeModal: () => null,
    openNativeModal: () => {},
    closeNativeModal: () => {},
    fileChangesModalOpen: () => false,
    threadSidebarExpanded: () => false,
    setThreadSidebarExpanded: () => {},
    showThreadSidebar: () => false,
    setShowThreadSidebar: () => {},
    sidebarFocused: () => false,
    setSidebarFocused: () => {},
    sidebarFocusedIndex: () => 0,
    setSidebarFocusedIndex: () => {},
    setThreadSidebarListOffset: () => {},
    vimEnabled: () => false,
    vimState: () => initialVimState,
    setVimState: () => {},
    queueFocusIndex: () => null,
    setQueueFocusIndex: () => {},
    editingQueueItem: () => null,
    approvalOptionIndex: () => 0,
    setApprovalOptionIndex: () => {},
    setElicitationOptionIndex: () => {},
    setWelcomeDismissed: () => {},
    ...overrides,
  };
}

const LAG_PAST_OLD_SPLIT_TAIL_RECOVERY_WINDOW_MS = 60;

async function waitPastOldSplitTailRecoveryWindow(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, LAG_PAST_OLD_SPLIT_TAIL_RECOVERY_WINDOW_MS));
}

function keyboardThread(id: string, updatedAt: string): ThreadInfo {
  return {
    id,
    title: id,
    sessionId: null,
    cwd: process.cwd(),
    workspaceKind: "local",
    status: "paused",
    archived: false,
    createdAt: updatedAt,
    updatedAt,
  };
}

function dispatchKeyboardEvent(
  sequence: string,
  overrides: Partial<KeyboardHandlerDeps> = {},
): { insertedText: string; prevented: boolean; stopped: boolean } {
  let prevented = false;
  let stopped = false;
  let insertedText = "";
  const handler = createAppKeyboardHandler(
    createKeyboardDeps({
      insertPromptTextAtCursor: (text) => {
        insertedText += text;
        return true;
      },
      ...overrides,
    }),
  );

  handler({
    name: sequence,
    sequence,
    ctrl: false,
    meta: false,
    option: false,
    alt: false,
    preventDefault: () => {
      prevented = true;
    },
    stopPropagation: () => {
      stopped = true;
    },
  });

  return { insertedText, prevented, stopped };
}

describe("createAppKeyboardHandler", () => {
  test("isolates subagent detail input and restores the subagent picker on escape", () => {
    const contextValue = createAppStateValue(process.cwd());
    contextValue.setState("blocks", [
      {
        type: "tool",
        id: "invoke-scout",
        toolCallId: "invoke-scout",
        toolName: "invoke_agent",
        display: "",
        status: "running",
        rawInput: { agent: "scout", message: "Inspect the renderer selection flow" },
        subagent: {
          invokingToolCallId: "invoke-scout",
          childSessionId: "subagent-scout",
          agentName: "scout",
          status: "running",
          progress: [],
        },
      },
    ]);
    contextValue.setState("selectedSubagentToolCallId", "invoke-scout");
    let openedEditor = 0;
    let restoredItems: ListItem<unknown>[] = [];
    let restoredMode: SelectionMode | null = null;
    let restoredIndex = -1;
    let prevented = 0;
    let stopped = 0;
    const handler = createAppKeyboardHandler(
      createKeyboardDeps({
        contextValue,
        openPromptInExternalEditor: () => {
          openedEditor += 1;
        },
        showSelectionOverlay: (items, mode, _layout, selectedIndex) => {
          restoredItems = items;
          restoredMode = mode;
          restoredIndex = selectedIndex ?? -1;
        },
      }),
    );
    const event = (name: string, ctrl = false) => ({
      name,
      ctrl,
      meta: false,
      preventDefault: () => {
        prevented += 1;
      },
      stopPropagation: () => {
        stopped += 1;
      },
    });

    handler(event("x", true));
    expect(openedEditor).toBe(0);
    expect(contextValue.state.selectedSubagentToolCallId).toBe("invoke-scout");

    handler(event("escape"));
    expect(contextValue.state.selectedSubagentToolCallId).toBeNull();
    expect(restoredMode as SelectionMode | null).toBe(SelectionMode.SUBAGENT);
    expect(restoredIndex).toBe(0);
    expect(restoredItems[0]?.label).toBe("scout (Inspect the renderer selection flow)");
    expect(prevented).toBe(2);
    expect(stopped).toBe(2);
  });

  test("ctrl+p returns a child session to its parent and restores the children picker", async () => {
    const contextValue = createAppStateValue(process.cwd());
    const parent = keyboardThread("parent", "2026-07-01T00:00:00.000Z");
    const firstChild: ThreadInfo = {
      ...keyboardThread("first-child", "2026-07-02T00:00:00.000Z"),
      parentThreadId: parent.id,
      relationKind: "child",
    };
    const secondChild: ThreadInfo = {
      ...keyboardThread("second-child", "2026-07-03T00:00:00.000Z"),
      parentThreadId: parent.id,
      relationKind: "child",
    };
    contextValue.setState("threads", [parent, firstChild, secondChild]);
    contextValue.setState("activeThreadId", secondChild.id);
    let restoredItems: ListItem<ThreadInfo>[] = [];
    let restoredMode: SelectionMode | null = null;
    let restoredIndex = -1;
    let prevented = false;
    let stopped = false;
    const handler = createAppKeyboardHandler(
      createKeyboardDeps({
        contextValue,
        selectThread: async (app, threadId) => {
          app.setState("activeThreadId", threadId);
        },
        showSelectionOverlay: (items, mode, _layout, selectedIndex) => {
          restoredItems = items as ListItem<ThreadInfo>[];
          restoredMode = mode;
          restoredIndex = selectedIndex ?? -1;
        },
      }),
    );

    handler({
      name: "p",
      ctrl: true,
      meta: false,
      shift: false,
      option: false,
      alt: false,
      preventDefault: () => {
        prevented = true;
      },
      stopPropagation: () => {
        stopped = true;
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(contextValue.state.activeThreadId).toBe(parent.id);
    expect(restoredMode as SelectionMode | null).toBe(SelectionMode.CHILD);
    expect(restoredItems.map((item) => item.value.id)).toEqual([firstChild.id, secondChild.id]);
    expect(restoredIndex).toBe(1);
    expect(prevented).toBe(true);
    expect(stopped).toBe(true);
  });

  test("navigates, expands, collapses, and exits selected transcript rows", () => {
    const contextValue = createAppStateValue(process.cwd());
    contextValue.setState("blocks", [
      {
        type: "tool",
        id: "tool-1",
        toolCallId: "call-1",
        toolName: "read",
        display: "",
        status: "success",
        rawInput: { path: "one.ts" },
        rawOutput: "one",
      },
      { type: "content", id: "content-1", content: "answer", finalized: true },
      {
        type: "tool",
        id: "approval-1",
        toolCallId: "approval-call",
        toolName: "bash",
        display: "",
        status: "approval",
      },
      { type: "thinking", id: "thinking-1", content: "reasoning", finalized: true },
      {
        type: "tool",
        id: "tool-2",
        toolCallId: "call-2",
        toolName: "grep",
        display: "",
        status: "success",
        rawInput: { pattern: "two" },
        rawOutput: "two",
      },
    ]);
    contextValue.setState("transcriptSelectedBlockId", "tool-1");
    let focusCount = 0;
    const handler = createAppKeyboardHandler(
      createKeyboardDeps({
        contextValue,
        textareaRef: () => ({
          focus: () => {
            focusCount += 1;
          },
        }),
      }),
    );
    const event = (name: string) => ({
      name,
      ctrl: false,
      meta: false,
      shift: false,
      option: false,
      alt: false,
      preventDefault: () => {},
      stopPropagation: () => {},
    });

    handler(event("down"));
    expect(contextValue.state.transcriptSelectedBlockId).toBe("content-1");
    handler(event("down"));
    expect(contextValue.state.transcriptSelectedBlockId).toBe("thinking-1");
    handler(event("down"));
    expect(contextValue.state.transcriptSelectedBlockId).toBe("tool-2");

    handler(event("right"));
    expect(contextValue.state.transcriptDetailBlockId).toBe("tool-2");
    handler(event("left"));
    expect(contextValue.state.transcriptDetailBlockId).toBeNull();
    expect(contextValue.state.transcriptSelectedBlockId).toBe("tool-2");

    handler(event("return"));
    expect(contextValue.state.transcriptDetailBlockId).toBe("tool-2");
    handler(event("escape"));
    expect(contextValue.state.transcriptDetailBlockId).toBeNull();

    handler(event("escape"));
    expect(contextValue.state.transcriptSelectedBlockId).toBeNull();
    expect(focusCount).toBe(1);
  });

  test("uses option+up/down to move between the composer and transcript rows", () => {
    const contextValue = createAppStateValue(process.cwd());
    contextValue.setState("blocks", [
      { type: "user", id: "user-1", content: "question" },
      { type: "content", id: "content-1", content: "answer", finalized: true },
    ]);
    let focusCount = 0;
    const handler = createAppKeyboardHandler(
      createKeyboardDeps({
        contextValue,
        textareaRef: () => ({
          focus: () => {
            focusCount += 1;
          },
        }),
      }),
    );
    const optionArrow = (name: "up" | "down") => ({
      name,
      ctrl: false,
      meta: false,
      shift: false,
      option: true,
      alt: true,
      preventDefault: () => {},
      stopPropagation: () => {},
    });

    handler(optionArrow("down"));
    expect(contextValue.state.transcriptSelectedBlockId).toBe("user-1");
    handler(optionArrow("up"));
    expect(contextValue.state.transcriptSelectedBlockId).toBeNull();

    handler(optionArrow("up"));
    expect(contextValue.state.transcriptSelectedBlockId).toBe("content-1");
    handler(optionArrow("up"));
    expect(contextValue.state.transcriptSelectedBlockId).toBe("user-1");
    handler(optionArrow("down"));
    expect(contextValue.state.transcriptSelectedBlockId).toBe("content-1");
    handler(optionArrow("down"));
    expect(contextValue.state.transcriptSelectedBlockId).toBeNull();
    expect(focusCount).toBe(2);
  });

  test("uses option+up/down to cross the transcript and queue boundary", () => {
    const contextValue = createAppStateValue(process.cwd());
    contextValue.setState("blocks", [
      { type: "user", id: "user-1", content: "question" },
      { type: "content", id: "content-1", content: "answer", finalized: true },
    ]);
    contextValue.setState("pendingQueue", [
      { id: "queue-1", text: "first" },
      { id: "queue-2", text: "second" },
    ]);
    let queueFocus: number | null = null;
    const currentQueueFocus = (): number | null => queueFocus;
    let queueBrowseExits = 0;
    const moveQueueFocus = (delta: number): number | null => {
      const next = queueFocus === null ? (delta < 0 ? 1 : 0) : queueFocus + delta;
      queueFocus = next >= 0 && next < contextValue.state.pendingQueue.length ? next : null;
      return queueFocus;
    };
    const handler = createAppKeyboardHandler(
      createKeyboardDeps({
        contextValue,
        queueFocusIndex: () => queueFocus,
        moveQueueFocus,
        exitQueueBrowse: () => {
          queueBrowseExits += 1;
          queueFocus = null;
        },
      }),
    );
    const optionArrow = (name: "up" | "down") => ({
      name,
      ctrl: false,
      meta: false,
      shift: false,
      option: true,
      alt: true,
      preventDefault: () => {},
      stopPropagation: () => {},
    });

    handler(optionArrow("down"));
    expect(contextValue.state.transcriptSelectedBlockId).toBe("user-1");
    expect(currentQueueFocus()).toBeNull();
    handler(optionArrow("up"));
    expect(contextValue.state.transcriptSelectedBlockId).toBeNull();
    expect(currentQueueFocus()).toBeNull();

    handler(optionArrow("up"));
    expect(currentQueueFocus()).toBe(1);

    queueFocus = 0;
    handler(optionArrow("up"));
    expect(currentQueueFocus()).toBeNull();
    expect(queueBrowseExits).toBe(1);
    expect(contextValue.state.transcriptSelectedBlockId).toBe("content-1");

    handler(optionArrow("down"));
    expect(contextValue.state.transcriptSelectedBlockId).toBeNull();
    expect(currentQueueFocus()).toBe(0);
  });

  test("expands configured tool groups before navigating normal child tool rows", () => {
    const ui = getConfig().ui;
    const previousConfig = ui.tool_call_groups;
    ui.tool_call_groups = {
      enabled: true,
      rules: [
        { tool_names: ["read"], singular: "Read {count} file", plural: "Read {count} files" },
        { tool_names: ["grep"], singular: "Searched {count} pattern", plural: "Searched {count} patterns" },
      ],
    };
    try {
      const contextValue = createAppStateValue(process.cwd());
      contextValue.setState("blocks", [
        {
          type: "tool",
          id: "read-1",
          toolCallId: "call-read-1",
          toolName: "read",
          display: "",
          status: "success",
        },
        {
          type: "tool",
          id: "grep-1",
          toolCallId: "call-grep-1",
          toolName: "grep",
          display: "",
          status: "success",
        },
        { type: "content", id: "answer", content: "done", finalized: true },
      ]);
      const groupId = "tool-call-group:read-1";
      contextValue.setState("transcriptSelectedBlockId", groupId);
      contextValue.setState("transcriptSelectedRows", groupId, true);
      const handler = createAppKeyboardHandler(createKeyboardDeps({ contextValue }));
      const event = (name: string) => ({
        name,
        ctrl: false,
        meta: false,
        shift: false,
        option: false,
        alt: false,
        preventDefault: () => {},
        stopPropagation: () => {},
      });

      handler(event("right"));
      expect(contextValue.state.expandedToolCallGroups[groupId]).toBe(true);
      expect(contextValue.state.transcriptDetailBlockId).toBeNull();

      handler(event("down"));
      expect(contextValue.state.transcriptSelectedBlockId).toBe("read-1");
      handler(event("return"));
      expect(contextValue.state.transcriptDetailBlockId).toBe("read-1");
      handler(event("left"));
      expect(contextValue.state.transcriptDetailBlockId).toBeNull();

      contextValue.setState("transcriptSelectedRows", "read-1", false);
      contextValue.setState("transcriptSelectedRows", groupId, true);
      contextValue.setState("transcriptSelectedBlockId", groupId);
      handler(event("left"));
      expect(contextValue.state.expandedToolCallGroups[groupId]).toBe(false);
    } finally {
      ui.tool_call_groups = previousConfig;
    }
  });

  test("opens the external editor with ctrl+x", () => {
    let opened = 0;
    let prevented = false;
    const handler = createAppKeyboardHandler(
      createKeyboardDeps({
        openPromptInExternalEditor: () => {
          opened += 1;
        },
      }),
    );

    handler({
      name: "x",
      sequence: "\u0018",
      ctrl: true,
      meta: false,
      option: false,
      alt: false,
      preventDefault: () => {
        prevented = true;
      },
    });

    expect(opened).toBe(1);
    expect(prevented).toBe(true);
  });

  test("does not open the external editor with ctrl+x while an overlay is visible", () => {
    let opened = 0;
    let prevented = false;
    const handler = createAppKeyboardHandler(
      createKeyboardDeps({
        isOverlayVisible: () => true,
        openPromptInExternalEditor: () => {
          opened += 1;
        },
      }),
    );

    handler({
      name: "x",
      sequence: "\u0018",
      ctrl: true,
      meta: false,
      option: false,
      alt: false,
      preventDefault: () => {
        prevented = true;
      },
    });

    expect(opened).toBe(0);
    expect(prevented).toBe(false);
  });

  test("does not open the external editor with ctrl+e", () => {
    let opened = 0;
    let prevented = false;
    const handler = createAppKeyboardHandler(
      createKeyboardDeps({
        openPromptInExternalEditor: () => {
          opened += 1;
        },
      }),
    );

    handler({
      name: "e",
      sequence: "\u0005",
      ctrl: true,
      meta: false,
      option: false,
      alt: false,
      preventDefault: () => {
        prevented = true;
      },
    });

    expect(opened).toBe(0);
    expect(prevented).toBe(false);
  });

  test("ctrl+c collapses expanded sidebar while keeping compact sidebar focused", () => {
    let expanded = true;
    let shown = true;
    let focused = true;
    let prevented = false;
    const handler = createAppKeyboardHandler(
      createKeyboardDeps({
        threadSidebarExpanded: () => expanded,
        setThreadSidebarExpanded: (value) => {
          expanded = value;
        },
        showThreadSidebar: () => shown,
        setShowThreadSidebar: (value) => {
          shown = value;
        },
        sidebarFocused: () => focused,
        setSidebarFocused: (value) => {
          focused = value;
        },
      }),
    );

    handler({
      name: "c",
      sequence: "\u0003",
      ctrl: true,
      meta: false,
      option: false,
      alt: false,
      preventDefault: () => {
        prevented = true;
      },
    });

    expect(expanded).toBe(false);
    expect(shown).toBe(true);
    expect(focused).toBe(true);
    expect(prevented).toBe(true);
  });

  test("ctrl+b opens a hidden sidebar focused on local thread creation", () => {
    const app = createAppStateValue(process.cwd());
    app.setState("threads", [keyboardThread("active", "2026-07-02T00:00:00.000Z")]);
    app.setState("activeThreadId", "active");
    let shown = false;
    let focused = false;
    let focusedIndex = 0;
    let offset = 4;
    let overlayHidden = false;
    let prevented = false;
    const handler = createAppKeyboardHandler(
      createKeyboardDeps({
        contextValue: app,
        showThreadSidebar: () => shown,
        setShowThreadSidebar: (value) => {
          shown = value;
        },
        sidebarFocused: () => focused,
        setSidebarFocused: (value) => {
          focused = value;
        },
        sidebarFocusedIndex: () => focusedIndex,
        setSidebarFocusedIndex: (value) => {
          focusedIndex = typeof value === "function" ? value(focusedIndex) : value;
        },
        hideOverlay: () => {
          overlayHidden = true;
        },
        setThreadSidebarListOffset: (value) => {
          offset = typeof value === "function" ? value(offset) : value;
        },
      }),
    );

    handler({
      name: "b",
      sequence: "\u0002",
      ctrl: true,
      meta: false,
      option: false,
      alt: false,
      preventDefault: () => {
        prevented = true;
      },
    });

    expect(shown).toBe(true);
    expect(focused).toBe(true);
    expect(focusedIndex).toBe(-2);
    expect(offset).toBe(0);
    expect(overlayHidden).toBe(true);
    expect(prevented).toBe(true);
  });

  test("ctrl+b focuses an already visible sidebar instead of hiding it", () => {
    const app = createAppStateValue(process.cwd());
    app.setState("threads", [
      keyboardThread("older", "2026-07-01T00:00:00.000Z"),
      keyboardThread("active", "2026-07-02T00:00:00.000Z"),
    ]);
    app.setState("activeThreadId", "active");
    let shown = true;
    let focused = false;
    let focusedIndex = -2;
    let overlayHidden = false;
    let prevented = false;
    const handler = createAppKeyboardHandler(
      createKeyboardDeps({
        contextValue: app,
        showThreadSidebar: () => shown,
        setShowThreadSidebar: (value) => {
          shown = value;
        },
        sidebarFocused: () => focused,
        setSidebarFocused: (value) => {
          focused = value;
        },
        sidebarFocusedIndex: () => focusedIndex,
        setSidebarFocusedIndex: (value) => {
          focusedIndex = typeof value === "function" ? value(focusedIndex) : value;
        },
        hideOverlay: () => {
          overlayHidden = true;
        },
        setThreadSidebarListOffset: () => {},
      }),
    );

    handler({
      name: "b",
      sequence: "\u0002",
      ctrl: true,
      meta: false,
      option: false,
      alt: false,
      preventDefault: () => {
        prevented = true;
      },
    });

    expect(shown).toBe(true);
    expect(focused).toBe(true);
    expect(focusedIndex).toBe(0);
    expect(overlayHidden).toBe(true);
    expect(prevented).toBe(true);
  });

  test("creating a local thread from the sidebar returns focus to the editor", async () => {
    let shown = true;
    let expanded = true;
    let focused = true;
    let focusCount = 0;
    let createdLocal = false;
    let prevented = false;
    const handler = createAppKeyboardHandler(
      createKeyboardDeps({
        showThreadSidebar: () => shown,
        setShowThreadSidebar: (value) => {
          shown = value;
        },
        threadSidebarExpanded: () => expanded,
        setThreadSidebarExpanded: (value) => {
          expanded = value;
        },
        sidebarFocused: () => focused,
        setSidebarFocused: (value) => {
          focused = value;
        },
        sidebarFocusedIndex: () => -2,
        textareaRef: () => ({
          focus: () => {
            focusCount += 1;
          },
        }),
        createThread: async (_app, inWorktree) => {
          createdLocal = !inWorktree;
        },
      }),
    );

    handler({
      name: "enter",
      ctrl: false,
      meta: false,
      option: false,
      alt: false,
      preventDefault: () => {
        prevented = true;
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(createdLocal).toBe(true);
    expect(shown).toBe(true);
    expect(expanded).toBe(false);
    expect(focused).toBe(false);
    expect(focusCount).toBe(1);
    expect(prevented).toBe(true);
  });

  test("swallows leaked SGR mouse reports before the textarea can insert them", () => {
    const mouseReportInputs = [
      "<65;181;34M<64;150;30M<64;157;22M",
      "\u001b[<65;181;34M",
      "\u009b<64;150;30M",
      "<0;1;2m",
      "\u001b[<65;181;34M\u009b<64;150;30M<0;1;2m",
    ];

    for (const sequence of mouseReportInputs) {
      const result = dispatchKeyboardEvent(sequence, { composerInputOwner: () => "queue" });

      expect(result.prevented).toBe(true);
      expect(result.stopped).toBe(true);
      expect(result.insertedText).toBe("");
    }
  });

  test("strips leaked SGR mouse reports while preserving adjacent printable input", () => {
    const result = dispatchKeyboardEvent("<65;181;34Mkeep\u001b[<64;150;30M typing", {
      composerInputOwner: () => "composer",
    });

    expect(result.prevented).toBe(true);
    expect(result.stopped).toBe(true);
    expect(result.insertedText).toBe("keep typing");
  });

  test("swallows laggy split bare SGR mouse report tails that arrive one character at a time", async () => {
    let insertedText = "";
    const handler = createAppKeyboardHandler(
      createKeyboardDeps({
        composerInputOwner: () => "composer",
        insertPromptTextAtCursor: (text) => {
          insertedText += text;
          return true;
        },
      }),
    );

    for (const character of "<64;150;30M") {
      let prevented = false;
      handler({
        name: character,
        sequence: character,
        ctrl: false,
        meta: false,
        option: false,
        alt: false,
        preventDefault: () => {
          prevented = true;
        },
      });
      expect(prevented).toBe(true);
      await waitPastOldSplitTailRecoveryWindow();
      expect(insertedText).toBe("");
    }

    expect(insertedText).toBe("");
  });

  test("swallows split bare SGR mouse report tails delivered in printable chunks", () => {
    let insertedText = "";
    const handler = createAppKeyboardHandler(
      createKeyboardDeps({
        composerInputOwner: () => "composer",
        insertPromptTextAtCursor: (text) => {
          insertedText += text;
          return true;
        },
      }),
    );

    for (const chunk of ["<64;150", ";30M"]) {
      let prevented = false;
      handler({
        name: chunk,
        sequence: chunk,
        ctrl: false,
        meta: false,
        option: false,
        alt: false,
        preventDefault: () => {
          prevented = true;
        },
      });
      expect(prevented).toBe(true);
    }

    expect(insertedText).toBe("");
  });

  test("preserves printable text batched after a chunked split mouse-report tail", () => {
    let insertedText = "";
    const handler = createAppKeyboardHandler(
      createKeyboardDeps({
        composerInputOwner: () => "composer",
        insertPromptTextAtCursor: (text) => {
          insertedText += text;
          return true;
        },
      }),
    );

    handler({
      name: "<64;150",
      sequence: "<64;150",
      ctrl: false,
      meta: false,
      option: false,
      alt: false,
      preventDefault: () => {},
    });
    handler({
      name: ";30Mkept",
      sequence: ";30Mkept",
      ctrl: false,
      meta: false,
      option: false,
      alt: false,
      preventDefault: () => {},
    });

    expect(insertedText).toBe("kept");
  });

  test("flushes chunked mouse-report lookalikes back into the prompt when they become invalid", () => {
    let insertedText = "";
    const handler = createAppKeyboardHandler(
      createKeyboardDeps({
        composerInputOwner: () => "composer",
        insertPromptTextAtCursor: (text) => {
          insertedText += text;
          return true;
        },
      }),
    );

    handler({
      name: "<64;150",
      sequence: "<64;150",
      ctrl: false,
      meta: false,
      option: false,
      alt: false,
      preventDefault: () => {},
    });
    handler({
      name: ";30Q",
      sequence: ";30Q",
      ctrl: false,
      meta: false,
      option: false,
      alt: false,
      preventDefault: () => {},
    });

    expect(insertedText).toBe("<64;150;30Q");
  });

  test("flushes laggy split mouse-report lookalikes back into the prompt when they become invalid", async () => {
    let insertedText = "";
    const handler = createAppKeyboardHandler(
      createKeyboardDeps({
        composerInputOwner: () => "composer",
        insertPromptTextAtCursor: (text) => {
          insertedText += text;
          return true;
        },
      }),
    );

    const lookalike = "<64;150;30Q";
    for (const character of lookalike) {
      handler({
        name: character,
        sequence: character,
        ctrl: false,
        meta: false,
        option: false,
        alt: false,
        preventDefault: () => {},
      });
      if (character !== "Q") {
        await waitPastOldSplitTailRecoveryWindow();
        expect(insertedText).toBe("");
      }
    }

    expect(insertedText).toBe(lookalike);
  });

  test("flushes pending split mouse-report prefixes before the empty-prompt question-mark shortcut", async () => {
    let insertedText = "";
    let shortcutReferenceOpen = false;
    const handler = createAppKeyboardHandler(
      createKeyboardDeps({
        composerInputOwner: () => "composer",
        insertPromptTextAtCursor: (text) => {
          insertedText += text;
          return true;
        },
        getTextareaText: () => insertedText,
        openNativeModal: (id) => {
          shortcutReferenceOpen = id === "shortcut-reference";
        },
      }),
    );

    handler({
      name: "<",
      sequence: "<",
      ctrl: false,
      meta: false,
      option: false,
      alt: false,
      preventDefault: () => {},
    });
    await waitPastOldSplitTailRecoveryWindow();
    handler({
      name: "?",
      sequence: "?",
      ctrl: false,
      meta: false,
      option: false,
      alt: false,
      preventDefault: () => {},
    });

    expect(insertedText).toBe("<?");
    expect(shortcutReferenceOpen).toBe(false);
  });

  test("opens the shortcut reference for question mark on an empty prompt", () => {
    let shortcutReferenceOpen = false;
    let insertedText = "";
    const handler = createAppKeyboardHandler(
      createKeyboardDeps({
        composerInputOwner: () => "composer",
        insertPromptTextAtCursor: (text) => {
          insertedText += text;
          return true;
        },
        getTextareaText: () => insertedText,
        openNativeModal: (id) => {
          shortcutReferenceOpen = id === "shortcut-reference";
        },
      }),
    );

    handler({
      name: "?",
      sequence: "?",
      ctrl: false,
      meta: false,
      option: false,
      alt: false,
      preventDefault: () => {},
    });

    expect(insertedText).toBe("");
    expect(shortcutReferenceOpen).toBe(true);
  });

  test("ctrl+o does not toggle transcript details", () => {
    let prevented = false;
    const handler = createAppKeyboardHandler(createKeyboardDeps());

    handler({
      name: "o",
      sequence: "o",
      ctrl: true,
      shift: false,
      meta: false,
      option: false,
      alt: false,
      preventDefault: () => {
        prevented = true;
      },
    });

    expect(prevented).toBe(false);
  });

  test("ctrl+m cycles models forward", () => {
    const modelDirections: Array<1 | -1> = [];
    let prevented = false;
    const handler = createAppKeyboardHandler(
      createKeyboardDeps({
        cycleSessionModelFromKeyboard: (_app, direction) => {
          modelDirections.push(direction);
        },
      }),
    );

    handler({
      name: "m",
      sequence: "m",
      ctrl: true,
      shift: false,
      meta: false,
      option: false,
      alt: false,
      preventDefault: () => {
        prevented = true;
      },
    });

    expect(modelDirections).toEqual([1]);
    expect(prevented).toBe(true);
  });

  test("ctrl+shift+m cycles models backward", () => {
    const modelDirections: Array<1 | -1> = [];
    let prevented = false;
    const handler = createAppKeyboardHandler(
      createKeyboardDeps({
        cycleSessionModelFromKeyboard: (_app, direction) => {
          modelDirections.push(direction);
        },
      }),
    );

    handler({
      name: "M",
      sequence: "M",
      ctrl: true,
      shift: true,
      meta: false,
      option: false,
      alt: false,
      preventDefault: () => {
        prevented = true;
      },
    });

    expect(modelDirections).toEqual([-1]);
    expect(prevented).toBe(true);
  });

  test("ctrl+t and ctrl+shift+t cycle thinking levels", () => {
    const thinkingDirections: Array<1 | -1> = [];
    const handler = createAppKeyboardHandler(
      createKeyboardDeps({
        cycleSessionThinkingLevelFromKeyboard: (_app, direction) => {
          thinkingDirections.push(direction);
        },
      }),
    );

    handler({ name: "t", sequence: "t", ctrl: true, shift: false });
    handler({ name: "T", sequence: "T", ctrl: true, shift: true });

    expect(thinkingDirections).toEqual([1, -1]);
  });

  test("uses space to toggle plugins without typing into the prompt", () => {
    let toggled = 0;
    let prevented = false;
    const handler = createAppKeyboardHandler(
      createKeyboardDeps({
        isOverlayVisible: () => true,
        selectionMode: () => SelectionMode.PLUGINS,
        toggleSelectedPlugin: () => {
          toggled += 1;
        },
      }),
    );

    handler({
      name: "space",
      sequence: " ",
      ctrl: false,
      meta: false,
      option: false,
      alt: false,
      preventDefault: () => {
        prevented = true;
      },
    });

    expect(toggled).toBe(1);
    expect(prevented).toBe(true);
  });

  test("escape returns from plugin details to the plugin list", () => {
    let mode: SelectionMode | null = SelectionMode.PLUGIN_DETAILS;
    let hidden = false;
    let prevented = false;
    const handler = createAppKeyboardHandler(
      createKeyboardDeps({
        isOverlayVisible: () => true,
        selectionMode: () => mode,
        setSelectionMode: (nextMode) => {
          mode = nextMode;
        },
        openPluginsOverlay: () => {
          mode = SelectionMode.PLUGINS;
        },
        hideOverlay: () => {
          hidden = true;
        },
      }),
    );

    handler({
      name: "escape",
      sequence: "\u001b",
      ctrl: false,
      meta: false,
      option: false,
      alt: false,
      preventDefault: () => {
        prevented = true;
      },
    });

    expect(mode as string).toBe(SelectionMode.PLUGINS);
    expect(hidden).toBe(false);
    expect(prevented).toBe(true);
  });

  test("keeps an incomplete split mouse-report prefix pending past the old recovery window", async () => {
    let insertedText = "";
    const handler = createAppKeyboardHandler(
      createKeyboardDeps({
        composerInputOwner: () => "composer",
        insertPromptTextAtCursor: (text) => {
          insertedText += text;
          return true;
        },
      }),
    );

    handler({
      name: "<",
      sequence: "<",
      ctrl: false,
      meta: false,
      option: false,
      alt: false,
      preventDefault: () => {},
    });

    await waitPastOldSplitTailRecoveryWindow();

    expect(insertedText).toBe("");
  });

  test("flushes an incomplete split mouse-report prefix before non-printable input continues", async () => {
    let insertedText = "";
    const handler = createAppKeyboardHandler(
      createKeyboardDeps({
        composerInputOwner: () => "composer",
        insertPromptTextAtCursor: (text) => {
          insertedText += text;
          return true;
        },
      }),
    );

    handler({
      name: "<",
      sequence: "<",
      ctrl: false,
      meta: false,
      option: false,
      alt: false,
      preventDefault: () => {},
    });
    await waitPastOldSplitTailRecoveryWindow();
    handler({
      name: "return",
      sequence: "\r",
      ctrl: false,
      meta: false,
      option: false,
      alt: false,
      preventDefault: () => {},
    });

    expect(insertedText).toBe("<");
  });

  test("restores an incomplete split mouse-report prefix to the owner that received it", async () => {
    let owner: ComposerInputOwner = "queue";
    let queueFocused = true;
    let sidebarFocused = false;
    let insertedText = "";
    const handler = createAppKeyboardHandler(
      createKeyboardDeps({
        composerInputOwner: () => owner,
        setQueueFocusIndex: (index) => {
          queueFocused = index !== null;
        },
        exitQueueBrowse: () => {
          queueFocused = false;
        },
        setSidebarFocused: (focused) => {
          sidebarFocused = focused;
        },
        insertPromptTextAtCursor: (text) => {
          insertedText += text;
          return true;
        },
      }),
    );

    handler({
      name: "<",
      sequence: "<",
      ctrl: false,
      meta: false,
      option: false,
      alt: false,
      preventDefault: () => {},
    });
    owner = "sidebar";
    await waitPastOldSplitTailRecoveryWindow();
    handler({
      name: "return",
      sequence: "\r",
      ctrl: false,
      meta: false,
      option: false,
      alt: false,
      preventDefault: () => {},
    });

    expect(insertedText).toBe("<");
    expect(queueFocused).toBe(false);
    expect(sidebarFocused).toBe(false);
  });

  test("does not steer a retained queue selection when another input owner has focus", () => {
    const contextValue = createAppStateValue(process.cwd());
    contextValue.setState("pendingQueue", [{ id: "q1", text: "must remain queued" }]);
    contextValue.setState("running", true);
    let activeTurnInputCalls = 0;
    const client = { supportsActiveTurnInput: () => true } as AcpClient;
    dispatchKeyboardEvent("tab", {
      contextValue,
      composerInputOwner: () => "sidebar",
      queueFocusIndex: () => 0,
      sidebarFocused: () => true,
      acpClient: () => client,
      handleActiveTurnInput: () => {
        activeTurnInputCalls++;
      },
    });

    expect(contextValue.state.pendingQueue).toEqual([{ id: "q1", text: "must remain queued" }]);
    expect(activeTurnInputCalls).toBe(0);
  });

  test("routes keys to the focused plugin widget before global keybindings", async () => {
    const root = process.cwd();
    const events: string[] = [];
    const runner = new PluginRunner({ cwd: root });
    await runner.register({
      info: { id: "plugin", name: "plugin", path: "/plugin" },
      factory: (relay) => {
        relay.ui.showOverlay("picker", {
          onKey: (event) => {
            events.push(`widget:${event.name}:${event.printable ?? ""}`);
          },
          render: () => [{ text: "picker" }],
        });
        relay.keybindings.register("a", {
          run: () => {
            events.push("keybinding");
          },
        });
      },
    });
    let prevented = false;
    let stopped = false;
    const handler = createAppKeyboardHandler(
      createKeyboardDeps({
        pluginRunner: () => runner,
        pluginOverlayOpen: () => runner.slots.focusedKeyboardWidget() !== null,
      }),
    );

    handler({
      name: "a",
      sequence: "a",
      ctrl: false,
      meta: false,
      option: false,
      alt: false,
      preventDefault: () => {
        prevented = true;
      },
      stopPropagation: () => {
        stopped = true;
      },
    });

    expect(events).toEqual(["widget:a:a"]);
    expect(prevented).toBe(true);
    expect(stopped).toBe(true);
  });

  test("focused plugin widget can pass keys through to plugin keybindings", async () => {
    const root = process.cwd();
    const events: string[] = [];
    const runner = new PluginRunner({ cwd: root });
    await runner.register({
      info: { id: "plugin", name: "plugin", path: "/plugin" },
      factory: (relay) => {
        relay.ui.showOverlay("picker", {
          onKey: (event) => {
            events.push(`widget:${event.name}`);
            return false;
          },
          render: () => [{ text: "picker" }],
        });
        relay.keybindings.register("a", {
          run: () => {
            events.push("keybinding");
          },
        });
      },
    });
    let prevented = false;
    const handler = createAppKeyboardHandler(
      createKeyboardDeps({
        pluginRunner: () => runner,
        pluginOverlayOpen: () => runner.slots.focusedKeyboardWidget() !== null,
      }),
    );

    handler({
      name: "a",
      sequence: "a",
      ctrl: false,
      meta: false,
      option: false,
      alt: false,
      preventDefault: () => {
        prevented = true;
      },
    });

    expect(events).toEqual(["widget:a", "keybinding"]);
    expect(prevented).toBe(true);
  });

  test("focused plugin widget without onKey lets plugin keybindings run", async () => {
    const root = process.cwd();
    const events: string[] = [];
    const runner = new PluginRunner({ cwd: root });
    await runner.register({
      info: { id: "plugin", name: "plugin", path: "/plugin" },
      factory: (relay) => {
        relay.ui.showOverlay("picker", {
          render: () => [{ text: "picker" }],
        });
        relay.keybindings.register("a", {
          run: () => {
            events.push("keybinding");
          },
        });
      },
    });
    await runner.register({
      info: { id: "other", name: "other", path: "/other" },
      factory: (relay) => {
        relay.keybindings.register("a", {
          run: () => {
            events.push("other");
          },
        });
      },
    });
    let prevented = false;
    let stopped = false;
    const handler = createAppKeyboardHandler(
      createKeyboardDeps({
        pluginRunner: () => runner,
        pluginOverlayOpen: () => runner.slots.focusedKeyboardWidget() !== null,
      }),
    );

    handler({
      name: "a",
      sequence: "a",
      ctrl: false,
      meta: false,
      option: false,
      alt: false,
      preventDefault: () => {
        prevented = true;
      },
      stopPropagation: () => {
        stopped = true;
      },
    });

    expect(events).toEqual(["keybinding"]);
    expect(prevented).toBe(true);
    expect(stopped).toBe(true);
  });

  test("unfocused plugin overlay lets prompt input continue", async () => {
    const root = process.cwd();
    const events: string[] = [];
    let handle: RelayWidgetHandle | undefined;
    const runner = new PluginRunner({ cwd: root });
    await runner.register({
      info: { id: "plugin", name: "plugin", path: "/plugin" },
      factory: (relay) => {
        handle = relay.ui.showOverlay("picker", {
          onKey: () => {
            events.push("widget");
          },
          render: () => [{ text: "picker" }],
        });
      },
    });
    handle?.unfocus();
    let prevented = false;
    const handler = createAppKeyboardHandler(
      createKeyboardDeps({
        pluginRunner: () => runner,
        pluginOverlayOpen: () => runner.slots.focusedKeyboardWidget() !== null,
      }),
    );

    handler({
      name: "a",
      sequence: "a",
      ctrl: false,
      meta: false,
      option: false,
      alt: false,
      preventDefault: () => {
        prevented = true;
      },
    });

    expect(events).toEqual([]);
    expect(prevented).toBe(false);
  });

  test("escape calls onClose for a focused plugin widget without an onKey handler", async () => {
    const root = process.cwd();
    let closeCount = 0;
    const runner = new PluginRunner({ cwd: root });
    await runner.register({
      info: { id: "plugin", name: "plugin", path: "/plugin" },
      factory: (relay) => {
        relay.ui.showOverlay("picker", {
          onClose: () => {
            closeCount += 1;
          },
          render: () => [{ text: "picker" }],
        });
      },
    });
    let prevented = false;
    const handler = createAppKeyboardHandler(
      createKeyboardDeps({
        pluginRunner: () => runner,
        pluginOverlayOpen: () => runner.slots.focusedKeyboardWidget() !== null,
      }),
    );

    handler({
      name: "escape",
      sequence: "\u001b",
      ctrl: false,
      meta: false,
      option: false,
      alt: false,
      preventDefault: () => {
        prevented = true;
      },
    });

    expect(closeCount).toBe(1);
    expect(prevented).toBe(true);
  });

  test("does not restore adjacent printable input into blocked input owners", () => {
    const result = dispatchKeyboardEvent("<65;181;34Mignored", { composerInputOwner: () => "plugin" });

    expect(result.prevented).toBe(true);
    expect(result.stopped).toBe(true);
    expect(result.insertedText).toBe("");
  });

  test("still inserts ordinary printable input for soft composer owners", () => {
    const result = dispatchKeyboardEvent("a", { composerInputOwner: () => "queue" });

    expect(result.insertedText).toBe("a");
    expect(result.prevented).toBe(true);
    expect(result.stopped).toBe(false);
  });
});
