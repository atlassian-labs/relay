import { expect, test, type Page } from "@playwright/test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

type RelayWebHandle = {
  url: string;
  transcriptPath: string;
  stop: () => Promise<void>;
};

test("loads the Relay web dashboard and drives an ACP turn", async ({ page }) => {
  const relay = await startRelayWeb();
  try {
    await page.goto(relay.url);

    await expect(page.getByRole("heading", { name: "Agent ready" })).toBeVisible();
    await expect(page.getByText("What would you like to do?")).toBeVisible();
    await expect(page.locator(".topbar")).toHaveCount(0);
    await expect(page.locator("#promptBox select")).toHaveCount(0);
    await expect(page.locator("#promptBox #statusPill")).toContainText("Ready");
    await expect(page.locator("#promptBox #controls")).toBeVisible();
    await expect(page.locator("#promptBox").getByText("Model A")).toBeVisible();

    await page.locator("#promptInput").fill("show markdown and a tool call");
    await page.locator('[data-action="send-prompt"]').click();

    await expect(page.locator(".app-shell")).toHaveClass(/is-running/);
    await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
    await expect(page.locator('.config-actions [data-action="cancel"]')).toHaveCount(0);
    await expect(page.locator(".block.user")).toContainText("show markdown and a tool call");
    await expect(page.getByText("Agent working…")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Web turn complete" })).toBeVisible();
    await expect(page.locator(".block.content code").filter({ hasText: "const answer = 42" })).toBeVisible();

    const toolGroup = page.locator(".block.tool", { hasText: "Tool calls" });
    await expect(toolGroup).toBeVisible();
    await expect(toolGroup).toContainText("Read File");
    await expect(toolGroup).toContainText("Find And Replace Code");
    await expect.poll(() => toolGroup.locator("details").evaluate((node) => node.hasAttribute("open"))).toBe(false);
    await toolGroup.locator("summary").click();
    await expect(toolGroup.locator("code").filter({ hasText: "export default answer" })).toBeVisible();
    await expect(toolGroup.locator(".diff-remove")).toContainText("-const answer = 41;");
    await expect(toolGroup.locator(".diff-add")).toContainText("+const answer = 42;");

    await page.locator("#promptInput").fill("request custom permission");
    await page.locator('[data-action="send-prompt"]').click();
    const approvalTool = page.locator(".block.tool", { hasText: "Permission Write" });
    await expect(approvalTool.getByRole("button", { name: "Allow custom" })).toBeVisible();
    await expect(approvalTool.getByRole("button", { name: "Reject custom" })).toBeVisible();
    await approvalTool.getByRole("button", { name: "Reject custom" }).click();
    const rejectedTool = page.locator(".block.tool", { hasText: "Permission Write" }).last();
    await expect(rejectedTool).toHaveClass(/error/);
    await expect(rejectedTool.locator(".tool-flag.error").first()).toContainText("failed");
    await expect(page.locator(".block.content", { hasText: "Permission selected: custom-reject" })).toBeVisible();

    await expect(page.locator(".app-shell")).not.toHaveClass(/is-running/);
    await expect(page.locator("#promptBox").getByText("Model A")).toBeVisible();
    await page.locator("#promptBox").getByText("Model A").click();
    await expect(page.locator("#promptBox").getByText("Choose model")).toBeVisible();

    await page.locator("#promptInput").fill("please /thr");
    await expect(page.locator("#promptSuggestions")).toContainText("/threads");
    await page.keyboard.press("Tab");
    await expect(page.locator("#promptInput")).toHaveValue("please /threads ");

    await page.locator("#promptInput").fill("@sr");
    await expect(page.locator("#promptSuggestions .suggestion-label").first()).toHaveText("src/");
    await page.keyboard.press("Tab");
    await expect(page.locator("#promptInput")).toHaveValue("@src/");

    await page.locator("#promptInput").fill("/settings");
    await page.locator('[data-action="send-prompt"]').click();
    await expect(page.locator("#promptBox .config-menu-title")).toHaveText("Settings");
    await expect(page.locator("#promptBox .config-menu-item", { hasText: "Sessions" })).toBeVisible();

    await page.locator("#promptInput").fill("/models");
    await page.locator('[data-action="send-prompt"]').click();
    await expect(page.locator("#promptBox").getByText("Choose model")).toBeVisible();
    await expect(page.locator("#promptBox .config-menu")).toHaveCSS("overflow-y", "auto");
    await expect
      .poll(() => page.locator("#promptBox .config-menu").evaluate((node) => node.clientHeight < node.scrollHeight))
      .toBe(true);
    await page.keyboard.press("ArrowDown");
    await expect(page.locator("#promptBox .config-menu-item.focused")).toContainText("Model B");
    await page.keyboard.press("Enter");
    await expect(page.locator("#promptInput")).toHaveValue("");
    await expect(page.locator("#promptBox").getByText("Model B")).toBeVisible();

    await page.locator("#promptInput").fill("");
    await page.keyboard.press("ArrowUp");
    await expect(page.locator("#promptInput")).toHaveValue("request custom permission");

    await expectUserMessageIsRightAligned(page);

    const transcript = await fs.readFile(relay.transcriptPath, "utf-8");
    expect(transcript).toContain('"method":"session/prompt"');
  } finally {
    await relay.stop();
  }
});

test("surfaces ACP child exits in the web dashboard and reconnects on the next prompt", async ({ page }) => {
  const relay = await startRelayWeb({ agentMode: "exit-after-first-prompt" });
  try {
    await page.goto(relay.url);
    await expect(page.getByRole("heading", { name: "Agent ready" })).toBeVisible();

    await page.locator("#promptInput").fill("web child exit first prompt");
    await page.locator('[data-action="send-prompt"]').click();
    await expect(
      page.locator(".block.info", { hasText: "ACP agent process exited unexpectedly (code 0)" }),
    ).toBeVisible();
    await expect(page.locator(".block.info", { hasText: "Start a new prompt to reconnect" })).toBeVisible();
    await expect(page.locator(".block.info", { hasText: "ACP prompt error" })).toHaveCount(0);
    await expect(page.locator("#promptBox #statusPill")).toContainText("Ready");

    await page.locator("#promptInput").fill("web child exit second prompt");
    await page.locator('[data-action="send-prompt"]').click();
    await expect(page.getByRole("heading", { name: "Web turn complete" })).toBeVisible();
    await expect(page.locator(".block.info", { hasText: "ACP prompt error" })).toHaveCount(0);

    const transcript = await fs.readFile(relay.transcriptPath, "utf-8");
    const events = transcript
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events.filter((entry) => entry.event === "started")).toHaveLength(2);
    expect(events).toContainEqual(expect.objectContaining({ event: "intentional-web-exit", code: 0 }));
    expect(events).toContainEqual(expect.objectContaining({ event: "prompt", text: "web child exit first prompt" }));
    expect(events).toContainEqual(expect.objectContaining({ event: "prompt", text: "web child exit second prompt" }));
  } finally {
    await relay.stop();
  }
});

