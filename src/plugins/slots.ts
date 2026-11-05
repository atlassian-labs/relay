import type {
  Disposable,
  RelayEditorChromeElementRenderContext,
  RelayEditorChromeElementRenderer,
  RelayEditorChromeRenderContext,
  RelayEditorFooterRenderer,
  RelayEditorFooterSegment,
  RelayEditorHeaderRenderer,
  RelayEditorSegmentContent,
  RelayEditorSegmentRenderContext,
  RelayEditorStatusSegment,
  RelayLine,
  RelayPluginInfo,
  RelayPluginStatus,
  RelayPluginStatusValue,
  RelayWidget,
  RelayWidgetHandle,
  RelayWidgetPlacement,
} from "./types";

export interface RelayEditorStatusEntry {
  readonly plugin: RelayPluginInfo;
  readonly key: string;
  readonly value: RelayPluginStatusValue;
}

export interface RelayWidgetEntry {
  readonly plugin: RelayPluginInfo;
  readonly key: string;
  readonly widget: RelayWidget;
  readonly order: number;
  readonly focused: boolean;
  readonly hidden: boolean;
}

type RelayEditorSegment = RelayEditorStatusSegment | RelayEditorFooterSegment;

interface RelayEditorSegmentEntry<T extends RelayEditorSegment> {
  readonly plugin: RelayPluginInfo;
  readonly key: string;
  readonly segment: T;
  readonly order: number;
}

export type RelayEditorStatusSegmentEntry = RelayEditorSegmentEntry<RelayEditorStatusSegment>;
export type RelayEditorFooterSegmentEntry = RelayEditorSegmentEntry<RelayEditorFooterSegment>;

type RelayEditorChromeRenderer = RelayEditorHeaderRenderer | RelayEditorFooterRenderer;

interface RelayEditorChromeRendererEntry<T extends RelayEditorChromeRenderer> {
  readonly plugin: RelayPluginInfo;
  readonly renderer: T;
  readonly order: number;
}

interface RelayEditorChromeElementRendererEntry {
  readonly plugin: RelayPluginInfo;
  readonly renderer: RelayEditorChromeElementRenderer;
  readonly order: number;
}

type RelayEditorChromeErrorHandler = (plugin: RelayPluginInfo, error: unknown) => void;

export class RelayPluginSlotRegistry {
  private readonly editorStatus = new Map<string, RelayEditorStatusEntry>();
  private readonly widgetEntries = new Map<string, RelayWidgetEntry>();
  private readonly editorStatusSegmentEntries = new Map<string, RelayEditorStatusSegmentEntry>();
  private readonly editorFooterSegmentEntries = new Map<string, RelayEditorFooterSegmentEntry>();
  private readonly editorHeaderRendererEntries = new Map<
    string,
    RelayEditorChromeRendererEntry<RelayEditorHeaderRenderer>
  >();
  private readonly editorFooterRendererEntries = new Map<
    string,
    RelayEditorChromeRendererEntry<RelayEditorFooterRenderer>
  >();
  private readonly editorChromeElementRendererEntries = new Map<string, RelayEditorChromeElementRendererEntry>();
  private order = 0;

  setEditorStatus(plugin: RelayPluginInfo, key: string, value: RelayPluginStatusValue | undefined): boolean {
    const id = scopedKey(plugin, key);
    const previous = this.editorStatus.get(id);
    if (value === undefined) {
      return this.editorStatus.delete(id);
    }
    if (previous?.value === value) return false;
    this.editorStatus.set(id, { plugin, key, value });
    return true;
  }

  setWidget(plugin: RelayPluginInfo, key: string, widget: RelayWidget | undefined): boolean {
    const id = scopedKey(plugin, key);
    if (widget === undefined) return this.removeWidget(plugin, key);

    const previous = this.widgetEntries.get(id);
    const hidden = previous?.hidden ?? false;
    const shouldFocus =
      !hidden && isKeyboardWidget(widget) && (previous ? previous.focused || !isKeyboardWidget(previous.widget) : true);
    if (shouldFocus) this.clearWidgetFocus();
    this.widgetEntries.set(id, {
      plugin,
      key,
      widget,
      order: ++this.order,
      hidden,
      focused: shouldFocus ? true : previous?.focused === true && !hidden && isKeyboardWidget(widget),
    });
    return true;
  }

  removeWidget(plugin: RelayPluginInfo, key: string): boolean {
    const id = scopedKey(plugin, key);
    const removed = this.widgetEntries.get(id);
    if (!removed) return false;
    this.widgetEntries.delete(id);
    if (removed.focused) this.focusTopKeyboardWidget();
    return true;
  }

  focusWidget(plugin: RelayPluginInfo, key: string): boolean {
    const id = scopedKey(plugin, key);
    const entry = this.widgetEntries.get(id);
    if (!entry) return false;
    const alreadyFocused = entry.focused && !entry.hidden;
    if (alreadyFocused) return false;
    this.clearWidgetFocus();
    this.widgetEntries.set(id, { ...entry, focused: true, hidden: false });
    return true;
  }

