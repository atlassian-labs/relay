import type { Disposable, RelayKeybinding, RelayPluginInfo } from "./types";

export interface RegisteredRelayKeybinding {
  readonly plugin: RelayPluginInfo;
  readonly key: string;
  readonly binding: RelayKeybinding;
}

export interface RelayKeyEventLike {
  readonly name?: unknown;
  readonly sequence?: unknown;
  readonly ctrl?: unknown;
  readonly meta?: unknown;
  readonly alt?: unknown;
  readonly shift?: unknown;
}

export interface RelayKeybindingMatchOptions {
  readonly pluginId?: string;
}

export class RelayPluginKeybindingRegistry {
  private readonly bindings = new Map<string, RegisteredRelayKeybinding>();
  private order = 0;

  register(plugin: RelayPluginInfo, key: string, binding: RelayKeybinding): Disposable {
    const normalized = normalizePluginKeybinding(key);
    const mapKey = `${plugin.id}:keybinding:${++this.order}`;
    this.bindings.set(mapKey, { plugin, key: normalized, binding });
    return { dispose: () => this.bindings.delete(mapKey) };
  }

  match(event: RelayKeyEventLike, options: RelayKeybindingMatchOptions = {}): RegisteredRelayKeybinding | undefined {
    const normalized = normalizeKeyEvent(event);
    if (!normalized) return undefined;
    return [...this.bindings.values()]
      .toReversed()
      .find(
        (entry) =>
          entry.key === normalized &&
          (options.pluginId === undefined || entry.plugin.id === options.pluginId) &&
          (entry.binding.enabled?.() ?? true),
      );
  }

  list(): readonly RegisteredRelayKeybinding[] {
    return [...this.bindings.values()];
  }

  clearPlugin(pluginId: string): void {
    for (const key of [...this.bindings.keys()]) if (key.startsWith(`${pluginId}:`)) this.bindings.delete(key);
  }

  clear(): void {
    this.bindings.clear();
  }
}

export function normalizePluginKeybinding(key: string): string {
  return key
    .trim()
    .toLowerCase()
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean)
    .sort((a, b) => modifierRank(a) - modifierRank(b))
    .join("+");
}

function normalizeKeyEvent(event: RelayKeyEventLike): string | null {
  const rawName = event.name === null || event.name === undefined ? "" : String(event.name);
  const fromSequence = rawName ? null : printableSequenceKey(event.sequence);
  const name = (rawName || fromSequence || "").toLowerCase();
  if (!name) return null;
  const parts: string[] = [];
  if (event.ctrl) parts.push("ctrl");
  if (event.meta) parts.push("meta");
  if (event.alt) parts.push("alt");
  if (event.shift && (rawName || /^[a-z0-9]$/i.test(name))) parts.push("shift");
  parts.push(normalizeKeyName(name));
  return parts.join("+");
}

function printableSequenceKey(sequence: unknown): string | null {
  if (typeof sequence !== "string") return null;
  const chars = Array.from(sequence);
  if (chars.length !== 1) return null;
  const [char] = chars;
  const codePoint = char?.codePointAt(0);
  if (codePoint === undefined || codePoint < 0x20 || codePoint === 0x7f) return null;
  return char;
}

function normalizeKeyName(name: string): string {
  if (name === "return") return "enter";
  if (name === "esc") return "escape";
  if (name === "arrowleft") return "left";
  if (name === "arrowright") return "right";
  if (name === "arrowup") return "up";
  if (name === "arrowdown") return "down";
  return name;
}

function modifierRank(part: string): number {
  if (part === "ctrl") return 0;
  if (part === "meta") return 1;
  if (part === "alt") return 2;
  if (part === "shift") return 3;
  return 4;
}
