#!/usr/bin/env python3
import os
import pty
import shutil
import signal
import subprocess
import sys
import tempfile
import textwrap
import time

from relay_command import relay_command

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
TEST_LIB = os.path.join(ROOT, "test", "lib")
if TEST_LIB not in sys.path:
    sys.path.insert(0, TEST_LIB)

from real_e2e_chat_autoscroll import ChatAutoscrollPtyHarness

AGENT_SOURCE = r'''#!/usr/bin/env bun
import * as fs from "node:fs";
import * as readline from "node:readline";

type JsonRpcMessage = {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
};

const logPath = process.env.RELAY_SPLIT_MOUSE_E2E_LOG ?? "";
let currentSessionId = "split-mouse-e2e-session";
let cancelGeneration = 0;

function record(event: Record<string, unknown>): void {
  if (!logPath) return;
  fs.appendFileSync(logPath, `${JSON.stringify({ ...event, timestamp: Date.now() })}\n`, "utf8");
}

function write(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id: number | string | undefined, value: unknown): void {
  if (id === undefined) return;
  write({ jsonrpc: "2.0", id, result: value });
}

function promptText(params: unknown): string {
  const prompt = (params as { prompt?: Array<{ type?: string; text?: string }> } | null)?.prompt;
  if (!Array.isArray(prompt)) return "";
  return prompt
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

function sessionUpdate(update: Record<string, unknown>): void {
  write({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId: currentSessionId, update },
  });
}

async function sleep(ms: number, generation: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (generation !== cancelGeneration) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function largeRunningOutput(): string {
  const lines = Array.from(
    { length: 220 },
    (_, index) => `SPLIT-MOUSE-LINE-${String(index).padStart(3, "0")} ${"content ".repeat(8)}`,
  );
  return ["SPLIT-MOUSE-START", ...lines, "SPLIT-MOUSE-HOLDING"].join("\n");
}

async function handle(message: JsonRpcMessage): Promise<void> {
  switch (message.method) {
    case "initialize":
      result(message.id, { protocolVersion: 1, agentCapabilities: {}, authMethods: [] });
      return;
    case "session/new":
      result(message.id, { sessionId: currentSessionId, availableCommands: [] });
      return;
    case "session/load":
      currentSessionId = String((message.params as { sessionId?: unknown } | null)?.sessionId ?? currentSessionId);
      result(message.id, { sessionId: currentSessionId });
      return;
    case "session/list":
      result(message.id, { sessions: [] });
      return;
    case "session/prompt": {
      const text = promptText(message.params);
      record({ event: "prompt", text });
      const generation = cancelGeneration;
      sessionUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: largeRunningOutput() } });
      await sleep(5000, generation);
      if (generation !== cancelGeneration) {
        record({ event: "prompt-cancelled", text });
        result(message.id, { stopReason: "cancelled", usage: { inputTokens: 1, outputTokens: 0 } });
        return;
      }
      record({ event: "prompt-complete", text });
      result(message.id, { stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } });
      return;
    }
    case "session/cancel":
      cancelGeneration++;
      record({ event: "cancel" });
      result(message.id, {});
      return;
    default:
      result(message.id, {});
      return;
  }
}

const lines = readline.createInterface({ input: process.stdin });
for await (const rawLine of lines) {
  const line = rawLine.trim();
  if (!line) continue;
  try {
    void handle(JSON.parse(line) as JsonRpcMessage).catch((err: unknown) => {
      process.stderr.write(`bad message: ${String(err)}\n`);
    });
  } catch (err) {
    process.stderr.write(`bad message: ${String(err)}\n`);
  }
}
'''


def write_config(config_path: str, agent_path: str) -> None:
    with open(config_path, "w", encoding="utf-8") as file:
        file.write(
            "[plugins]\n"
            "enabled = false\n\n"
            "[agents]\n"
            'default = "split-mouse-e2e"\n\n'
            "[agents.runners.split-mouse-e2e]\n"
            'command = "bun"\n'
            f'args = ["run", "{agent_path}"]\n'
            'profile = "default"\n'
        )


