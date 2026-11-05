import { createSignal } from "solid-js";
import type {
  RelayPluginConfirmDialogOptions,
  RelayPluginEditorDialogOptions,
  RelayPluginInfo,
  RelayPluginInputDialogOptions,
  RelayPluginSelectDialogOptions,
  RelayPluginSelectOption,
} from "../../plugins";
import { isEnterKey } from "../util/key-events";
import { printableInputFromEvent } from "./printable-input";

export interface PluginDialogKeyboardEvent {
  name?: string;
  sequence?: unknown;
  ctrl?: boolean;
  meta?: boolean;
  option?: boolean;
  alt?: boolean;
  shift?: boolean;
  preventDefault?: () => void;
  stopPropagation?: () => void;
}

export interface PluginDialogBaseState {
  readonly id: number;
  readonly plugin: RelayPluginInfo;
  readonly title: string;
  readonly expiresAt?: number;
}

export interface PluginDialogConfirmState extends PluginDialogBaseState {
  readonly kind: "confirm";
  readonly message: string;
  readonly selectedIndex: number;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
}

export interface PluginDialogNormalizedSelectItem {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

export interface PluginDialogSelectState extends PluginDialogBaseState {
  readonly kind: "select";
  readonly items: readonly PluginDialogNormalizedSelectItem[];
  readonly selectedIndex: number;
}

export interface PluginDialogInputState extends PluginDialogBaseState {
  readonly kind: "input";
  readonly placeholder: string;
  readonly value: string;
  readonly cursorOffset: number;
}

export interface PluginDialogEditorState extends PluginDialogBaseState {
  readonly kind: "editor";
  readonly value: string;
  readonly cursorOffset: number;
}

export type PluginDialogState =
  | PluginDialogConfirmState
  | PluginDialogSelectState
  | PluginDialogInputState
  | PluginDialogEditorState;

type DialogResult = boolean | string | undefined;
type TimeoutHandle = ReturnType<typeof setTimeout>;

type RequestMeta<T> = {
  readonly timeoutMs?: number;
  timeoutHandle?: TimeoutHandle;
  removeAbortListener?: () => void;
  resolve(result: T): void;
  readonly timeoutResult: T;
  readonly cancelResult: T;
};

type PluginDialogRequest =
  | (PluginDialogConfirmState & RequestMeta<boolean>)
  | (PluginDialogSelectState & RequestMeta<string | undefined>)
  | (PluginDialogInputState & RequestMeta<string | undefined>)
  | (PluginDialogEditorState & RequestMeta<string | undefined>);

export interface PluginDialogController {
  current(): PluginDialogState | null;
  active(): boolean;
  handleKey(event: PluginDialogKeyboardEvent): boolean;
  cancelActive(): void;
  clearPlugin(plugin: RelayPluginInfo): void;
  confirm(
    plugin: RelayPluginInfo,
    title: string,
    message: string,
    options?: RelayPluginConfirmDialogOptions,
  ): Promise<boolean>;
  select(
    plugin: RelayPluginInfo,
    title: string,
    options: readonly RelayPluginSelectOption[],
    dialogOptions?: RelayPluginSelectDialogOptions,
  ): Promise<string | undefined>;
  input(
    plugin: RelayPluginInfo,
    title: string,
    placeholder?: string,
    options?: RelayPluginInputDialogOptions,
  ): Promise<string | undefined>;
  editor(
    plugin: RelayPluginInfo,
    title: string,
    prefill?: string,
    options?: RelayPluginEditorDialogOptions,
  ): Promise<string | undefined>;
}

export function createPluginDialogController(): PluginDialogController {
  const [activeRequest, setActiveRequest] = createSignal<PluginDialogRequest | null>(null);
  const queue: PluginDialogRequest[] = [];
  let nextId = 1;

  function current(): PluginDialogState | null {
    return activeRequest();
  }

  function active(): boolean {
    return activeRequest() !== null;
  }

  function enqueueRequest(request: PluginDialogRequest, signal?: AbortSignal): void {
    if (signal?.aborted) {
      resolveRequest(request, request.cancelResult);
      return;
    }

    if (signal) {
      const onAbort = () => finishById(request.id, "cancel");
      signal.addEventListener("abort", onAbort, { once: true });
      request.removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    }

    if (activeRequest()) {
      queue.push(request);
      return;
    }

    activateRequest(request);
  }

  function activateRequest(request: PluginDialogRequest): void {
    if (request.timeoutMs !== undefined) {
      const expiresAt = Date.now() + request.timeoutMs;
      const withExpiry = { ...request, expiresAt } as PluginDialogRequest;
      const handle = setTimeout(() => finishById(withExpiry.id, "timeout"), request.timeoutMs);
      unrefTimer(handle);
      withExpiry.timeoutHandle = handle;
      setActiveRequest(withExpiry);
      return;
    }
    setActiveRequest(request);
  }

  function activateNext(): void {
    const next = queue.shift();
    if (next) activateRequest(next);
  }

  function cleanupRequest(request: PluginDialogRequest): void {
    if (request.timeoutHandle) clearTimeout(request.timeoutHandle);
    request.removeAbortListener?.();
    request.timeoutHandle = undefined;
    request.removeAbortListener = undefined;
  }

  function finishById(id: number, reason: "cancel" | "timeout"): void {
    const request = activeRequest();
    if (request?.id === id) {
      finishActiveWithResult(reason === "timeout" ? request.timeoutResult : request.cancelResult);
      return;
    }

    const queuedIndex = queue.findIndex((queued) => queued.id === id);
    if (queuedIndex < 0) return;
    const [queued] = queue.splice(queuedIndex, 1);
    if (!queued) return;
    cleanupRequest(queued);
    resolveRequest(queued, reason === "timeout" ? queued.timeoutResult : queued.cancelResult);
  }

  function finishActiveWithResult(result: DialogResult): void {
    const request = activeRequest();
    if (!request) return;
    cleanupRequest(request);
    setActiveRequest(null);
    resolveRequest(request, result);
    activateNext();
  }

  function updateActiveRequest(update: (request: PluginDialogRequest) => PluginDialogRequest): void {
    const request = activeRequest();
    if (!request) return;
    setActiveRequest(update(request));
  }

  function confirm(
    plugin: RelayPluginInfo,
    title: string,
    message: string,
    options?: RelayPluginConfirmDialogOptions,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const defaultValue = options?.defaultValue ?? false;
      const request: PluginDialogRequest = {
        id: nextId++,
        kind: "confirm",
        plugin,
        title,
        message,
        selectedIndex: defaultValue ? 1 : 0,
        confirmLabel: options?.confirmLabel ?? "Confirm",
        cancelLabel: options?.cancelLabel ?? "Cancel",
        timeoutMs: normalizedTimeout(options?.timeoutMs),
        resolve,
        timeoutResult: defaultValue,
        cancelResult: false,
      };
      enqueueRequest(request, options?.signal);
    });
  }

  function select(
    plugin: RelayPluginInfo,
    title: string,
    options: readonly RelayPluginSelectOption[],
    dialogOptions?: RelayPluginSelectDialogOptions,
  ): Promise<string | undefined> {
    return new Promise((resolve) => {
      const items = options.map(normalizeSelectOption);
      const request: PluginDialogRequest = {
        id: nextId++,
        kind: "select",
        plugin,
        title,
        items,
        selectedIndex: 0,
        timeoutMs: normalizedTimeout(dialogOptions?.timeoutMs),
        resolve,
        timeoutResult: undefined,
        cancelResult: undefined,
      };
      enqueueRequest(request, dialogOptions?.signal);
    });
  }

  function input(
    plugin: RelayPluginInfo,
    title: string,
    placeholder = "",
    options?: RelayPluginInputDialogOptions,
  ): Promise<string | undefined> {
    return new Promise((resolve) => {
      const value = options?.defaultValue ?? "";
      const request: PluginDialogRequest = {
        id: nextId++,
        kind: "input",
        plugin,
        title,
        placeholder,
        value,
        cursorOffset: value.length,
        timeoutMs: normalizedTimeout(options?.timeoutMs),
        resolve,
        timeoutResult: undefined,
        cancelResult: undefined,
      };
      enqueueRequest(request, options?.signal);
    });
  }

  function editor(
    plugin: RelayPluginInfo,
    title: string,
    prefill = "",
    options?: RelayPluginEditorDialogOptions,
  ): Promise<string | undefined> {
    return new Promise((resolve) => {
      const request: PluginDialogRequest = {
        id: nextId++,
        kind: "editor",
        plugin,
        title,
        value: prefill,
        cursorOffset: prefill.length,
        timeoutMs: normalizedTimeout(options?.timeoutMs),
        resolve,
        timeoutResult: undefined,
        cancelResult: undefined,
      };
      enqueueRequest(request, options?.signal);
    });
  }

  function cancelActive(): void {
    const request = activeRequest();
    if (!request) return;
    finishActiveWithResult(request.cancelResult);
  }

  function clearPlugin(plugin: RelayPluginInfo): void {
    let request = activeRequest();
    while (request?.plugin.id === plugin.id) {
      finishActiveWithResult(request.cancelResult);
      request = activeRequest();
    }
    for (const queued of [...queue]) {
      if (queued.plugin.id === plugin.id) finishById(queued.id, "cancel");
    }
  }

  function handleKey(event: PluginDialogKeyboardEvent): boolean {
    const request = activeRequest();
    if (!request) return false;
    consumeEvent(event);
    switch (request.kind) {
      case "confirm":
        handleConfirmKey(request, event);
        return true;
      case "select":
        handleSelectKey(request, event);
        return true;
      case "input":
        handleInputKey(request, event);
        return true;
      case "editor":
        handleEditorKey(request, event);
        return true;
    }
  }

  function handleConfirmKey(request: PluginDialogConfirmState, event: PluginDialogKeyboardEvent): void {
    const keyName = normalizedKeyName(event);
    if (isCancelKey(event)) {
      finishActiveWithResult(false);
      return;
    }
    const printable = printableInputFromEvent(event);
    if (printable?.toLowerCase() === "y") {
      finishActiveWithResult(true);
      return;
    }
    if (printable?.toLowerCase() === "n") {
      finishActiveWithResult(false);
      return;
    }
    if (isEnterKey(event)) {
      finishActiveWithResult(request.selectedIndex === 1);
      return;
    }
    if (keyName === "left" || keyName === "arrowleft" || keyName === "up") {
      updateActiveRequest((active) => (active.kind === "confirm" ? { ...active, selectedIndex: 0 } : active));
      return;
    }
    if (keyName === "right" || keyName === "arrowright" || keyName === "down") {
      updateActiveRequest((active) => (active.kind === "confirm" ? { ...active, selectedIndex: 1 } : active));
      return;
    }
    if (keyName === "tab") {
      updateActiveRequest((active) =>
        active.kind === "confirm" ? { ...active, selectedIndex: active.selectedIndex === 0 ? 1 : 0 } : active,
      );
    }
  }

  function handleSelectKey(request: PluginDialogSelectState, event: PluginDialogKeyboardEvent): void {
    const keyName = normalizedKeyName(event);
    if (isCancelKey(event)) {
      finishActiveWithResult(undefined);
      return;
    }
    if (isEnterKey(event)) {
      finishActiveWithResult(request.items[request.selectedIndex]?.value);
      return;
    }
    const count = request.items.length;
    if (keyName === "down" || keyName === "tab") updateSelectIndex(1);
    else if (keyName === "up") updateSelectIndex(-1);
    else if (keyName === "pagedown") updateSelectIndex(5);
    else if (keyName === "pageup") updateSelectIndex(-5);
    else if (keyName === "home") setSelectIndex(0);
    else if (keyName === "end") setSelectIndex(Math.max(0, count - 1));
  }

  function updateSelectIndex(delta: number): void {
    updateActiveRequest((active) => {
      if (active.kind !== "select") return active;
      return { ...active, selectedIndex: wrappedIndex(active.selectedIndex, delta, active.items.length) };
    });
  }

  function setSelectIndex(index: number): void {
    updateActiveRequest((active) => (active.kind === "select" ? { ...active, selectedIndex: index } : active));
  }

  function handleInputKey(request: PluginDialogInputState, event: PluginDialogKeyboardEvent): void {
    if (isCancelKey(event)) {
      finishActiveWithResult(undefined);
      return;
    }
    if (isEnterKey(event)) {
      finishActiveWithResult(request.value);
      return;
    }
    const edited = editTextByKey(request.value, request.cursorOffset, event, false);
    if (!edited) return;
    updateActiveRequest((active) =>
      active.kind === "input" ? { ...active, value: edited.text, cursorOffset: edited.cursorOffset } : active,
    );
  }

  function handleEditorKey(request: PluginDialogEditorState, event: PluginDialogKeyboardEvent): void {
    if (isCancelKey(event)) {
      finishActiveWithResult(undefined);
      return;
    }
    if (event.ctrl && isEnterKey(event)) {
      finishActiveWithResult(request.value);
      return;
    }
    if (isEnterKey(event)) {
      const inserted = insertTextAt(request.value, request.cursorOffset, "\n");
      updateActiveRequest((active) =>
        active.kind === "editor" ? { ...active, value: inserted.text, cursorOffset: inserted.cursorOffset } : active,
      );
      return;
    }
    const edited = editTextByKey(request.value, request.cursorOffset, event, true);
    if (!edited) return;
    updateActiveRequest((active) =>
      active.kind === "editor" ? { ...active, value: edited.text, cursorOffset: edited.cursorOffset } : active,
    );
  }

  return {
    current,
    active,
    handleKey,
    cancelActive,
    clearPlugin,
    confirm,
    select,
    input,
    editor,
  };
}

