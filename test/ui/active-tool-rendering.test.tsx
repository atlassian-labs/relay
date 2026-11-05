import { afterEach, describe, expect, test } from "bun:test";
import { parseColor } from "@opentui/core";
import { testRender } from "@opentui/solid";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Config, getConfigDir, resetConfig, setConfig } from "../../src/config";
import { App } from "../../src/ui/app";
import { getColors } from "../../src/ui/context/theme";
import {
  acpAgentMessageChunk,
  acpPromptResponse,
  acpThinkingChunk,
  acpToolCallStart,
  acpToolCallUpdate,
  acpToolDiffContent,
  acpToolMixedContent,
} from "../lib/acp-events";
import { createFauxAcpAgent } from "../lib/faux-acp-agent";

const STANDARD_PERMISSION_OPTIONS = [
  { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
  { optionId: "reject_once", name: "Reject once", kind: "reject_once" },
] as const;

const tmpRoots: string[] = [];

function tmpWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-active-tools-"));
  tmpRoots.push(dir);
  return dir;
}

function configureFauxAgent(profile: "alta" | "rovodev" | "codex" | "claude"): void {
  setConfig(
    new Config({
      notifications: { sound_enabled: false },
      agents: {
        default: "faux",
        runners: {
          faux: {
            command: "faux-agent",
            args: [],
            profile,
          },
        },
      },
    }),
  );
}

function configureFauxAltaAgent(): void {
  configureFauxAgent("alta");
}

async function waitFor(assertion: () => void | boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  let lastError: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      const result = assertion();
      if (result !== false) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (lastError) throw lastError;
  throw new Error("Timed out waiting for assertion");
}

afterEach(() => {
  resetConfig();
  fs.rmSync(getConfigDir(), { recursive: true, force: true });
  while (tmpRoots.length > 0) {
    fs.rmSync(tmpRoots.pop()!, { recursive: true, force: true });
  }
});