def agent_prompt_texts(harness: ChatAutoscrollPtyHarness, agent_log: str) -> list[str]:
    return [
        str(entry.get("text"))
        for entry in harness.read_agent_events(agent_log)
        if entry.get("event") == "prompt" and isinstance(entry.get("text"), str)
    ]


def has_agent_event(harness: ChatAutoscrollPtyHarness, agent_log: str, event: str) -> bool:
    return any(entry.get("event") == event for entry in harness.read_agent_events(agent_log))


def wait_for_agent_event(harness: ChatAutoscrollPtyHarness, agent_log: str, event: str, timeout: float = 5.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if has_agent_event(harness, agent_log, event):
            return
        time.sleep(0.05)
    raise AssertionError(f"Timed out waiting for agent event {event!r}: {harness.read_agent_events(agent_log)}")


def wait_for_prompt_text(harness: ChatAutoscrollPtyHarness, agent_log: str, expected: str, timeout: float = 5.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        texts = agent_prompt_texts(harness, agent_log)
        if expected in texts:
            return
        time.sleep(0.05)
    raise AssertionError(f"Timed out waiting for prompt text {expected!r}: {agent_prompt_texts(harness, agent_log)}")


def assert_no_prompt_text_contains(harness: ChatAutoscrollPtyHarness, agent_log: str, forbidden: str) -> None:
    matches = [text for text in agent_prompt_texts(harness, agent_log) if forbidden in text]
    if matches:
        raise AssertionError(f"Unexpected prompt text containing {forbidden!r}: {matches}")


def assert_agent_event_absent(
    harness: ChatAutoscrollPtyHarness,
    master: int,
    proc: subprocess.Popen[str],
    agent_log: str,
    event: str,
    duration: float,
) -> None:
    deadline = time.time() + duration
    while time.time() < deadline:
        harness.assert_process_running(proc)
        harness.read_available(master, 0.1)
        if has_agent_event(harness, agent_log, event):
            raise AssertionError(f"Expected no agent event {event!r}: {harness.read_agent_events(agent_log)}")


def write_split_mouse_wheel(master: int, button_code: int) -> None:
    os.write(master, b"\x1b")
    time.sleep(0.04)
    os.write(master, f"[<{button_code};20;5M".encode("ascii"))


def write_leaked_mouse_report_batch(master: int) -> None:
    os.write(master, b"\x1b[<65;181;34M<64;150;30M\x1b[<64;157;22M")


def write_laggy_bare_mouse_report_tail(master: int) -> None:
    for character in "<64;150;30M":
        os.write(master, character.encode("ascii"))
        time.sleep(0.06)


def write_chunked_bare_mouse_report_tail(master: int) -> None:
    os.write(master, b"<64;150")
    time.sleep(0.06)
    os.write(master, b";30M")


def run_probe(harness: ChatAutoscrollPtyHarness, master: int, proc: subprocess.Popen[str], agent_log: str) -> None:
    harness.step("submit prompt after batched, chunked, and laggy leaked mouse reports and verify ACP receives clean text")
    write_leaked_mouse_report_batch(master)
    harness.read_available(master, 0.3)
    write_chunked_bare_mouse_report_tail(master)
    harness.read_available(master, 0.3)
    write_laggy_bare_mouse_report_tail(master)
    harness.read_available(master, 0.3)
    harness.send_text(master, "split mouse escape regression")
    harness.send(master, "\r")
    wait_for_prompt_text(harness, agent_log, "split mouse escape regression", 5)
    assert_no_prompt_text_contains(harness, agent_log, "<64;150;30M")
    assert_no_prompt_text_contains(harness, agent_log, "<65;181;34M")
    harness.wait_for(master, proc, "SPLIT-MOUSE-HOLDING", 8)

    harness.step("send split wheel-down at sticky bottom and verify it does not cancel")
    write_split_mouse_wheel(master, 65)
    harness.read_available(master, 0.5)
    assert_agent_event_absent(harness, master, proc, agent_log, "cancel", 0.8)

    harness.step("send split wheel-up and verify it does not cancel")
    write_split_mouse_wheel(master, 64)
    harness.read_available(master, 0.5)
    assert_agent_event_absent(harness, master, proc, agent_log, "cancel", 0.8)

    harness.step("send a real Escape key and verify it still cancels the running turn")
    os.write(master, b"\x1b")
    harness.read_available(master, 0.2)
    wait_for_agent_event(harness, agent_log, "cancel", 3)
    wait_for_agent_event(harness, agent_log, "prompt-cancelled", 3)
    harness.wait_for(master, proc, "\n >", 5)

    harness.step("submit invalid mouse-report lookalike and verify it remains literal prompt text")
    harness.send_text(master, "<65;181;34Q")
    harness.send(master, "\r")
    wait_for_prompt_text(harness, agent_log, "<65;181;34Q", 5)


def main() -> int:
    artifacts = os.path.join(ROOT, "test-results", "real-e2e")
    os.makedirs(artifacts, exist_ok=True)
    home = tempfile.mkdtemp(prefix="relay-split-mouse-home-")
    workspace = tempfile.mkdtemp(prefix="relay-split-mouse-workspace-")
    agent_log = os.path.join(workspace, "agent-events.ndjson")
    agent_path = os.path.join(workspace, "split-mouse-agent.ts")
    with open(agent_path, "w", encoding="utf-8") as file:
        file.write(textwrap.dedent(AGENT_SOURCE))
    os.chmod(agent_path, 0o755)

    env = os.environ.copy()
    env.pop("XDG_CONFIG_HOME", None)
    env.update(
        {
            "HOME": home,
            "TERM": "xterm-256color",
            "NO_COLOR": "1",
            "RELAY_DISABLE_NOTIFICATIONS": "1",
            "RELAY_SPLIT_MOUSE_E2E_LOG": agent_log,
        }
    )

    relay_dir = os.path.join(home, ".config", "relay")
    os.makedirs(relay_dir, exist_ok=True)
    config_path = os.path.join(relay_dir, "config.toml")
    write_config(config_path, agent_path)

    harness = ChatAutoscrollPtyHarness(rows=24, cols=100)
    command = relay_command(ROOT, "split-mouse-e2e")
    master, slave = pty.openpty()
    harness.set_pty_size(master)
    harness.set_pty_size(slave)
    passed = False
    proc = subprocess.Popen(
        command,
        cwd=workspace,
        env=env,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        start_new_session=True,
    )
    os.close(slave)

    try:
        harness.step("wait for Relay to connect through real CLI")
        harness.wait_for(master, proc, "Connected to", 10)
        harness.wait_for(master, proc, "\n >", 5)
        run_probe(harness, master, proc, agent_log)
        passed = True
        return 0
    finally:
        with open(os.path.join(artifacts, "split-mouse-escape-smoke.steps.txt"), "w", encoding="utf-8") as file:
            file.write("\n".join(harness.steps))
        with open(os.path.join(artifacts, "split-mouse-escape-smoke.transcript.txt"), "w", encoding="utf-8") as file:
            file.write(harness.transcript_text())
        with open(os.path.join(artifacts, "split-mouse-escape-smoke.screen.txt"), "w", encoding="utf-8") as file:
            file.write(harness.screen_text())
        if os.path.exists(config_path):
            shutil.copyfile(config_path, os.path.join(artifacts, "split-mouse-escape-smoke.config.toml"))
        if os.path.exists(agent_log):
            shutil.copyfile(agent_log, os.path.join(artifacts, "split-mouse-escape-smoke.agent-events.ndjson"))
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            proc.wait(timeout=3)
        with open(os.path.join(artifacts, "split-mouse-escape-smoke.process.txt"), "w", encoding="utf-8") as file:
            file.write(harness.process_diagnostics(proc))
        os.close(master)
        if passed:
            shutil.rmtree(home, ignore_errors=True)
            shutil.rmtree(workspace, ignore_errors=True)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as err:
        print(f"real e2e failed: {err}", file=sys.stderr)
        raise