test("filters configured Alta internal sessions from the web session list", async ({ page }) => {
  const relay = await startRelayWeb({
    agentMode: "alta-internal-sessions",
    profile: "alta",
    extraAgentArgs: ["@atlassian/alta-agent-axiom-asumer"],
  });
  try {
    await page.goto(relay.url);
    await expect(page.getByRole("heading", { name: "Agent ready" })).toBeVisible();

    await page.locator("#promptInput").fill("/sessions");
    await page.locator('[data-action="send-prompt"]').click();

    const sessionBlock = page.locator(".block.info", { hasText: "Useful web session" }).last();
    await expect(sessionBlock).toBeVisible();
    await expect(sessionBlock).toContainText("web-playwright-session");
    await expect(sessionBlock).not.toContainText("axiom-asumer");
    await expect(sessionBlock).not.toContainText("junk-package-session");
    await expect(sessionBlock).not.toContainText("junk-cache-session");

    const transcript = await fs.readFile(relay.transcriptPath, "utf-8");
    expect(transcript).toContain('"method":"session/list"');
    expect(transcript).not.toContain('"method":"session/load"');
  } finally {
    await relay.stop();
  }
});

test("resumes ACP history through the web dashboard without leaking prior transcript", async ({ page }) => {
  const relay = await startRelayWeb();
  try {
    await page.goto(relay.url);
    await expect(page.getByRole("heading", { name: "Agent ready" })).toBeVisible();

    await page.locator("#promptInput").fill("prior prompt");
    await page.locator('[data-action="send-prompt"]').click();
    await expect(page.locator(".block.content", { hasText: "Web turn complete" })).toBeVisible();
    // Let the prior turn finish streaming before resuming so late chunks don't race the reset.
    await expect(page.locator(".app-shell")).not.toHaveClass(/is-running/);

    await page.locator("#promptInput").fill("/resume web-playwright-session");
    await page.locator('[data-action="send-prompt"]').click();

    await expect(page.locator(".block.content", { hasText: "Web turn complete" })).toHaveCount(0);
    await expect(page.locator(".block.info", { hasText: "Resumed session: web-playwright-session" })).toBeVisible();
    await expect(page.locator(".block.content")).toContainText("web restored line");
    await expect(page.locator(".block.content")).toContainText("web restored indent");
    const tool = page.locator(".block.tool", { hasText: "Read File" });
    await expect(tool).toBeVisible();
    await tool.locator("summary").click();
    await expect(tool.locator("code").filter({ hasText: "web restored tool output" })).toBeVisible();

    const transcript = await fs.readFile(relay.transcriptPath, "utf-8");
    expect(transcript).toContain('"method":"session/load"');
  } finally {
    await relay.stop();
  }
});