  unfocusWidget(plugin: RelayPluginInfo, key: string): boolean {
    const id = scopedKey(plugin, key);
    const entry = this.widgetEntries.get(id);
    if (!entry || !entry.focused) return false;
    this.widgetEntries.set(id, { ...entry, focused: false });
    return true;
  }

  setWidgetHidden(plugin: RelayPluginInfo, key: string, hidden: boolean): boolean {
    const id = scopedKey(plugin, key);
    const entry = this.widgetEntries.get(id);
    if (!entry || entry.hidden === hidden) return false;
    this.widgetEntries.set(id, { ...entry, hidden, focused: hidden ? false : entry.focused });
    if (hidden && entry.focused) this.focusTopKeyboardWidget();
    return true;
  }

  widgetState(
    plugin: RelayPluginInfo,
    key: string,
  ): (Pick<RelayWidgetHandle, "focused" | "hidden"> & { readonly placement: RelayWidgetPlacement }) | null {
    const entry = this.widgetEntries.get(scopedKey(plugin, key));
    if (!entry) return null;
    return { focused: entry.focused, hidden: entry.hidden, placement: entry.widget.placement };
  }

  setEditorStatusSegment(plugin: RelayPluginInfo, key: string, segment: RelayEditorStatusSegment | undefined): void {
    this.setEditorSegment(this.editorStatusSegmentEntries, plugin, key, segment);
  }

  setEditorFooterSegment(plugin: RelayPluginInfo, key: string, segment: RelayEditorFooterSegment | undefined): void {
    this.setEditorSegment(this.editorFooterSegmentEntries, plugin, key, segment);
  }

  registerEditorHeaderRenderer(plugin: RelayPluginInfo, renderer: RelayEditorHeaderRenderer): Disposable {
    return this.registerEditorChromeRenderer(this.editorHeaderRendererEntries, plugin, renderer, "header-renderer");
  }

  registerEditorFooterRenderer(plugin: RelayPluginInfo, renderer: RelayEditorFooterRenderer): Disposable {
    return this.registerEditorChromeRenderer(this.editorFooterRendererEntries, plugin, renderer, "footer-renderer");
  }

  registerEditorChromeElementRenderer(plugin: RelayPluginInfo, renderer: RelayEditorChromeElementRenderer): Disposable {
    const key = `${plugin.id}:chrome-element-renderer:${++this.order}`;
    this.editorChromeElementRendererEntries.set(key, { plugin, renderer, order: this.order });
    return { dispose: () => this.editorChromeElementRendererEntries.delete(key) };
  }

  renderEditorHeader(
    ctx: RelayEditorChromeRenderContext,
    onError?: RelayEditorChromeErrorHandler,
  ): readonly RelayLine[] | null {
    return renderEditorChrome(this.editorHeaderRendererEntries, ctx, onError);
  }

  renderEditorFooter(
    ctx: RelayEditorChromeRenderContext,
    onError?: RelayEditorChromeErrorHandler,
  ): readonly RelayLine[] | null {
    return renderEditorChrome(this.editorFooterRendererEntries, ctx, onError);
  }

  renderEditorChromeElement(
    ctx: RelayEditorChromeElementRenderContext,
    onError?: RelayEditorChromeErrorHandler,
  ): RelayLine {
    let line = ctx.line;
    for (const entry of [...this.editorChromeElementRendererEntries.values()].toSorted((a, b) => a.order - b.order)) {
      if (entry.renderer.elements && !entry.renderer.elements.includes(ctx.element)) continue;
      try {
        const rendered = entry.renderer.render({ ...ctx, line });
        if (rendered) line = rendered;
      } catch (error) {
        onError?.(entry.plugin, error);
      }
    }
    return line;
  }

  editorStatusSegments(): readonly RelayPluginStatus[] {
    return [...this.editorStatus.values()]
      .map((segment) => resolveStatusValue(segment.value))
      .filter((segment) => segment.text.length > 0);
  }

  widgets(placement: RelayWidget["placement"]): readonly RelayWidgetEntry[] {
    return [...this.widgetEntries.values()]
      .filter((entry) => !entry.hidden && entry.widget.placement === placement)
      .toSorted(compareWidgetEntries);
  }

  focusedKeyboardWidget(): RelayWidgetEntry | null {
    const focused = [...this.widgetEntries.values()]
      .filter((entry) => !entry.hidden && entry.focused && isKeyboardWidget(entry.widget))
      .toSorted(compareWidgetEntries);
    return focused.at(-1) ?? null;
  }

  editorStatusSegmentContents(ctx?: RelayEditorSegmentRenderContext): readonly RelayEditorSegmentContent[] {
    return renderEditorSegments(this.editorStatusSegmentEntries, ctx);
  }

  editorFooterSegmentContents(ctx?: RelayEditorSegmentRenderContext): readonly RelayEditorSegmentContent[] {
    return renderEditorSegments(this.editorFooterSegmentEntries, ctx);
  }

