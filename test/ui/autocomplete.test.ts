import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  applyFileCompletion,
  applyPluginCompletion,
  applyPluginCompletionSelection,
  applySlashCompletion,
  buildPluginAutocompleteCompletion,
  buildSlashCommandArgumentCompletion,
  getFileSuggestions,
  getRelayAutocompleteContext,
  getSlashCommandArgumentTarget,
  getSlashSuggestions,
  PathCompleter,
  type ListItem,
  type SlashCommand,
} from "../../src/ui/autocomplete";
import { getReasoningEffortSuggestions } from "../../src/ui/util/reasoning-effort";

describe("autocomplete", () => {
  test("suggests and applies slash command completions", () => {
    const completion = getSlashSuggestions("/thr");

    expect(completion).not.toBeNull();
    expect(completion!.items[0]).toMatchObject({ label: "/threads" });
    expect(applySlashCompletion("/thr", completion!, completion!.items[0])).toBe("/threads ");
  });

  test("suggests Relay-owned local commands", () => {
    const settingsCompletion = getSlashSuggestions("/set");
    expect(settingsCompletion?.items).toContainEqual(
      expect.objectContaining({ label: "/settings", description: "open interactive settings" }),
    );
    const pluginsCompletion = getSlashSuggestions("/plug");
    expect(pluginsCompletion?.items).toContainEqual(
      expect.objectContaining({ label: "/plugins", description: "toggle relay plugins" }),
    );
    const diffCompletion = getSlashSuggestions("/di");
    expect(diffCompletion?.items).toContainEqual(
      expect.objectContaining({ label: "/diff", description: "show working tree diff" }),
    );
    expect(getSlashSuggestions("/eff")?.items).toContainEqual(
      expect.objectContaining({ label: "/effort", description: "set thinking level" }),
    );
  });

  test("suggests suffixed duplicate plugin commands", () => {
    const commands: SlashCommand[] = [
      { name: "shared:1", description: "first plugin command" },
      { name: "shared:2", description: "second plugin command" },
    ];

    const completion = getSlashSuggestions("/shared", commands);

    expect(completion?.items.map((item) => item.label)).toEqual(["/shared:1", "/shared:2"]);
    expect(applySlashCompletion("/shared", completion!, completion!.items[1]!)).toBe("/shared:2 ");
  });

  test("does not keep slash completion active for unknown commands", () => {
    expect(getSlashSuggestions("/thiswontsend")).toBeNull();
  });

  test("does not suggest slash commands away from command position", () => {
    const commands: SlashCommand[] = [
      { name: "review", description: "Agent-owned command" },
      { name: "plain", description: "Plain agent command" },
    ];

    expect(getSlashSuggestions("please /re", commands)).toBeNull();
  });

  test("suggests file and folder completions for @ tokens", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "relay-autocomplete-"));
    try {
      fs.mkdirSync(path.join(cwd, "src"));
      fs.writeFileSync(path.join(cwd, "README.md"), "hello");
      fs.writeFileSync(path.join(cwd, "src", "app.ts"), "export {};\n");

      const fileCompletion = getFileSuggestions("inspect @READ", cwd);
      expect(fileCompletion).not.toBeNull();
      const readme = fileCompletion!.items.find((item) => item.label === "README.md");
      expect(readme).toBeDefined();
      expect(applyFileCompletion("inspect @READ", fileCompletion!, readme!, cwd)).toBe("inspect @README.md ");

      const folderCompletion = getFileSuggestions("open @src", cwd);
      expect(folderCompletion).not.toBeNull();
      const srcDir = folderCompletion!.items.find((item) => item.label === "src/");
      expect(srcDir).toBeDefined();
      expect(applyFileCompletion("open @src", folderCompletion!, srcDir!, cwd)).toBe("open @src/");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("keeps file completion active with zero matches", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "relay-autocomplete-"));
    try {
      fs.writeFileSync(path.join(cwd, "README.md"), "hello");

      const fileCompletion = getFileSuggestions("inspect @zzzz", cwd);

      expect(fileCompletion).not.toBeNull();
      expect(fileCompletion?.items).toEqual([]);
      expect(fileCompletion?.query).toBe("zzzz");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("applies file completions using relative paths", () => {
    const selected: ListItem<string> = {
      value: "/tmp/project/src/index.ts",
      label: "index.ts",
      description: "src",
    };

    expect(
      applyFileCompletion(
        "read @ind now",
        { items: [selected], tokenStart: 5, query: "ind" },
        selected,
        "/tmp/project",
      ),
    ).toBe("read @src/index.ts  now");
  });

  test("applies plugin completions by replacing the active trigger token", () => {
    const selected: ListItem<{ readonly insertText?: string }> = {
      value: { insertText: "@workspace" },
      label: "workspace",
      description: "",
    };

    expect(applyPluginCompletion("@", { items: [selected], tokenStart: 0, query: "@", kind: "plugin" }, selected)).toBe(
      "@workspace",
    );
    expect(
      applyPluginCompletion("@foo", { items: [selected], tokenStart: 0, query: "@foo", kind: "plugin" }, selected),
    ).toBe("@workspace");
    expect(
      applyPluginCompletion("ask @foo", { items: [selected], tokenStart: 4, query: "@foo", kind: "plugin" }, selected),
    ).toBe("ask @workspace");
  });

  test("suggests advertised reasoning effort values after /effort", () => {
    const levels = [
      { id: "low", name: "Low" },
      { id: "high", name: "High", description: "More deliberate" },
    ];

    const completion = getReasoningEffortSuggestions("/effort ", levels, "low");

    expect(completion).not.toBeNull();
    expect(completion?.kind).toBe("slash-argument");
    expect(completion?.items.map((item) => item.label)).toEqual(["low", "high"]);
    expect(completion?.items[0]).toMatchObject({ active: true, description: "Low · current" });

    const filtered = getReasoningEffortSuggestions("/effort h", levels, "low");
    expect(filtered?.items.map((item) => item.label)).toEqual(["high"]);
    expect(applyPluginCompletion("/effort h", filtered!, filtered!.items[0]!)).toBe("/effort high");
  });

  test("builds v2 autocomplete context at the multiline cursor", () => {
    const text = "first line\nfix #12 now";
    const cursorOffset = "first line\nfix #12".length;

    expect(getRelayAutocompleteContext(text, "/workspace", cursorOffset, "#")).toEqual({
      text,
      lines: ["first line", "fix #12 now"],
      cursorOffset,
      cursorLine: 1,
      cursorColumn: 7,
      cwd: "/workspace",
      token: "#12",
      tokenStart: "first line\nfix ".length,
    });
  });

  test("builds and applies v2 plugin autocomplete completions", () => {
    const context = getRelayAutocompleteContext("fix #12 now", "/workspace", "fix #12".length, "#")!;
    const completion = buildPluginAutocompleteCompletion(
      context,
      { items: [{ label: "#123", insertText: "#123", description: "issue" }] },
      ({ text, item, tokenStart, tokenEnd }) => {
        const insertText = item.insertText ?? item.label;
        return {
          text: `${text.slice(0, tokenStart)}${insertText}${text.slice(tokenEnd)}`,
          cursorOffset: tokenStart + insertText.length,
        };
      },
    )!;
    const selected = completion.items[0]!;

    expect(completion).toMatchObject({ tokenStart: 4, query: "#12", replaceEnd: 7, kind: "plugin" });
    expect(applyPluginCompletion("fix #12 now", completion, selected)).toBe("fix #123 now");
    expect(applyPluginCompletionSelection("fix #12 now", completion, selected, "/workspace", 7)).toEqual({
      text: "fix #123 now",
      cursorOffset: 8,
    });
  });

  test("extracts plugin command argument completion targets", () => {
    const commands = new Set(["deploy", "shared:2"]);

    expect(getSlashCommandArgumentTarget("/deploy st", commands)).toEqual({
      commandName: "deploy",
      argsPrefix: "st",
      tokenStart: 8,
    });
    expect(getSlashCommandArgumentTarget("  /shared:2 prod", commands)).toEqual({
      commandName: "shared:2",
      argsPrefix: "prod",
      tokenStart: 12,
    });
    expect(getSlashCommandArgumentTarget("/unknown st", commands)).toBeNull();
    expect(getSlashCommandArgumentTarget("ask /deploy st", commands)).toBeNull();
  });

  test("builds plugin command argument completion results", () => {
    const target = { commandName: "deploy", argsPrefix: "st", tokenStart: 8 };
    const result = buildSlashCommandArgumentCompletion(target, [
      { label: "staging", insertText: "staging", description: "environment" },
    ]);

    expect(result).toEqual({
      items: [
        {
          value: { label: "staging", insertText: "staging", description: "environment" },
          label: "staging",
          description: "environment",
        },
      ],
      tokenStart: 8,
      query: "st",
      kind: "plugin",
    });
  });

  test("extracts tab-completion path fragments", () => {
    expect(PathCompleter.extractPathFragment("open src/fo", 11)).toEqual(["src/fo", 5]);
    expect(PathCompleter.extractPathFragment("open src/fo", 4)).toEqual(["open", 0]);
    expect(PathCompleter.extractPathFragment("open ./src/")).toEqual(["./src/", 5]);
    expect(PathCompleter.extractPathFragment("open ../")).toEqual(["../", 5]);
    expect(PathCompleter.extractPathFragment("open /tmp/")).toEqual(["/tmp/", 5]);
    expect(PathCompleter.extractPathFragment("open ~/oss/")).toEqual(["~/oss/", 5]);
  });

  test("extracts tab-completion paths after natural-language apostrophes", () => {
    expect(PathCompleter.extractPathFragment("Let's review the design against the best patterns in ~/oss/")).toEqual([
      "~/oss/",
      53,
    ]);
    expect(PathCompleter.extractPathFragment("Let's review ~/oss/")).toEqual(["~/oss/", 13]);
    expect(PathCompleter.extractPathFragment("James' ~/oss/")).toEqual(["~/oss/", 7]);
    expect(PathCompleter.extractPathFragment("read foo's/bar")).toEqual(["foo's/bar", 5]);
    expect(PathCompleter.extractPathFragment("open O'Reilly/src")).toEqual(["O'Reilly/src", 5]);
  });

  test("extracts tab-completion paths from real unclosed quotes only", () => {
    expect(PathCompleter.extractPathFragment('open "~/oss/')).toEqual(["~/oss/", 5]);
    expect(PathCompleter.extractPathFragment("open '~/oss/")).toEqual(["~/oss/", 5]);
    expect(PathCompleter.extractPathFragment('open "My Documents/')).toEqual(["My Documents/", 5]);
    expect(PathCompleter.extractPathFragment('open "foo \\"bar/')).toEqual(['foo \\"bar/', 5]);
    expect(PathCompleter.extractPathFragment('env PATH="~/oss/')).toEqual(["~/oss/", 9]);
    expect(PathCompleter.extractPathFragment("say 'hello' ~/oss/")).toEqual(["~/oss/", 12]);
    expect(PathCompleter.extractPathFragment('say "hello" ~/oss/')).toEqual(["~/oss/", 12]);
    expect(PathCompleter.extractPathFragment("say \\' ~/oss/")).toEqual(["~/oss/", 7]);
  });
});
