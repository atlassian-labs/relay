#!/usr/bin/env python3
"""Real-e2e smoke that drives the built Relay binary over the WebSocket ACP transport.

Unlike the stdio smokes, Relay does not spawn the agent here. We start the fake
websocket ACP agent (test/real-e2e/acp-websocket-agent.ts) separately, wait for it
to publish its ws:// URL, template that URL into a websocket runner config, then
launch Relay and exercise prompt / diff / permission / cancel / resume / exit flows.
"""
import fcntl
import json
import os
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time

from relay_command import relay_command

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCREEN_ROWS = 30
SCREEN_COLS = 120
TRANSCRIPT = []
STEPS = []
ANSI_RE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


class Screen:
    def __init__(self, rows: int = SCREEN_ROWS, cols: int = SCREEN_COLS):
        self.rows = rows
        self.cols = cols
        self.row = 0
        self.col = 0
        self.grid = [[" " for _ in range(cols)] for _ in range(rows)]
        self.pending_escape = ""

    def text(self) -> str:
        return "\n".join("".join(row).rstrip() for row in self.grid)

    def clear(self) -> None:
        self.grid = [[" " for _ in range(self.cols)] for _ in range(self.rows)]
        self.row = 0
        self.col = 0

    def put(self, ch: str) -> None:
        if ch == "\n":
            self.row = min(self.rows - 1, self.row + 1)
            return
        if ch == "\r":
            self.col = 0
            return
        if ch == "\b":
            self.col = max(0, self.col - 1)
            return
        if ord(ch) < 32 or ord(ch) == 127:
            return
        if 0 <= self.row < self.rows and 0 <= self.col < self.cols:
            self.grid[self.row][self.col] = ch
        self.col += 1
        if self.col >= self.cols:
            self.col = 0
            self.row = min(self.rows - 1, self.row + 1)

    def csi(self, params: str, final: str) -> None:
        values = [int(part) if part.isdigit() else 0 for part in params.replace("?", "").split(";") if part != ""]
        if final in ("H", "f"):
            self.row = max(0, min(self.rows - 1, (values[0] if len(values) > 0 and values[0] else 1) - 1))
            self.col = max(0, min(self.cols - 1, (values[1] if len(values) > 1 and values[1] else 1) - 1))
        elif final == "J" and (not values or values[0] in (0, 2, 3)):
            self.clear()
        elif final == "K":
            mode = values[0] if values else 0
            start = 0 if mode == 1 else self.col
            end = self.cols if mode in (0, 2) else self.col + 1
            for col in range(max(0, start), min(self.cols, end)):
                self.grid[self.row][col] = " "
        elif final == "A":
            self.row = max(0, self.row - (values[0] if values and values[0] else 1))
        elif final == "B":
            self.row = min(self.rows - 1, self.row + (values[0] if values and values[0] else 1))
        elif final == "C":
            self.col = min(self.cols - 1, self.col + (values[0] if values and values[0] else 1))
        elif final == "D":
            self.col = max(0, self.col - (values[0] if values and values[0] else 1))

    def feed(self, data: str) -> None:
        data = self.pending_escape + data
        self.pending_escape = ""
        i = 0
        while i < len(data):
            ch = data[i]
            if ch != "\x1b":
                self.put(ch)
                i += 1
                continue
            if i + 1 >= len(data):
                self.pending_escape = data[i:]
                break
            kind = data[i + 1]
            if kind == "[":
                j = i + 2
                while j < len(data) and not ("@" <= data[j] <= "~"):
                    j += 1
                if j < len(data):
                    self.csi(data[i + 2 : j], data[j])
                    i = j + 1
                else:
                    self.pending_escape = data[i:]
                    break
            elif kind == "]":
                j = data.find("\x07", i + 2)
                st = data.find("\x1b\\", i + 2)
                stops = [pos for pos in (j, st) if pos != -1]
                if stops:
                    stop = min(stops)
                    i = stop + (2 if stop == st else 1)
                else:
                    self.pending_escape = data[i:]
                    break
            else:
                i += 2


SCREEN = Screen()


def clean(text: str) -> str:
    text = ANSI_RE.sub("", text)
    text = text.replace("\r", "\n")
    text = CONTROL_RE.sub("", text)
    return text