function normalizedTimeout(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value)) return undefined;
  return Math.max(0, Math.floor(value));
}

function unrefTimer(handle: TimeoutHandle): void {
  if (typeof handle !== "object" || handle === null || !("unref" in handle)) return;
  const unref = (handle as { unref?: () => void }).unref;
  if (typeof unref === "function") unref.call(handle);
}

function normalizeSelectOption(option: RelayPluginSelectOption): PluginDialogNormalizedSelectItem {
  if (typeof option === "string") return { value: option, label: option };
  return {
    value: option.value,
    label: option.label ?? option.value,
    ...(option.description ? { description: option.description } : {}),
  };
}

function resolveRequest(request: PluginDialogRequest, result: DialogResult): void {
  switch (request.kind) {
    case "confirm":
      request.resolve(typeof result === "boolean" ? result : false);
      return;
    case "select":
    case "input":
    case "editor":
      request.resolve(typeof result === "string" ? result : undefined);
      return;
  }
}

function consumeEvent(event: PluginDialogKeyboardEvent): void {
  event.preventDefault?.();
  event.stopPropagation?.();
}

function normalizedKeyName(event: PluginDialogKeyboardEvent): string {
  return String(event.name ?? "").toLowerCase();
}

function isCancelKey(event: PluginDialogKeyboardEvent): boolean {
  const keyName = normalizedKeyName(event);
  return keyName === "escape" || (event.ctrl === true && keyName === "c");
}

