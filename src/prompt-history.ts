import * as path from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "./platform/fs";
import { ensureConfigDir } from "./config";
import { isoNow } from "./platform/time";

const MAX_ENTRIES = 50;

interface PromptHistoryEntry {
  text: string;
  timestamp: string;
  sessionId?: string;
  pasteMappings?: Record<number, string>;
}

export interface HistoryNavigationResult {
  text: string;
  pasteMappings?: Record<number, string>;
}

export interface PromptHistorySearchEntry extends HistoryNavigationResult {
  timestamp: string;
  sessionId?: string;
}

export interface HistoryNavigationOptions {
  sessionId?: string | null;
  allowGlobalContinuation?: boolean;
}

export class PromptHistory {
  private entries: PromptHistoryEntry[] = [];
  private scopedEntries: PromptHistoryEntry[] = [];
  private currentIndex: number = -1;
  private draftText: string = "";
  private draftPasteMappings: Record<number, string> | undefined = undefined;
  private filePath: string;

  constructor() {
    this.filePath = path.join(ensureConfigDir(), "prompt-history.jsonl");
    this.load();
  }

  private load(): void {
    if (!existsSync(this.filePath)) {
      this.entries = [];
      return;
    }

    try {
      const content = readFileSync(this.filePath, "utf-8");
      const lines = content.split("\n").filter((line) => line.trim().length > 0);

      this.entries = [];
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as PromptHistoryEntry;
          if (entry.text && entry.text.trim().length > 0) {
            const nextEntry: PromptHistoryEntry = {
              text: entry.text,
              timestamp: entry.timestamp ?? isoNow(),
              pasteMappings: entry.pasteMappings,
            };
            if (typeof entry.sessionId === "string" && entry.sessionId.length > 0) {
              nextEntry.sessionId = entry.sessionId;
            }
            this.entries.push(nextEntry);
          }
        } catch {
          // Skip malformed lines
        }
      }

      this.enforceRetentionLimit();
    } catch {
      this.entries = [];
    }
  }

  private save(): void {
    const dir = path.dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const lines = this.entries.map((entry) => JSON.stringify(entry));
    writeFileSync(this.filePath, lines.join("\n") + "\n", "utf-8");
  }

  add(text: string, pasteMappings?: Record<number, string>, sessionId?: string | null): void {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    if (trimmed.startsWith("/") && !/\s/.test(trimmed)) return;

    const lastEntry = this.entries[this.entries.length - 1];
    if (lastEntry?.text === trimmed) {
      return;
    }

    const entry: PromptHistoryEntry = {
      text: trimmed,
      timestamp: isoNow(),
    };
    if (sessionId) {
      entry.sessionId = sessionId;
    }
    if (pasteMappings && Object.keys(pasteMappings).length > 0) {
      entry.pasteMappings = pasteMappings;
    }
    this.entries.push(entry);

    this.enforceRetentionLimit();

    this.save();
    this.reset();
  }

  navigate(
    direction: -1 | 1,
    currentText: string,
    currentPasteMappings?: Record<number, string>,
    optionsOrSessionId?: HistoryNavigationOptions | string | null,
  ): HistoryNavigationResult | null {
    if (this.entries.length === 0) return null;

    const options = this.navigationOptions(optionsOrSessionId);

    if (this.currentIndex === -1 && direction === -1) {
      this.scopedEntries = this.entriesForNavigation(options);
      if (this.scopedEntries.length === 0) return null;
      this.draftText = currentText;
      this.draftPasteMappings = currentPasteMappings;
      this.currentIndex = this.scopedEntries.length;
    }

    const entries = this.scopedEntries;
    if (entries.length === 0) return null;

    const newIndex = this.currentIndex + direction;

    if (direction === -1) {
      if (newIndex < 0) return null;
      this.currentIndex = newIndex;
      const entry = entries[this.currentIndex];
      return { text: entry.text, pasteMappings: entry.pasteMappings };
    }

    if (direction === 1) {
      if (this.currentIndex === -1) return null;

      if (newIndex >= entries.length) {
        this.currentIndex = -1;
        this.scopedEntries = [];
        return { text: this.draftText, pasteMappings: this.draftPasteMappings };
      }

      this.currentIndex = newIndex;
      const entry = entries[this.currentIndex];
      return { text: entry.text, pasteMappings: entry.pasteMappings };
    }

    return null;
  }

  cancelBrowsing(): HistoryNavigationResult | null {
    if (this.currentIndex === -1) return null;
    const result = { text: this.draftText, pasteMappings: this.draftPasteMappings };
    this.reset();
    return result;
  }

  reset(): void {
    this.currentIndex = -1;
    this.scopedEntries = [];
    this.draftText = "";
    this.draftPasteMappings = undefined;
  }

  isBrowsing(): boolean {
    return this.currentIndex !== -1;
  }

  searchEntries(optionsOrSessionId?: HistoryNavigationOptions | string | null): PromptHistorySearchEntry[] {
    const options = this.navigationOptions(optionsOrSessionId);
    return this.entriesForNavigation(options)
      .slice()
      .reverse()
      .map((entry) => ({
        text: entry.text,
        timestamp: entry.timestamp,
        sessionId: entry.sessionId,
        pasteMappings: entry.pasteMappings,
      }));
  }

  private navigationOptions(optionsOrSessionId?: HistoryNavigationOptions | string | null): HistoryNavigationOptions {
    if (typeof optionsOrSessionId === "string") return { sessionId: optionsOrSessionId };
    if (optionsOrSessionId === null) return { sessionId: null };
    return optionsOrSessionId ?? {};
  }

  private entriesForNavigation(_options: HistoryNavigationOptions): PromptHistoryEntry[] {
    return this.entries;
  }

  private enforceRetentionLimit(): void {
    this.entries = this.entries.slice(-MAX_ENTRIES);
  }
}