def transcript_text() -> str:
    return clean("".join(TRANSCRIPT))


def step(name: str) -> None:
    STEPS.append(name)
    print(f"[real-e2e] {name}", flush=True)


def process_diagnostics(proc: subprocess.Popen) -> str:
    code = proc.poll()
    return "still running" if code is None else f"exited with code {code}"


def set_pty_size(fd: int) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", SCREEN_ROWS, SCREEN_COLS, 0, 0))


def assert_process_running(proc: subprocess.Popen) -> None:
    if proc.poll() is not None:
        raise AssertionError(f"Relay exited before expected UI state: {process_diagnostics(proc)}")


def read_available(fd: int, timeout: float = 0.05) -> str:
    chunks = []
    deadline = time.time() + timeout
    while time.time() < deadline:
        ready, _, _ = select.select([fd], [], [], max(0, deadline - time.time()))
        if not ready:
            break
        try:
            data = os.read(fd, 4096)
        except OSError:
            break
        if not data:
            break
        decoded = data.decode("utf-8", "replace")
        TRANSCRIPT.append(decoded)
        SCREEN.feed(decoded)
        chunks.append(decoded)
    return "".join(chunks)


def wait_for(fd: int, proc: subprocess.Popen, needle: str, timeout: float = 8.0) -> str:
    deadline = time.time() + timeout
    while time.time() < deadline:
        assert_process_running(proc)
        read_available(fd, 0.1)
        screen = SCREEN.text()
        if needle in screen:
            return screen
    raise AssertionError(f"Timed out waiting for {needle!r}. Screen:\n{SCREEN.text()}\n\nTranscript:\n{transcript_text()[-4000:]}")


def send(fd: int, data: str) -> None:
    os.write(fd, data.encode("utf-8"))
    read_available(fd, 0.1)


def send_text(fd: int, text: str) -> None:
    for ch in text:
        send(fd, ch)


def read_agent_events(path: str) -> list:
    if not os.path.exists(path):
        return []
    events = []
    with open(path, "r", encoding="utf-8") as file:
        for line in file:
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(entry, dict):
                events.append(entry)
    return events