function wrappedIndex(index: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  return (((index + delta) % count) + count) % count;
}

function editTextByKey(
  text: string,
  cursorOffset: number,
  event: PluginDialogKeyboardEvent,
  multiline: boolean,
): { readonly text: string; readonly cursorOffset: number } | null {
  const keyName = normalizedKeyName(event);
  const cursor = clampCursor(text, cursorOffset);
  const option = event.option === true || event.alt === true;
  if (event.ctrl && keyName === "a") return { text, cursorOffset: multiline ? lineStartOffset(text, cursor) : 0 };
  if (event.ctrl && keyName === "e")
    return { text, cursorOffset: multiline ? lineEndOffset(text, cursor) : text.length };
  if (event.meta && (keyName === "left" || keyName === "arrowleft"))
    return { text, cursorOffset: multiline ? lineStartOffset(text, cursor) : 0 };
  if (event.meta && (keyName === "right" || keyName === "arrowright"))
    return { text, cursorOffset: multiline ? lineEndOffset(text, cursor) : text.length };
  if (option && (keyName === "left" || keyName === "arrowleft"))
    return { text, cursorOffset: previousWordOffset(text, cursor) };
  if (option && (keyName === "right" || keyName === "arrowright"))
    return { text, cursorOffset: nextWordOffset(text, cursor) };
  if (keyName === "left" || keyName === "arrowleft") return { text, cursorOffset: Math.max(0, cursor - 1) };
  if (keyName === "right" || keyName === "arrowright") return { text, cursorOffset: Math.min(text.length, cursor + 1) };
  if (keyName === "home") return { text, cursorOffset: multiline ? lineStartOffset(text, cursor) : 0 };
  if (keyName === "end") return { text, cursorOffset: multiline ? lineEndOffset(text, cursor) : text.length };
  if (multiline && keyName === "up") return { text, cursorOffset: moveCursorVertically(text, cursor, -1) };
  if (multiline && keyName === "down") return { text, cursorOffset: moveCursorVertically(text, cursor, 1) };
  if (event.meta && keyName === "backspace")
    return deleteTextRange(text, multiline ? lineStartOffset(text, cursor) : 0, cursor);
  if (option && keyName === "backspace") return deleteTextRange(text, previousWordOffset(text, cursor), cursor);
  if (event.ctrl && keyName === "w") return deleteTextRange(text, previousWordOffset(text, cursor), cursor);
  if (event.meta && (keyName === "delete" || keyName === "del"))
    return deleteTextRange(text, cursor, multiline ? lineEndOffset(text, cursor) : text.length);
  if (option && (keyName === "delete" || keyName === "del"))
    return deleteTextRange(text, cursor, nextWordOffset(text, cursor));
  if (keyName === "backspace") return backspaceTextAt(text, cursor);
  if (keyName === "delete" || keyName === "del") return deleteTextAt(text, cursor);
  if (multiline && keyName === "tab") return insertTextAt(text, cursor, "  ");
  const printable = printableInputFromEvent(event);
  if (printable === null) return null;
  return insertTextAt(text, cursor, printable);
}

