import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSignal } from "solid-js";
import { parseColor, type TextareaRenderable } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { promptInputText, type PromptInput } from "../../../src/core/prompt-submission";
import { Composer } from "../../../src/ui/component/composer";
import { getColors } from "../../../src/ui/context/theme";
import { AppContext } from "../../../src/ui/state";
import { Config, resetConfig, setConfig } from "../../../src/config";
import { createAppStateValue } from "../../../src/ui/context/app-state";
import { RelayPluginEditorRegistry } from "../../../src/plugins/editor";
import type { PluginRunner, RelayPluginInfo } from "../../../src/plugins";

const tmpRoots: string[] = [];

beforeEach(() => {
  setConfig(new Config({}));
});

function tmpWorkspace(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "relay-prompt-focus-"));
  tmpRoots.push(dir);
  return dir;
}

afterEach(() => {
  resetConfig();
  while (tmpRoots.length > 0) rmSync(tmpRoots.pop()!, { recursive: true, force: true });
});

async function waitFor(assertion: () => void | boolean | Promise<void | boolean>, timeoutMs = 1000): Promise<void> {
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

describe("Prompt focus", () => {
  test("renders the default prompt marker readably on the user panel", async () => {
    const cwd = tmpWorkspace();
    const contextValue = createAppStateValue(cwd);
    const colors = getColors();
    const app = await testRender(
      () => (
        <AppContext.Provider value={contextValue}>
          <Composer
            selectionMode={() => null}
            filterOverlayItems={() => {}}
            showOverlay={() => {}}
            hideOverlay={() => {}}
            isOverlayVisible={() => false}
            selectOverlayItem={() => {}}
            getVisibleSlashCommands={() => []}
            setActiveCompletion={() => {}}
            setTabCompleting={() => {}}
            consumeInputUpdateSource={() => null}
            onPromptTextChanged={() => {}}
            setTextareaRef={() => {}}
            resetDoublePressState={() => {}}
            currentSessionId={() => null}
            focused={() => false}
            handleSubmit={() => {}}
          />
        </AppContext.Provider>
      ),
      { width: 80, height: 8, targetFps: 30 },
    );

    try {
      await app.renderOnce();
      const spans = app.captureSpans().lines.flatMap((line) => line.spans);
      const oldPromptMarker = spans.find((span) => span.text.includes("#"));
      const defaultPromptMarker = spans.find((span) => span.text === "> ");
      const editableSurface = spans.find((span) => span.bg.toString() === parseColor(colors.panelUser).toString());

      expect(oldPromptMarker).toBeUndefined();
      expect(defaultPromptMarker).toBeDefined();
      expect(defaultPromptMarker?.fg.toString()).toBe(parseColor(colors.accent).toString());
      expect(editableSurface).toBeDefined();
    } finally {
      app.renderer.destroy();
    }
  });

  test("keeps the default prompt marker color stable as session mode loads", async () => {
    const cwd = tmpWorkspace();
    const contextValue = createAppStateValue(cwd);
    const colors = getColors();
    const markerColor = () =>
      app
        .captureSpans()
        .lines.flatMap((line) => line.spans)
        .find((span) => span.text === "> ")
        ?.fg.toString();
    let app: Awaited<ReturnType<typeof testRender>>;

    app = await testRender(
      () => (
        <AppContext.Provider value={contextValue}>
          <Composer
            selectionMode={() => null}
            filterOverlayItems={() => {}}
            showOverlay={() => {}}
            hideOverlay={() => {}}
            isOverlayVisible={() => false}
            selectOverlayItem={() => {}}
            getVisibleSlashCommands={() => []}
            setActiveCompletion={() => {}}
            setTabCompleting={() => {}}
            consumeInputUpdateSource={() => null}
            onPromptTextChanged={() => {}}
            setTextareaRef={() => {}}
            resetDoublePressState={() => {}}
            currentSessionId={() => null}
            handleSubmit={() => {}}
          />
        </AppContext.Provider>
      ),
      { width: 80, height: 8, targetFps: 30 },
    );

    try {
      await app.renderOnce();
      const initialColor = markerColor();
      expect(initialColor).toBe(parseColor(colors.accent).toString());

      contextValue.setState("modeId", "code");
      await waitFor(() => {
        app.renderOnce();
        expect(markerColor()).toBe(initialColor);
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("renders configured prompt marker on the user panel", async () => {
    setConfig(new Config({ ui: { prompt_marker: "❯" } }));
    const cwd = tmpWorkspace();
    const contextValue = createAppStateValue(cwd);
    const app = await testRender(
      () => (
        <AppContext.Provider value={contextValue}>
          <Composer
            selectionMode={() => null}
            filterOverlayItems={() => {}}
            showOverlay={() => {}}
            hideOverlay={() => {}}
            isOverlayVisible={() => false}
            selectOverlayItem={() => {}}
            getVisibleSlashCommands={() => []}
            setActiveCompletion={() => {}}
            setTabCompleting={() => {}}
            consumeInputUpdateSource={() => null}
            onPromptTextChanged={() => {}}
            setTextareaRef={() => {}}
            resetDoublePressState={() => {}}
            currentSessionId={() => null}
            focused={() => false}
            handleSubmit={() => {}}
          />
        </AppContext.Provider>
      ),
      { width: 80, height: 8, targetFps: 30 },
    );

    try {
      await app.renderOnce();
      const markerSpan = app
        .captureSpans()
        .lines.flatMap((line) => line.spans)
        .find((span) => span.text === "❯ ");

      expect(markerSpan).toBeDefined();
    } finally {
      app.renderer.destroy();
    }
  });

  test("hides the prompt marker when disabled", async () => {
    setConfig(new Config({ ui: { prompt_marker: "" } }));
    const cwd = tmpWorkspace();
    const contextValue = createAppStateValue(cwd);
    const app = await testRender(
      () => (
        <AppContext.Provider value={contextValue}>
          <Composer
            selectionMode={() => null}
            filterOverlayItems={() => {}}
            showOverlay={() => {}}
            hideOverlay={() => {}}
            isOverlayVisible={() => false}
            selectOverlayItem={() => {}}
            getVisibleSlashCommands={() => []}
            setActiveCompletion={() => {}}
            setTabCompleting={() => {}}
            consumeInputUpdateSource={() => null}
            onPromptTextChanged={() => {}}
            setTextareaRef={() => {}}
            resetDoublePressState={() => {}}
            currentSessionId={() => null}
            focused={() => false}
            handleSubmit={() => {}}
          />
        </AppContext.Provider>
      ),
      { width: 80, height: 8, targetFps: 30 },
    );

    try {
      await app.renderOnce();
      const spans = app.captureSpans().lines.flatMap((line) => line.spans);
      expect(spans.find((span) => span.text === "> ")).toBeUndefined();
    } finally {
      app.renderer.destroy();
    }
  });

  test("uses the prompt marker for bash prefixes and submits the original command prefix", async () => {
    const cwd = tmpWorkspace();
    const contextValue = createAppStateValue(cwd);
    let textareaRef: TextareaRenderable | null = null;
    let app: Awaited<ReturnType<typeof testRender>>;
    const submitted: PromptInput[] = [];
    const currentTextarea = () => {
      if (!textareaRef) throw new Error("Prompt textarea did not mount");
      return textareaRef;
    };
    const emitKey = (name: string) => {
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
      } as Parameters<typeof app.renderer.keyInput.emit>[1]);
    };
    const markerSpan = () =>
      app
        .captureSpans()
        .lines.flatMap((line) => line.spans)
        .find((span) => span.text === "> " || span.text === "! " || span.text === "!! ");
    const markerText = () => markerSpan()?.text;

    app = await testRender(
      () => (
        <AppContext.Provider value={contextValue}>
          <Composer
            selectionMode={() => null}
            filterOverlayItems={() => {}}
            showOverlay={() => {}}
            hideOverlay={() => {}}
            isOverlayVisible={() => false}
            selectOverlayItem={() => {}}
            getVisibleSlashCommands={() => []}
            setActiveCompletion={() => {}}
            setTabCompleting={() => {}}
            consumeInputUpdateSource={() => null}
            onPromptTextChanged={() => {}}
            setTextareaRef={(ref) => {
              textareaRef = ref as TextareaRenderable | null;
            }}
            resetDoublePressState={() => {}}
            currentSessionId={() => null}
            handleSubmit={(input) => submitted.push(input)}
          />
        </AppContext.Provider>
      ),
      { width: 80, height: 8, targetFps: 30 },
    );

    try {
      await waitFor(() => {
        app.renderOnce();
        expect(textareaRef).not.toBeNull();
        expect(markerText()).toBe("> ");
      });

      currentTextarea().insertText("!");
      await waitFor(() => {
        app.renderOnce();
        expect(currentTextarea().plainText).toBe("");
        expect(markerText()).toBe("! ");
        expect(markerSpan()?.fg.toString()).not.toBe(markerSpan()?.bg.toString());
        expect(contextValue.state.userBashMode).toBe(true);
      });

      currentTextarea().insertText("!");
      await waitFor(() => {
        app.renderOnce();
        expect(currentTextarea().plainText).toBe("");
        expect(markerText()).toBe("!! ");
      });

      emitKey("backspace");
      await waitFor(() => {
        app.renderOnce();
        expect(markerText()).toBe("> ");
        expect(contextValue.state.userBashMode).toBe(false);
      });

      currentTextarea().insertText("!!echo hi");
      await waitFor(() => {
        app.renderOnce();
        expect(currentTextarea().plainText).toBe("echo hi");
        expect(markerText()).toBe("!! ");
      });
      currentTextarea().submit();
      expect(submitted.map(promptInputText)).toEqual(["!!echo hi"]);
    } finally {
      app.renderer.destroy();
    }
  });

  test("blurs the textarea while input is suspended and restores focus after", async () => {
    const cwd = tmpWorkspace();
    const contextValue = createAppStateValue(cwd);
    const [inputSuspended, setInputSuspended] = createSignal(false);
    type FocusableTextarea = { focus: () => void; blur: () => void };
    let textareaRef: FocusableTextarea | null = null;
    let focusCalls = 0;
    let blurCalls = 0;
    const app = await testRender(
      () => (
        <AppContext.Provider value={contextValue}>
          <Composer
            selectionMode={() => null}
            filterOverlayItems={() => {}}
            showOverlay={() => {}}
            hideOverlay={() => {}}
            isOverlayVisible={() => false}
            selectOverlayItem={() => {}}
            getVisibleSlashCommands={() => []}
            setActiveCompletion={() => {}}
            setTabCompleting={() => {}}
            consumeInputUpdateSource={() => null}
            onPromptTextChanged={() => {}}
            setTextareaRef={(ref) => {
              if (!ref) {
                textareaRef = null;
                return;
              }
              const textarea = ref as FocusableTextarea;
              if (textareaRef !== textarea) {
                const originalFocus = textarea.focus.bind(textarea);
                const originalBlur = textarea.blur.bind(textarea);
                textarea.focus = () => {
                  focusCalls++;
                  originalFocus();
                };
                textarea.blur = () => {
                  blurCalls++;
                  originalBlur();
                };
              }
              textareaRef = textarea;
            }}
            resetDoublePressState={() => {}}
            currentSessionId={() => null}
            inputSuspended={inputSuspended}
            handleSubmit={() => {}}
          />
        </AppContext.Provider>
      ),
      { width: 80, height: 8, targetFps: 30 },
    );

    try {
      await waitFor(() => {
        app.renderOnce();
        expect(textareaRef).not.toBeNull();
      });

      const focusCallsBeforeSuspend = focusCalls;
      setInputSuspended(true);
      await waitFor(() => {
        app.renderOnce();
        expect(blurCalls).toBeGreaterThan(0);
        expect(focusCalls).toBe(focusCallsBeforeSuspend);
      });

      setInputSuspended(false);
      await waitFor(() => {
        app.renderOnce();
        expect(focusCalls).toBeGreaterThan(focusCallsBeforeSuspend);
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("preserves draft text while input is suspended", async () => {
    const cwd = tmpWorkspace();
    const contextValue = createAppStateValue(cwd);
    const [inputSuspended, setInputSuspended] = createSignal(false);
    let textareaRef: TextareaRenderable | null = null;
    const currentTextarea = () => {
      if (!textareaRef) throw new Error("Prompt textarea did not mount");
      return textareaRef;
    };

    const app = await testRender(
      () => (
        <AppContext.Provider value={contextValue}>
          <Composer
            selectionMode={() => null}
            filterOverlayItems={() => {}}
            showOverlay={() => {}}
            hideOverlay={() => {}}
            isOverlayVisible={() => false}
            selectOverlayItem={() => {}}
            getVisibleSlashCommands={() => []}
            setActiveCompletion={() => {}}
            setTabCompleting={() => {}}
            consumeInputUpdateSource={() => null}
            onPromptTextChanged={() => {}}
            setTextareaRef={(ref) => {
              textareaRef = ref as TextareaRenderable | null;
            }}
            resetDoublePressState={() => {}}
            currentSessionId={() => null}
            inputSuspended={inputSuspended}
            handleSubmit={() => {}}
          />
        </AppContext.Provider>
      ),
      { width: 80, height: 8, targetFps: 30 },
    );

    try {
      await waitFor(() => {
        app.renderOnce();
        expect(textareaRef).not.toBeNull();
      });

      currentTextarea().insertText("draft before modal");
      await waitFor(() => {
        app.renderOnce();
        expect(currentTextarea().plainText).toBe("draft before modal");
      });

      setInputSuspended(true);
      await waitFor(() => {
        app.renderOnce();
        expect(currentTextarea().showCursor).toBe(false);
        expect(currentTextarea().plainText).toBe("draft before modal");
      });

      currentTextarea().insertText(" ignored");
      await waitFor(() => {
        app.renderOnce();
        expect(currentTextarea().plainText).toBe("draft before modal");
      });

      setInputSuspended(false);
      await waitFor(() => {
        app.renderOnce();
        expect(currentTextarea().showCursor).toBe(true);
      });
      currentTextarea().insertText(" accepted");
      await waitFor(() => {
        app.renderOnce();
        expect(currentTextarea().plainText).toBe("draft before modal accepted");
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("keeps terminal cursor color after entering user bash mode", async () => {
    const cwd = tmpWorkspace();
    const contextValue = createAppStateValue(cwd);
    const colors = getColors();
    const terminalCursorColor = parseColor("#13579b");
    let textareaRef: TextareaRenderable | null = null;
    const currentTextarea = () => {
      if (!textareaRef) throw new Error("Prompt textarea did not mount");
      return textareaRef;
    };

    const app = await testRender(
      () => (
        <AppContext.Provider value={contextValue}>
          <Composer
            selectionMode={() => null}
            filterOverlayItems={() => {}}
            showOverlay={() => {}}
            hideOverlay={() => {}}
            isOverlayVisible={() => false}
            selectOverlayItem={() => {}}
            getVisibleSlashCommands={() => []}
            setActiveCompletion={() => {}}
            setTabCompleting={() => {}}
            consumeInputUpdateSource={() => null}
            onPromptTextChanged={() => {}}
            setTextareaRef={(ref) => {
              textareaRef = ref as TextareaRenderable | null;
            }}
            resetDoublePressState={() => {}}
            currentSessionId={() => null}
            handleSubmit={() => {}}
          />
        </AppContext.Provider>
      ),
      { width: 80, height: 8, targetFps: 30 },
    );

    try {
      await waitFor(() => {
        app.renderOnce();
        expect(textareaRef).not.toBeNull();
      });
      app.renderer.setCursorStyle({ color: terminalCursorColor });
      currentTextarea().insertText("!!");
      await waitFor(() => {
        app.renderOnce();
        expect(contextValue.state.userBashMode).toBe(true);
        expect(app.renderer.getCursorState().color.toString()).toBe(terminalCursorColor.toString());
        expect(app.renderer.getCursorState().color.toString()).not.toBe(parseColor(colors.fg).toString());
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("uses native cursor style and hides the cursor while disabled", async () => {
    const cwd = tmpWorkspace();
    const contextValue = createAppStateValue(cwd);
    const [focused, setFocused] = createSignal(true);
    const [vimMode, setVimMode] = createSignal<"insert" | "normal" | null>(null);
    let textareaRef: TextareaRenderable | null = null;
    const currentTextarea = () => {
      if (!textareaRef) throw new Error("Prompt textarea did not mount");
      return textareaRef;
    };

    const app = await testRender(
      () => (
        <AppContext.Provider value={contextValue}>
          <Composer
            selectionMode={() => null}
            filterOverlayItems={() => {}}
            showOverlay={() => {}}
            hideOverlay={() => {}}
            isOverlayVisible={() => false}
            selectOverlayItem={() => {}}
            getVisibleSlashCommands={() => []}
            setActiveCompletion={() => {}}
            setTabCompleting={() => {}}
            consumeInputUpdateSource={() => null}
            onPromptTextChanged={() => {}}
            setTextareaRef={(ref) => {
              textareaRef = ref as TextareaRenderable | null;
            }}
            resetDoublePressState={() => {}}
            currentSessionId={() => null}
            focused={focused}
            vimStatus={() => {
              const mode = vimMode();
              return mode ? { mode, pending: "" } : null;
            }}
            handleSubmit={() => {}}
          />
        </AppContext.Provider>
      ),
      { width: 80, height: 8, targetFps: 30 },
    );

    try {
      await waitFor(() => {
        app.renderOnce();
        expect(textareaRef).not.toBeNull();
      });

      expect(currentTextarea().cursorStyle.style).toBe("default");
      expect(currentTextarea().cursorStyle.blinking).toBe(true);
      expect(currentTextarea().showCursor).toBe(true);

      setVimMode("insert");
      await waitFor(() => {
        app.renderOnce();
        expect(currentTextarea().cursorStyle.style).toBe("line");
        expect(currentTextarea().cursorStyle.blinking).toBe(false);
      });

      setVimMode("normal");
      await waitFor(() => {
        app.renderOnce();
        expect(currentTextarea().cursorStyle.style).toBe("default");
        expect(currentTextarea().cursorStyle.blinking).toBe(true);
      });

      setFocused(false);
      await waitFor(() => {
        app.renderOnce();
        expect(currentTextarea().showCursor).toBe(false);
      });

      setFocused(true);
      await waitFor(() => {
        app.renderOnce();
        expect(currentTextarea().showCursor).toBe(true);
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("keeps OpenTUI cursor positioning intact below prior content", async () => {
    const cwd = tmpWorkspace();
    const contextValue = createAppStateValue(cwd);
    type CursorRenderableTextarea = TextareaRenderable & { renderCursor?: unknown };
    let textareaRef: CursorRenderableTextarea | null = null;
    let nativeRenderCursor: unknown;
    const currentTextarea = () => {
      if (!textareaRef) throw new Error("Prompt textarea did not mount");
      return textareaRef;
    };

    const app = await testRender(
      () => (
        <AppContext.Provider value={contextValue}>
          <box flexDirection="column" width="100%" height="100%">
            <box width="100%" height={3}>
              <text>{"Then run:"}</text>
            </box>
            <Composer
              selectionMode={() => null}
              filterOverlayItems={() => {}}
              showOverlay={() => {}}
              hideOverlay={() => {}}
              isOverlayVisible={() => false}
              selectOverlayItem={() => {}}
              getVisibleSlashCommands={() => []}
              setActiveCompletion={() => {}}
              setTabCompleting={() => {}}
              consumeInputUpdateSource={() => null}
              onPromptTextChanged={() => {}}
              setTextareaRef={(ref) => {
                const textarea = ref as CursorRenderableTextarea | null;
                if (textarea && nativeRenderCursor === undefined) nativeRenderCursor = textarea.renderCursor;
                textareaRef = textarea;
              }}
              resetDoublePressState={() => {}}
              currentSessionId={() => null}
              handleSubmit={() => {}}
            />
          </box>
        </AppContext.Provider>
      ),
      { width: 80, height: 12, targetFps: 30 },
    );

    try {
      await waitFor(() => {
        app.renderOnce();
        expect(textareaRef).not.toBeNull();
        expect(typeof nativeRenderCursor).toBe("function");
        expect(currentTextarea().renderCursor as unknown).toBe(nativeRenderCursor);
        const cursor = app.renderer.getCursorState();
        expect(cursor.visible).toBe(true);
        expect(cursor.y).toBeGreaterThan(1);
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("honors explicit plugin cursor color override", async () => {
    const cwd = tmpWorkspace();
    const contextValue = createAppStateValue(cwd);
    const pluginCursorColor = "#40c4ff";
    const pluginRunner = {
      editor: {
        state: () => ({
          options: {},
          theme: { cursorColor: pluginCursorColor },
          autocompleteProviders: [],
        }),
        listAutocompleteProviders: () => [],
      },
    } as unknown as PluginRunner;
    let textareaRef: TextareaRenderable | null = null;

    const app = await testRender(
      () => (
        <AppContext.Provider value={contextValue}>
          <Composer
            selectionMode={() => null}
            filterOverlayItems={() => {}}
            showOverlay={() => {}}
            hideOverlay={() => {}}
            isOverlayVisible={() => false}
            selectOverlayItem={() => {}}
            getVisibleSlashCommands={() => []}
            setActiveCompletion={() => {}}
            setTabCompleting={() => {}}
            consumeInputUpdateSource={() => null}
            onPromptTextChanged={() => {}}
            setTextareaRef={(ref) => {
              textareaRef = ref as TextareaRenderable | null;
            }}
            resetDoublePressState={() => {}}
            currentSessionId={() => null}
            pluginRunner={() => pluginRunner}
            handleSubmit={() => {}}
          />
        </AppContext.Provider>
      ),
      { width: 80, height: 8, targetFps: 30 },
    );

    try {
      await waitFor(() => {
        app.renderOnce();
        expect(textareaRef).not.toBeNull();
        expect(app.renderer.getCursorState().color.toString()).toBe(parseColor(pluginCursorColor).toString());
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("returns to terminal-owned cursor color after plugin override is disposed", async () => {
    const cwd = tmpWorkspace();
    const contextValue = createAppStateValue(cwd);
    const pluginInfo: RelayPluginInfo = { id: "cursor-plugin", name: "cursor-plugin", path: "/cursor-plugin" };
    const pluginCursorColor = "#40c4ff";
    const editor = new RelayPluginEditorRegistry();
    const cursorTheme = editor.setTheme(pluginInfo, { cursorColor: pluginCursorColor });
    const [pluginRevision, setPluginRevision] = createSignal(0);
    const pluginRunner = {
      editor: {
        state: () => editor.state(),
        listAutocompleteProviders: () => [],
      },
    } as unknown as PluginRunner;
    let textareaRef: TextareaRenderable | null = null;
    const terminalCursorWrites: string[] = [];
    let writeOutCaptured = false;
    let promptRenderRequests = 0;
    let requestRenderCaptured = false;
    const currentTextarea = () => {
      if (!textareaRef) throw new Error("Prompt textarea did not mount");
      return textareaRef;
    };
    const recordPromptWriteOut = () => {
      if (writeOutCaptured) return;
      const ctx = Reflect.get(currentTextarea() as unknown as Record<PropertyKey, unknown>, "_ctx");
      if (!ctx || typeof ctx !== "object") throw new Error("Prompt textarea render context did not mount");
      const promptContext = ctx as { writeOut?: (data: string) => unknown };
      const originalWriteOut = promptContext.writeOut;
      promptContext.writeOut = (data: string) => {
        terminalCursorWrites.push(data);
        return originalWriteOut?.call(promptContext, data);
      };
      writeOutCaptured = true;
    };
    const recordPromptRequestRender = () => {
      if (requestRenderCaptured) return;
      const textarea = currentTextarea() as unknown as { requestRender?: () => unknown };
      const originalRequestRender = textarea.requestRender?.bind(textarea);
      textarea.requestRender = () => {
        promptRenderRequests++;
        return originalRequestRender?.();
      };
      requestRenderCaptured = true;
    };

    const app = await testRender(
      () => (
        <AppContext.Provider value={contextValue}>
          <Composer
            selectionMode={() => null}
            filterOverlayItems={() => {}}
            showOverlay={() => {}}
            hideOverlay={() => {}}
            isOverlayVisible={() => false}
            selectOverlayItem={() => {}}
            getVisibleSlashCommands={() => []}
            setActiveCompletion={() => {}}
            setTabCompleting={() => {}}
            consumeInputUpdateSource={() => null}
            onPromptTextChanged={() => {}}
            setTextareaRef={(ref) => {
              textareaRef = ref as TextareaRenderable | null;
            }}
            resetDoublePressState={() => {}}
            currentSessionId={() => null}
            pluginRunner={() => pluginRunner}
            pluginRevision={pluginRevision}
            handleSubmit={() => {}}
          />
        </AppContext.Provider>
      ),
      { width: 80, height: 8, targetFps: 30 },
    );

    try {
      await waitFor(() => {
        app.renderOnce();
        expect(textareaRef).not.toBeNull();
        expect(app.renderer.getCursorState().color.toString()).toBe(parseColor(pluginCursorColor).toString());
      });
      recordPromptWriteOut();
      recordPromptRequestRender();
      terminalCursorWrites.length = 0;

      cursorTheme.dispose();
      setPluginRevision((revision) => revision + 1);

      await waitFor(() => {
        app.renderOnce();
        const openTuiCursorColor = Reflect.get(
          currentTextarea() as unknown as Record<PropertyKey, unknown>,
          "_cursorColor",
        );
        expect(openTuiCursorColor).toBeUndefined();
        expect(terminalCursorWrites).toContain("\x1b]112\x07");
        expect(promptRenderRequests).toBeGreaterThan(0);
      });

      const renderRequestsAfterTransition = promptRenderRequests;
      const textareaWithoutFocus = currentTextarea() as unknown as { focus?: () => unknown };
      textareaWithoutFocus.focus = () => undefined;
      setPluginRevision((revision) => revision + 1);

      await waitFor(() => {
        app.renderOnce();
        expect(promptRenderRequests).toBe(renderRequestsAfterTransition);
      });
    } finally {
      app.renderer.destroy();
    }
  });
});