def main() -> int:
    framing = os.environ.get("RELAY_WS_AGENT_FRAMING", "json")
    artifacts = os.path.join(ROOT, "test-results", "real-e2e")
    os.makedirs(artifacts, exist_ok=True)
    home = tempfile.mkdtemp(prefix="relay-ws-home-")
    workspace = tempfile.mkdtemp(prefix="relay-ws-workspace-")
    agent_log = os.path.join(workspace, "agent-events.ndjson")
    url_file = os.path.join(workspace, "ws-agent-url.txt")

    agent_env = os.environ.copy()
    agent_env.update({
        "RELAY_WS_AGENT_URL_FILE": url_file,
        "RELAY_WS_AGENT_FRAMING": framing,
        "RELAY_REAL_E2E_PROMPT_LOG": agent_log,
        "RELAY_REAL_E2E_PROMPT_DELAY_MS": "10000",
    })
    agent_path = os.path.join(ROOT, "test", "real-e2e", "acp-websocket-agent.ts")

    env = os.environ.copy()
    env.pop("XDG_CONFIG_HOME", None)
    env.update({
        "HOME": home,
        "TERM": "xterm-256color",
        "NO_COLOR": "1",
        "RELAY_DISABLE_NOTIFICATIONS": "1",
    })

    relay_dir = os.path.join(home, ".config", "relay")
    os.makedirs(relay_dir, exist_ok=True)
    config_path = os.path.join(relay_dir, "config.toml")

    passed = False
    agent_proc = None
    proc = None
    master = None
    try:
        step("start fake websocket ACP agent")
        agent_proc = subprocess.Popen(
            ["bun", "run", agent_path],
            cwd=workspace,
            env=agent_env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )

        step("wait for agent to publish its ws:// url")
        deadline = time.time() + 15
        ws_url = ""
        while time.time() < deadline:
            if agent_proc.poll() is not None:
                raise AssertionError(f"ws agent exited early with code {agent_proc.poll()}")
            if os.path.exists(url_file):
                ws_url = open(url_file, "r", encoding="utf-8").read().strip()
                if ws_url:
                    break
            time.sleep(0.1)
        if not ws_url:
            raise AssertionError("ws agent never published a url")
        print(f"[real-e2e] agent url: {ws_url}", flush=True)

        framing_line = f'framing = "{framing}"\n' if framing != "json" else ""
        with open(config_path, "w", encoding="utf-8") as file:
            file.write(
                '[agents]\n'
                'default = "ws-e2e"\n\n'
                '[agents.runners.ws-e2e]\n'
                'transport = "websocket"\n'
                f'url = "{ws_url}"\n'
                f'{framing_line}'
                'profile = "default"\n'
            )

        command = relay_command(ROOT, "ws-e2e")
        master, slave = pty.openpty()
        set_pty_size(master)
        set_pty_size(slave)
        proc = subprocess.Popen(command, cwd=workspace, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
        os.close(slave)

        step("wait for Relay to connect over websocket")
        wait_for(master, proc, "Connected to", 15)

        step("send a prompt and receive an ack over websocket")
        send_text(master, "hello over websocket")
        send(master, "\r")
        wait_for(master, proc, "ack: hello over websocket", 10)

        step("render a tool call diff over websocket")
        send_text(master, "websocket diff e2e")
        send(master, "\r")
        wait_for(master, proc, "ws_diff_tool", 10)
        wait_for(master, proc, "websocket diff e2e complete", 10)

        step("approve a websocket permission request round-trip")
        send_text(master, "websocket permission e2e")
        send(master, "\r")
        wait_for(master, proc, "Permission Required", 10)
        send(master, "\r")
        wait_for(master, proc, "websocket permission complete", 10)

        step("cancel a slow websocket turn")
        send_text(master, "slow websocket prompt")
        send(master, "\r")
        wait_for(master, proc, "slow websocket prompt", 8)
        send(master, "\x1b")
        wait_for(master, proc, "Interrupted by user", 10)

        step("resume a session over websocket")
        send_text(master, "/resume ws-e2e-session")
        send(master, "\r")
        wait_for(master, proc, "Resumed ACP session: ws-e2e-session", 10)

        step("verify the agent recorded the websocket prompts and approval")
        events = read_agent_events(agent_log)
        prompts = [entry.get("text") for entry in events if entry.get("event") == "prompt"]
        expected_prompts = [
            "hello over websocket",
            "websocket diff e2e",
            "websocket permission e2e",
            "slow websocket prompt",
        ]
        if prompts != expected_prompts:
            raise AssertionError(f"Expected websocket prompts {expected_prompts!r}, got events: {events}")
        approvals = [entry for entry in events if entry.get("event") == "ws-permission-approval"]
        if len(approvals) != 1:
            raise AssertionError(f"Expected exactly one websocket permission approval, got events: {events}")
        outcome = ((approvals[0].get("approval") or {}).get("result") or {}).get("outcome") or {}
        if outcome.get("optionId") != "allow_once":
            raise AssertionError(f"Expected allow_once approval over websocket, got: {approvals[0]}")

        step("exit Relay cleanly")
        send_text(master, "/quit")
        send(master, "\r")
        time.sleep(2)

        passed = True
        return 0
    finally:
        with open(os.path.join(artifacts, "websocket-smoke.steps.txt"), "w", encoding="utf-8") as file:
            file.write("\n".join(STEPS))
        with open(os.path.join(artifacts, "websocket-smoke.transcript.txt"), "w", encoding="utf-8") as file:
            file.write(transcript_text())
        with open(os.path.join(artifacts, "websocket-smoke.screen.txt"), "w", encoding="utf-8") as file:
            file.write(SCREEN.text())
        if os.path.exists(config_path):
            shutil.copyfile(config_path, os.path.join(artifacts, "websocket-smoke.config.toml"))
        for target in (proc, agent_proc):
            if target is None:
                continue
            try:
                os.killpg(target.pid, signal.SIGTERM)
            except (ProcessLookupError, PermissionError):
                pass
            try:
                target.wait(timeout=3)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(target.pid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    pass
                try:
                    target.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    pass
        if master is not None:
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