function clampCursor(text: string, cursorOffset: number): number {
  return Math.max(0, Math.min(text.length, cursorOffset));
}

function insertTextAt(
  text: string,
  cursorOffset: number,
  insertText: string,
): { readonly text: string; readonly cursorOffset: number } {
  const cursor = clampCursor(text, cursorOffset);
  return {
    text: `${text.slice(0, cursor)}${insertText}${text.slice(cursor)}`,
    cursorOffset: cursor + insertText.length,
  };
}

function backspaceTextAt(text: string, cursorOffset: number): { readonly text: string; readonly cursorOffset: number } {
  const cursor = clampCursor(text, cursorOffset);
  if (cursor <= 0) return { text, cursorOffset: 0 };
  return {
    text: `${text.slice(0, cursor - 1)}${text.slice(cursor)}`,
    cursorOffset: cursor - 1,
  };
}

function deleteTextAt(text: string, cursorOffset: number): { readonly text: string; readonly cursorOffset: number } {
  const cursor = clampCursor(text, cursorOffset);
  if (cursor >= text.length) return { text, cursorOffset: cursor };
  return {
    text: `${text.slice(0, cursor)}${text.slice(cursor + 1)}`,
    cursorOffset: cursor,
  };
}

function deleteTextRange(
  text: string,
  startOffset: number,
  endOffset: number,
): { readonly text: string; readonly cursorOffset: number } {
  const start = clampCursor(text, Math.min(startOffset, endOffset));
  const end = clampCursor(text, Math.max(startOffset, endOffset));
  return { text: `${text.slice(0, start)}${text.slice(end)}`, cursorOffset: start };
}

