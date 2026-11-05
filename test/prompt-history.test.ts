import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resetConfig } from "../src/config";
import { PromptHistory } from "../src/prompt-history";

let tmpHome: string | null = null;
const originalHome = process.env.HOME;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;

function setupHistoryHome(): string {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "relay-prompt-history-test-"));
  process.env.HOME = tmpHome;
  delete process.env.XDG_CONFIG_HOME;
  resetConfig();
  return path.join(tmpHome, ".config", "relay", "prompt-history.jsonl");
}

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;

  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;

  resetConfig();
  if (tmpHome) fs.rmSync(tmpHome, { recursive: true, force: true });
  tmpHome = null;
});

describe("PromptHistory", () => {
  test("navigates the same newest-first global history regardless of session", () => {
    setupHistoryHome();
    const history = new PromptHistory();

    history.add("session-a first", undefined, "session-a");
    history.add("session-b only", undefined, "session-b");
    history.add("session-a second", undefined, "session-a");

    expect(history.navigate(-1, "", undefined, "session-a")?.text).toBe("session-a second");
    expect(history.navigate(-1, "", undefined, "session-a")?.text).toBe("session-b only");
    expect(history.navigate(-1, "", undefined, "session-a")?.text).toBe("session-a first");
    expect(history.navigate(-1, "", undefined, "session-a")).toBeNull();

    history.reset();
    expect(history.navigate(-1, "", undefined, "session-b")?.text).toBe("session-a second");
  });

  test("stores session ids while navigation still uses global history", () => {
    const historyPath = setupHistoryHome();
    const history = new PromptHistory();

    history.add("legacy-style", undefined, null);
    history.add("scoped", undefined, "session-1");

    expect(history.navigate(-1, "", undefined, null)?.text).toBe("scoped");
    expect(history.navigate(-1, "", undefined, null)?.text).toBe("legacy-style");

    const lines = fs
      .readFileSync(historyPath, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines[0].sessionId).toBeUndefined();
    expect(lines[1].sessionId).toBe("session-1");
  });

  test("restores the active draft after browsing", () => {
    setupHistoryHome();
    const history = new PromptHistory();

    history.add("older prompt", undefined, "session-a");
    history.add("newer prompt", undefined, "session-b");

    expect(history.navigate(-1, "draft text", { 7: "draft paste" }, "session-a")?.text).toBe("newer prompt");
    expect(history.navigate(1, "", undefined, "session-a")).toEqual({
      text: "draft text",
      pasteMappings: { 7: "draft paste" },
    });
    expect(history.isBrowsing()).toBe(false);
  });

  test("search entries are sorted newest first", () => {
    setupHistoryHome();
    const history = new PromptHistory();

    history.add("older prompt", undefined, "session-a");
    history.add("newer prompt", { 3: "newer paste" }, "session-b");

    expect(history.searchEntries().map((entry) => entry.text)).toEqual(["newer prompt", "older prompt"]);
    expect(history.searchEntries()[0].pasteMappings).toEqual({ 3: "newer paste" });
  });

  test("does not store slash command triggers", () => {
    const historyPath = setupHistoryHome();
    const history = new PromptHistory();

    history.add("regular prompt", undefined, "session-a");
    history.add("/resume", undefined, "session-a");
    history.add("  /new", undefined, "session-a");
    history.add("/theme dark", undefined, "session-a");

    expect(history.searchEntries().map((entry) => entry.text)).toEqual(["/theme dark", "regular prompt"]);
    expect(fs.readFileSync(historyPath, "utf-8").trim().split("\n")).toHaveLength(2);
  });

  test("deduplicates only when the latest stored prompt matches", () => {
    setupHistoryHome();
    const history = new PromptHistory();

    history.add("same", undefined, "session-a");
    history.add("same", undefined, "session-b");
    history.add("different", undefined, "session-a");
    history.add("same", undefined, "session-a");

    expect(history.searchEntries().map((entry) => entry.text)).toEqual(["same", "different", "same"]);
  });

  test("retains the latest 50 entries total", () => {
    setupHistoryHome();
    const history = new PromptHistory();

    for (let i = 0; i < 55; i++) {
      history.add(`prompt ${i}`, undefined, "session-a");
    }

    const entries = history.searchEntries();
    expect(entries).toHaveLength(50);
    expect(entries[0].text).toBe("prompt 54");
    expect(entries.at(-1)?.text).toBe("prompt 5");
  });

  test("loads existing over-limit history with total retention", () => {
    const historyPath = setupHistoryHome();
    fs.mkdirSync(path.dirname(historyPath), { recursive: true });
    const entries = Array.from({ length: 55 }, (_, i) => ({
      text: `prompt ${i}`,
      timestamp: "2025-01-01T00:00:00.000Z",
      sessionId: i % 2 === 0 ? "session-a" : "session-b",
    }));
    fs.writeFileSync(historyPath, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf-8");

    const history = new PromptHistory();

    const loaded = history.searchEntries();
    expect(loaded).toHaveLength(50);
    expect(loaded[0].text).toBe("prompt 54");
    expect(loaded.at(-1)?.text).toBe("prompt 5");
  });
});