  clearPlugin(pluginId: string): void {
    for (const key of [...this.editorStatus.keys()]) if (key.startsWith(`${pluginId}:`)) this.editorStatus.delete(key);
    let removedFocusedWidget = false;
    for (const key of [...this.widgetEntries.keys()]) {
      if (!key.startsWith(`${pluginId}:`)) continue;
      removedFocusedWidget ||= this.widgetEntries.get(key)?.focused === true;
      this.widgetEntries.delete(key);
    }
    if (removedFocusedWidget) this.focusTopKeyboardWidget();
    for (const key of [...this.editorStatusSegmentEntries.keys()]) {
      if (key.startsWith(`${pluginId}:`)) this.editorStatusSegmentEntries.delete(key);
    }
    for (const key of [...this.editorFooterSegmentEntries.keys()]) {
      if (key.startsWith(`${pluginId}:`)) this.editorFooterSegmentEntries.delete(key);
    }
    clearPluginEntries(this.editorHeaderRendererEntries, pluginId);
    clearPluginEntries(this.editorFooterRendererEntries, pluginId);
    clearPluginEntries(this.editorChromeElementRendererEntries, pluginId);
  }

  clear(): void {
    this.editorStatus.clear();
    this.widgetEntries.clear();
    this.editorStatusSegmentEntries.clear();
    this.editorFooterSegmentEntries.clear();
    this.editorHeaderRendererEntries.clear();
    this.editorFooterRendererEntries.clear();
    this.editorChromeElementRendererEntries.clear();
  }

  private registerEditorChromeRenderer<T extends RelayEditorChromeRenderer>(
    entries: Map<string, RelayEditorChromeRendererEntry<T>>,
    plugin: RelayPluginInfo,
    renderer: T,
    kind: string,
  ): Disposable {
    const key = `${plugin.id}:${kind}:${++this.order}`;
    entries.set(key, { plugin, renderer, order: this.order });
    return { dispose: () => entries.delete(key) };
  }

  private setEditorSegment<T extends RelayEditorSegment>(
    entries: Map<string, RelayEditorSegmentEntry<T>>,
    plugin: RelayPluginInfo,
    key: string,
    segment: T | undefined,
  ): void {
    const id = scopedKey(plugin, key);
    if (segment === undefined) entries.delete(id);
    else entries.set(id, { plugin, key, segment, order: ++this.order });
  }

  private clearWidgetFocus(): void {
    for (const [id, entry] of this.widgetEntries) {
      if (entry.focused) this.widgetEntries.set(id, { ...entry, focused: false });
    }
  }

  private focusTopKeyboardWidget(): void {
    const top = [...this.widgetEntries.values()]
      .filter((entry) => !entry.hidden && isKeyboardWidget(entry.widget))
      .toSorted(compareWidgetEntries)
      .at(-1);
    if (!top) return;
    this.widgetEntries.set(scopedKey(top.plugin, top.key), { ...top, focused: true });
  }
}

export function normalizeRelayLines(lines: readonly RelayLine[]): readonly RelayLine[] {
  return lines.filter((line) => line.text.length > 0 || typeof line.markdown === "string");
}

export function normalizeRelayWidgetPlacement(placement: RelayWidgetPlacement): RelayWidgetPlacement {
  return placement;
}

function renderEditorSegments<T extends RelayEditorSegment>(
  entries: Map<string, RelayEditorSegmentEntry<T>>,
  ctx?: RelayEditorSegmentRenderContext,
): readonly RelayEditorSegmentContent[] {
  return [...entries.values()]
    .toSorted((a, b) => (a.segment.priority ?? 0) - (b.segment.priority ?? 0) || a.order - b.order)
    .map((entry) => entry.segment.render(ctx));
}

function renderEditorChrome<T extends RelayEditorChromeRenderer>(
  entries: Map<string, RelayEditorChromeRendererEntry<T>>,
  ctx: RelayEditorChromeRenderContext,
  onError?: RelayEditorChromeErrorHandler,
): readonly RelayLine[] | null {
  for (const entry of [...entries.values()].toSorted((a, b) => a.order - b.order)) {
    try {
      const output = entry.renderer.render(ctx);
      if (output !== null) return output;
    } catch (error) {
      onError?.(entry.plugin, error);
    }
  }
  return null;
}

function clearPluginEntries<T extends { readonly plugin: RelayPluginInfo }>(
  entries: Map<string, T>,
  pluginId: string,
): void {
  for (const [key, entry] of entries) if (entry.plugin.id === pluginId) entries.delete(key);
}

function resolveStatusValue(value: RelayPluginStatusValue): RelayPluginStatus {
  const resolved = typeof value === "function" ? value() : value;
  return typeof resolved === "string" ? { text: resolved } : resolved;
}

function scopedKey(plugin: RelayPluginInfo, key: string): string {
  return `${plugin.id}:${key.trim()}`;
}

function isKeyboardWidget(widget: RelayWidget): boolean {
  return widget.placement === "modal" || widget.placement === "overlay";
}

function compareWidgetEntries(a: RelayWidgetEntry, b: RelayWidgetEntry): number {
  return (a.widget.priority ?? 0) - (b.widget.priority ?? 0) || a.order - b.order;
}