function previousWordOffset(text: string, cursorOffset: number): number {
  let cursor = clampCursor(text, cursorOffset);
  while (cursor > 0 && wordCharacterClass(text[cursor - 1] ?? "") === "space") cursor -= 1;
  const characterClass = wordCharacterClass(text[cursor - 1] ?? "");
  while (cursor > 0 && wordCharacterClass(text[cursor - 1] ?? "") === characterClass) cursor -= 1;
  return cursor;
}

function nextWordOffset(text: string, cursorOffset: number): number {
  let cursor = clampCursor(text, cursorOffset);
  while (cursor < text.length && wordCharacterClass(text[cursor] ?? "") === "space") cursor += 1;
  const characterClass = wordCharacterClass(text[cursor] ?? "");
  while (cursor < text.length && wordCharacterClass(text[cursor] ?? "") === characterClass) cursor += 1;
  return cursor;
}

function wordCharacterClass(character: string): "space" | "word" | "punctuation" {
  if (/\s/u.test(character)) return "space";
  if (/[\p{L}\p{N}_]/u.test(character)) return "word";
  return "punctuation";
}

function lineStartOffset(text: string, cursorOffset: number): number {
  return text.lastIndexOf("\n", Math.max(0, cursorOffset - 1)) + 1;
}

function lineEndOffset(text: string, cursorOffset: number): number {
  const nextNewline = text.indexOf("\n", cursorOffset);
  return nextNewline < 0 ? text.length : nextNewline;
}

function moveCursorVertically(text: string, cursorOffset: number, delta: -1 | 1): number {
  const cursor = clampCursor(text, cursorOffset);
  const currentStart = lineStartOffset(text, cursor);
  const currentColumn = cursor - currentStart;
  if (delta < 0) {
    if (currentStart <= 0) return cursor;
    const previousEnd = currentStart - 1;
    const previousStart = lineStartOffset(text, previousEnd);
    return Math.min(previousStart + currentColumn, previousEnd);
  }

  const currentEnd = lineEndOffset(text, cursor);
  if (currentEnd >= text.length) return cursor;
  const nextStart = currentEnd + 1;
  const nextEnd = lineEndOffset(text, nextStart);
  return Math.min(nextStart + currentColumn, nextEnd);
}