describe("active tool rendering", () => {
  test("uses Alta renderers for live tool updates that include ACP diff content", async () => {
    configureFauxAltaAgent();
    const cwd = tmpWorkspace();
    const filePath = path.join(cwd, "tmp-tool-demo.txt");
    const createdText = "line 1: created by tool demo\nline 2: original text\n";
    const editedText = "line 1: created by tool demo\nline 2: edited by find_and_replace_code\n";
    const faux = createFauxAcpAgent();
    faux.script(
      [
        acpToolCallStart({
          toolCallId: "create-1",
          toolName: "create_file",
          rawInput: { file_path: filePath, initial_content: createdText },
          status: "running",
        }),
        acpToolCallUpdate({
          toolCallId: "create-1",
          status: "success",
          content: acpToolDiffContent({ path: filePath, oldText: null, newText: createdText }),
        }),
        acpToolCallStart({
          toolCallId: "edit-1",
          toolName: "find_and_replace_code",
          rawInput: {
            file_path: filePath,
            old_string: "line 2: original text",
            new_string: "line 2: edited by find_and_replace_code",
          },
          status: "running",
        }),
        acpToolCallUpdate({
          toolCallId: "edit-1",
          status: "success",
          rawOutput: [
            "Successfully replaced code in tmp-tool-demo.txt:",
            "--- before",
            "+++ after",
            "@@ -2,1 +2,1 @@",
            "-line 2: original text",
            "+line 2: edited by find_and_replace_code",
          ].join("\n"),
          content: acpToolDiffContent({ path: filePath, oldText: createdText, newText: editedText }),
        }),
        acpToolCallStart({
          toolCallId: "bash-1",
          toolName: "git status --short -- tmp-tool-demo.txt tmp-tool-demo-dir",
          status: "running",
        }),
        acpToolCallUpdate({
          toolCallId: "bash-1",
          toolName: "git status --short -- tmp-tool-demo.txt tmp-tool-demo-dir",
          status: "success",
          rawOutput: "?? tmp-tool-demo-dir/\n?? tmp-tool-demo.txt",
        }),
      ],
      acpPromptResponse({ inputTokens: 1, outputTokens: 1 }),
    );

    const app = await testRender(
      () => (
        <App
          cwd={cwd}
          initialAgent="faux"
          initialContinue={false}
          initialResume={false}
          initialResumeSessionId=""
          initialDefaultRenderer={false}
          acpClientFactory={faux.factory()}
        />
      ),
      { width: 120, height: 50, targetFps: 30 },
    );

    try {
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("Connected to faux agent");
      });
      await app.mockInput.typeText("show create edit bash tools");
      app.mockInput.pressEnter();

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("+ create-file tmp-tool-demo.txt +2");
        expect(frame).toContain("~ edit tmp-tool-demo.txt +1 -1");
        expect(frame).toContain("Successfully replaced code in tmp-tool-demo.txt:");
        expect(frame).toContain("$ bash git status --short -- tmp-tool-demo.txt tmp-tool-demo-dir");
        expect(frame).not.toContain("≡ git-status---short");
        expect(frame).not.toContain("create_file");
        expect(frame).not.toContain("find_and_replace_code tmp-tool-demo.txt");
        expect(frame).not.toContain("line 1: created by tool demo");
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("uses Rovo Dev renderers with concise verb labels", async () => {
    configureFauxAgent("rovodev");
    const cwd = tmpWorkspace();
    const filePath = path.join(cwd, "tmp-rovo-demo.txt");
    const secondFilePath = path.join(cwd, "tmp-rovo-other.txt");
    const openInput = {
      tool_name: "open_files",
      tool_call_part: { file_paths: [filePath, secondFilePath], _intent: "Inspect both files." },
    };
    const faux = createFauxAcpAgent();
    faux.script(
      [
        // Rovo emits one pending snapshot per location with the same tool-call ID
        // and complete input. Relay must treat these as snapshots, not additions.
        acpToolCallStart({
          toolCallId: "open-1",
          toolName: "2 files",
          rawInput: openInput,
          status: "running",
        }),
        acpToolCallStart({
          toolCallId: "open-1",
          toolName: "2 files",
          rawInput: openInput,
          status: "running",
        }),
        acpToolCallUpdate({
          toolCallId: "open-1",
          status: "success",
          rawOutput: ["0\tline one\n1\tline two", "0\tother line"],
          content: acpToolMixedContent([`${filePath}\n${secondFilePath}`, "0\tline one\n1\tline two", "0\tother line"]),
        }),
        acpToolCallStart({
          toolCallId: "grep-1",
          toolName: "grep: line in *.txt",
          rawInput: { tool_name: "grep", tool_call_part: { content_pattern: "line", path_glob: "*.txt" } },
          status: "running",
        }),
        acpToolCallUpdate({
          toolCallId: "grep-1",
          status: "success",
          rawOutput: "Found 2 matches\ntmp-rovo-demo.txt:1:line one\ntmp-rovo-demo.txt:2:line two",
        }),
        acpToolCallStart({
          toolCallId: "plan-1",
          toolName: "create_technical_plan",
          rawInput: {
            tool_name: "create_technical_plan",
            tool_call_part: {
              plan: {
                logicalChanges: [
                  {
                    summary: "Update rendering",
                    filesToChange: [{ filePath: "src/ui/tool-renderers/agents/rovodev.tsx" }],
                  },
                ],
              },
            },
          },
          status: "running",
        }),
        acpToolCallUpdate({ toolCallId: "plan-1", status: "success", rawOutput: "Plan accepted" }),
        acpToolCallStart({
          toolCallId: "todo-1",
          toolName: "update_todo",
          rawInput: {
            tool_name: "update_todo",
            tool_call_part: {
              _intent: "Tracking renderer work.",
              merge: false,
              todos: [
                { id: 1, content: "inspect renderer", status: "completed" },
                {
                  id: 2,
                  content: "implement renderer",
                  active_form: "implementing renderer",
                  status: "in_progress",
                },
                { id: 3, content: "verify renderer", status: "pending" },
              ],
            },
          },
          status: "running",
        }),
        acpToolCallUpdate({
          toolCallId: "todo-1",
          status: "success",
          rawOutput: [
            "Successfully replaced existing todos. Total: 3 tasks (1 completed, 1 in_progress, 1 pending).",
            "",
            "<todo>",
            '{"id":1,"content":"inspect renderer","active_form":null,"status":"completed"}',
            '{"id":2,"content":"implement renderer","active_form":"implementing renderer","status":"in_progress"}',
            '{"id":3,"content":"verify renderer","active_form":null,"status":"pending"}',
            "</todo>",
          ].join("\n"),
          content: acpToolMixedContent([
            "merge: False\n\ntodos: [...]\n\n_intent: Tracking renderer work.",
            [
              "Successfully replaced existing todos. Total: 3 tasks (1 completed, 1 in_progress, 1 pending).",
              "",
              "<todo>",
              '{"id":1,"content":"inspect renderer","active_form":null,"status":"completed"}',
              '{"id":2,"content":"implement renderer","active_form":"implementing renderer","status":"in_progress"}',
              '{"id":3,"content":"verify renderer","active_form":null,"status":"pending"}',
              "</todo>",
            ].join("\n"),
          ]),
        }),
      ],
      acpPromptResponse({ inputTokens: 1, outputTokens: 1 }),
    );

    const app = await testRender(
      () => (
        <App
          cwd={cwd}
          initialAgent="faux"
          initialContinue={false}
          initialResume={false}
          initialResumeSessionId=""
          initialDefaultRenderer={false}
          acpClientFactory={faux.factory()}
        />
      ),
      { width: 120, height: 50, targetFps: 30 },
    );

    try {
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("Connected to faux agent");
      });
      await app.mockInput.typeText("show rovo tools");
      app.mockInput.pressEnter();

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("→ open tmp-rovo-demo.txt, tmp-rovo-other.txt (2 files, 3 lines)");
        expect(frame).toContain('* search "line" *.txt (2 matches)');
        expect(frame).toContain("◆ plan (1 change, 1 file)");
        expect(frame).toContain("☑ todos (1/3 done)");
        expect(frame).toContain("└ ● inspect renderer");
        expect(frame).toContain("◉ implementing renderer");
        expect(frame).toContain("○ verify renderer");
        expect(frame).not.toContain("Successfully replaced existing todos");
        expect(frame).not.toContain("<todo>");
        expect(frame).not.toContain("open_files");
        expect(frame).not.toContain("create_technical_plan");
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("uses useful Codex tool args instead of transport metadata", async () => {
    configureFauxAgent("codex");
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent();
    faux.script(
      [
        acpToolCallStart({
          toolCallId: "bash-1",
          toolName: "bash",
          rawInput: {
            call_id: "call_123",
            process_id: 456,
            command: "git status --short",
            cwd,
          },
          status: "running",
        }),
        acpToolCallUpdate({
          toolCallId: "bash-1",
          status: "success",
          rawOutput: " M README.md\n M src/config/index.ts",
        }),
        acpToolCallStart({
          toolCallId: "mcp-1",
          toolName: "tool:-codex/list-mcp-resources",
          rawInput: { server: "codex", tool: "list_mcp_resources", arguments: {} },
          status: "running",
        }),
        acpToolCallUpdate({
          toolCallId: "mcp-1",
          status: "success",
          rawOutput: { resources: [] },
        }),
      ],
      acpPromptResponse({ inputTokens: 1, outputTokens: 1 }),
    );

    const app = await testRender(
      () => (
        <App
          cwd={cwd}
          initialAgent="faux"
          initialContinue={false}
          initialResume={false}
          initialResumeSessionId=""
          initialDefaultRenderer={false}
          acpClientFactory={faux.factory()}
        />
      ),
      { width: 120, height: 40, targetFps: 30 },
    );

    try {
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("Connected to faux agent");
      });
      await app.mockInput.typeText("show codex tools");
      app.mockInput.pressEnter();

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("$ bash git status --short");
        expect(frame).toContain("* mcp-tool codex/list-mcp-resources");
        expect(frame).not.toContain("call_id");
        expect(frame).not.toContain("call_123");
        expect(frame).not.toContain("process_id");
        expect(frame).not.toContain("server:codex");
        expect(frame).not.toContain("tool:list_mcp_resources");
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("uses Claude Code tool renderers for command, search, todos, and edits", async () => {
    configureFauxAgent("claude");
    const cwd = tmpWorkspace();
    const filePath = path.join(cwd, "src/example.ts");
    const faux = createFauxAcpAgent();
    faux.script(
      [
        acpToolCallStart({
          toolCallId: "bash-1",
          toolName: "Bash",
          toolKind: "execute",
          rawInput: { command: "bun test test/config/config.test.ts", description: "Run config tests" },
          status: "running",
        }),
        acpToolCallUpdate({ toolCallId: "bash-1", status: "success", rawOutput: "config test ok" }),
        acpToolCallStart({
          toolCallId: "grep-1",
          toolName: 'grep --include="*.ts" "resolveConfiguredAgent" src',
          rawInput: { pattern: "resolveConfiguredAgent", path: "src", glob: "*.ts", output_mode: "content" },
          status: "running",
        }),
        acpToolCallUpdate({
          toolCallId: "grep-1",
          status: "success",
          rawOutput: "src/config/index.ts:1470:export function resolveConfiguredAgent",
        }),
        acpToolCallStart({
          toolCallId: "todo-1",
          toolName: "Update TODOs: inspect renderers, add tests",
          rawInput: {
            todos: [
              { content: "inspect renderers", status: "completed" },
              { content: "add tests", status: "in_progress" },
            ],
          },
          status: "running",
        }),
        acpToolCallUpdate({ toolCallId: "todo-1", status: "success" }),
        acpToolCallStart({
          toolCallId: "edit-1",
          toolName: "Edit src/example.ts",
          rawInput: { file_path: filePath, old_string: "old", new_string: "new" },
          status: "running",
        }),
        acpToolCallUpdate({
          toolCallId: "edit-1",
          status: "success",
          content: acpToolDiffContent({ path: filePath, oldText: "old\n", newText: "new\n" }),
        }),
      ],
      acpPromptResponse({ inputTokens: 1, outputTokens: 1 }),
    );

    const app = await testRender(
      () => (
        <App
          cwd={cwd}
          initialAgent="faux"
          initialContinue={false}
          initialResume={false}
          initialResumeSessionId=""
          initialDefaultRenderer={false}
          acpClientFactory={faux.factory()}
        />
      ),
      { width: 120, height: 50, targetFps: 30 },
    );

    try {
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("Connected to faux agent");
      });
      await app.mockInput.typeText("show claude tools");
      app.mockInput.pressEnter();

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("$ bash bun test test/config/config.test.ts");
        expect(frame).toContain('* grep --include="*.ts" "resolveConfiguredAgent" src');
        expect(frame).toContain("□ todos (1/2 done)");
        expect(frame).toContain("~ edit src/example.ts +1 -1");
        expect(frame).not.toContain("old_string");
        expect(frame).not.toContain("file_path");
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("renders Alta invoke_agent as a delegated subagent row with nested progress", async () => {
    configureFauxAltaAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({ promptDelayMs: 300 });
    faux.setDefaultResponse(acpPromptResponse({ inputTokens: 1, outputTokens: 1 }));

    const app = await testRender(
      () => (
        <App
          cwd={cwd}
          initialAgent="faux"
          initialContinue={false}
          initialResume={false}
          initialResumeSessionId=""
          initialDefaultRenderer={false}
          acpClientFactory={faux.factory()}
        />
      ),
      { width: 140, height: 50, targetFps: 30 },
    );

    try {
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("Connected to faux agent");
      });
      await app.mockInput.typeText("delegate to scout");
      app.mockInput.pressEnter();
      await waitFor(() => expect(faux.prompts).toHaveLength(1));

      faux.emit(
        acpToolCallStart({
          toolCallId: "invoke-1",
          toolName: "invoke_agent",
          rawInput: { agent: "scout", message: "Map Relay ACP flow before editing", background: false },
          status: "running",
        }),
      );
      faux.emitWithEnvelope(acpThinkingChunk("**Reading mapping** before choosing files."), {
        metadata: { "alta/subagent": { invokingToolCallId: "invoke-1", childSessionId: "child-scout" } },
      });
      faux.emitWithEnvelope(
        acpToolCallStart({
          toolCallId: "child-read",
          toolName: "view_file",
          rawInput: { file_path: "src/application/acp-mapping.ts" },
          status: "running",
        }),
        {
          metadata: { "alta/subagent": { invokingToolCallId: "invoke-1", childSessionId: "child-scout" } },
        },
      );
      faux.emitWithEnvelope(acpToolCallUpdate({ toolCallId: "child-read", status: "success" }), {
        metadata: { "alta/subagent": { invokingToolCallId: "invoke-1", childSessionId: "child-scout" } },
      });

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        const lines = frame.split("\n");
        const header = lines.find((line) => line.includes("subagent scout"));
        const result = lines.find((line) => line.includes("└ ✓ read files"));
        const spans = app.captureSpans().lines.flatMap((line) => line.spans);
        const tickSpan = spans.find((span) => span.text.includes("✓"));
        expect(header).toBeDefined();
        expect(result).toBeDefined();
        expect(result?.indexOf("└")).toBe(header?.indexOf("subagent"));
        expect(tickSpan?.fg.toString()).toBe(parseColor(getColors().textSubtle).toString());
      });

      faux.emitWithEnvelope(acpAgentMessageChunk("**Found** the renderer seam.\n\nFollow-up details."), {
        metadata: { "alta/subagent": { invokingToolCallId: "invoke-1", childSessionId: "child-scout" } },
      });
      faux.emit(acpToolCallUpdate({ toolCallId: "invoke-1", status: "success", rawOutput: "Scout done" }));

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        const lines = frame.split("\n");
        const header = lines.find((line) => line.includes("subagent scout"));
        const summary = lines.find((line) => line.includes("└ Done"));
        expect(frame).toContain('↪ subagent scout (foreground, "Map Relay ACP flow before editing")');
        expect(summary).toMatch(/└ Done \(1 tool call · \d+s\)/);
        expect(summary?.indexOf("└")).toBe(header?.indexOf("subagent"));
        expect(frame).not.toContain("thinking");
        expect(frame).not.toContain("Reading mapping before choosing files.");
        expect(frame).not.toContain("read files");
        expect(frame).not.toContain("response");
        expect(frame).not.toContain("Found the renderer seam.");
        expect(frame).not.toContain("Follow-up details.");
        expect(frame).not.toContain("**Reading mapping**");
        expect(frame).not.toContain("**Found**");
        expect(frame).not.toContain("tool: tool done");
        expect(frame).not.toContain("≡ invoke-agent");
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("shows skill name from rawInput for Alta skill tool calls", async () => {
    configureFauxAltaAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent();
    faux.script(
      [
        acpToolCallStart({
          toolCallId: "skill-1",
          toolName: "skill",
          rawInput: { name: "code-review" },
          status: "running",
        }),
        acpToolCallUpdate({
          toolCallId: "skill-1",
          status: "success",
          rawOutput: "Skill executed successfully.",
        }),
      ],
      acpPromptResponse({ inputTokens: 1, outputTokens: 1 }),
    );

    const app = await testRender(
      () => (
        <App
          cwd={cwd}
          initialAgent="faux"
          initialContinue={false}
          initialResume={false}
          initialResumeSessionId=""
          initialDefaultRenderer={false}
          acpClientFactory={faux.factory()}
        />
      ),
      { width: 120, height: 50, targetFps: 30 },
    );

    try {
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("Connected to faux agent");
      });
      await app.mockInput.typeText("use the code-review skill");
      app.mockInput.pressEnter();

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("≡ skill (code-review)");
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("removes approved permission prompts before rendering Rovo tool output", async () => {
    configureFauxAgent("rovodev");
    const cwd = tmpWorkspace();
    const filePath = path.join(cwd, "tmp-rovo-permission.ts");
    const faux = createFauxAcpAgent();
    const app = await testRender(
      () => (
        <App
          cwd={cwd}
          initialAgent="faux"
          initialContinue={false}
          initialResume={false}
          initialResumeSessionId=""
          initialDefaultRenderer={false}
          acpClientFactory={faux.factory()}
        />
      ),
      { width: 120, height: 50, targetFps: 30 },
    );

    try {
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("Connected to faux agent");
      });

      const permission = faux.requestPermission({
        toolCallId: "approval-create-1",
        toolName: "create_file",
        preview: "create_file wants permission",
        options: STANDARD_PERMISSION_OPTIONS,
      });

      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("Permission Required");
      });
      app.mockInput.pressEnter();
      await expect(permission).resolves.toEqual(STANDARD_PERMISSION_OPTIONS[0]);

      faux.emit(
        acpToolCallStart({
          toolCallId: "create-1",
          toolName: "tmp-rovo-permission.ts",
          rawInput: {
            tool_name: "create_file",
            tool_call_part: { file_path: filePath, initial_content: "export const hello = 'relay';\n" },
          },
          status: "running",
        }),
      );
      faux.emit(acpToolCallUpdate({ toolCallId: "create-1", status: "success", rawOutput: "Created file" }));

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("+ create tmp-rovo-permission.ts +1");
        expect(frame).not.toContain("Permission Required");
        expect(frame).not.toContain("+ create-file");
      });
    } finally {
      app.renderer.destroy();
    }
  });
});