async function startRelayWeb(
  options: { agentMode?: string; profile?: string; extraAgentArgs?: string[] } = {},
): Promise<RelayWebHandle> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-web-playwright-"));
  const home = path.join(root, "home");
  const relayConfigDir = path.join(home, ".config", "relay");
  const transcriptPath = path.join(root, "acp-transcript.ndjson");
  const agentPath = path.resolve("playwright-tests/fixtures/acp-web-agent.ts");
  const relayEntry = path.resolve("src/index.ts");

  const agentArgs = [
    agentPath,
    transcriptPath,
    ...(options.agentMode ? [options.agentMode] : []),
    ...(options.extraAgentArgs ?? []),
  ]
    .map((item) => `"${tomlEscape(item)}"`)
    .join(", ");

  await fs.mkdir(relayConfigDir, { recursive: true });
  await fs.writeFile(
    path.join(relayConfigDir, "config.toml"),
    `[notifications]\nenabled = false\n\n[agents]\ndefault = "web"\n\n[agents.runners.web]\ncommand = "bun"\nargs = [${agentArgs}]\nprofile = "${tomlEscape(options.profile ?? "default")}"\n`,
    "utf-8",
  );

  const { FORCE_COLOR: _forceColor, NO_COLOR: _noColor, ...cleanEnv } = process.env;
  const child = spawn(
    "bun",
    ["run", "--conditions=browser", relayEntry, "web", "--agent", "web", "--no-open", "--port", "0"],
    {
      cwd: path.resolve("."),
      env: {
        ...cleanEnv,
        HOME: home,
        XDG_CONFIG_HOME: path.join(home, ".config"),
      },
    },
  );

  const url = await waitForServer(child);
  return {
    url,
    transcriptPath,
    stop: async () => {
      child.kill("SIGTERM");
      await onceExit(child).catch(() => undefined);
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

function waitForServer(child: ChildProcessWithoutNullStreams): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Relay web did not start in time\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 10_000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      const match = stdout.match(/Relay web dashboard listening at (http:\/\/[^\s]+)/);
      if (!match) return;
      clearTimeout(timer);
      resolve(match[1]);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Relay web exited before start (${code})\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    });
  });
}

function onceExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}
function tomlEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function expectUserMessageIsRightAligned(page: Page): Promise<void> {
  const userBox = await page.locator(".block.user").last().boundingBox();
  const chatBox = await page.locator("#chat").boundingBox();
  expect(userBox, "user message should have a layout box").not.toBeNull();
  expect(chatBox, "chat transcript should have a layout box").not.toBeNull();
  expect(userBox!.x + userBox!.width).toBeGreaterThan(chatBox!.x + chatBox!.width - 24);
}
