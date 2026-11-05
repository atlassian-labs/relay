#!/usr/bin/env python3
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
SCREEN_ROWS = 80
SCREEN_COLS = 160
TRANSCRIPT = []
STEPS = []
ANSI_RE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
SELF_ANCHOR_WARNING = "Anchor is the same as the node"
INSERT_BEFORE_WARNING = "being inserted, skipping insertBefore"
STALE_FIRST_CHUNK_RE = re.compile(r"STRESS-FIRST-(?!END\b)\d{3}")


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
        raise AssertionError(f"Relay exited before the expected terminal state: {process_diagnostics(proc)}")


def read_available(fd: int, timeout: float = 0.05) -> str:
    chunks = []
    deadline = time.time() + timeout
    while time.time() < deadline:
        ready, _, _ = select.select([fd], [], [], max(0, deadline - time.time()))
        if not ready:
            break
        try:
            data = os.read(fd, 16384)
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
    raise AssertionError(
        f"Timed out waiting for {needle!r}. Screen:\n{SCREEN.text()}\n\nTranscript:\n{transcript_text()[-6000:]}"
    )


def wait_for_absent(fd: int, proc: subprocess.Popen, needle: str, timeout: float = 1.0) -> str:
    deadline = time.time() + timeout
    last_screen = SCREEN.text()
    while time.time() < deadline:
        assert_process_running(proc)
        read_available(fd, 0.1)
        last_screen = SCREEN.text()
        if needle in last_screen:
            raise AssertionError(f"Unexpected {needle!r} on current terminal screen:\n{last_screen}")
    return last_screen


def send(fd: int, data: str) -> None:
    os.write(fd, data.encode("utf-8"))
    read_available(fd, 0.1)


def read_agent_prompt_texts(path: str) -> list[str]:
    if not os.path.exists(path):
        return []
    prompts = []
    with open(path, "r", encoding="utf-8") as file:
        for line in file:
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            if entry.get("event") == "prompt" and isinstance(entry.get("text"), str):
                prompts.append(entry["text"])
    return prompts


def assert_no_render_warnings(label: str) -> None:
    screen = SCREEN.text()
    transcript = transcript_text()
    for needle in (SELF_ANCHOR_WARNING, INSERT_BEFORE_WARNING, "ACP prompt error"):
        if needle in screen or needle in transcript:
            raise AssertionError(
                f"Unexpected render/protocol warning after {label}: {needle}\n"
                f"Screen:\n{screen}\n\nTranscript tail:\n{transcript[-6000:]}"
            )


def screen_line_index(exact_text: str) -> int:
    for index, line in enumerate(SCREEN.text().splitlines()):
        if line.strip() == exact_text:
            return index
    return -1


def assert_burst_before_queue() -> None:
    screen = SCREEN.text()
    first_end_index = screen_line_index("STRESS-FIRST-END")
    queued_index = screen_line_index("stress queued after burst")
    queued_ack_index = screen_line_index("ack: stress queued after burst")
    if first_end_index == -1 or queued_index == -1 or queued_ack_index == -1:
        raise AssertionError(
            "Expected final stress screen to include standalone first burst completion, queued prompt, and queued ack lines.\n"
            f"Screen:\n{screen}\n\nTranscript tail:\n{transcript_text()[-6000:]}"
        )
    if not first_end_index < queued_index < queued_ack_index:
        raise AssertionError(
            "Queued prompt rendered before the prior ACP burst completed; response ordering raced ahead of updates.\n"
            f"Line indexes: first_end={first_end_index}, queued={queued_index}, ack={queued_ack_index}\nScreen:\n{screen}"
        )
    queued_prompt_offset = screen.find("\nstress queued after burst")
    if queued_prompt_offset == -1:
        queued_prompt_offset = screen.find("stress queued after burst")
    stale_after_queue = STALE_FIRST_CHUNK_RE.search(screen[queued_prompt_offset:])
    if stale_after_queue:
        raise AssertionError(
            "Stale first-turn stress chunks rendered after the queued prompt.\n"
            f"Matched: {stale_after_queue.group(0)}\nScreen:\n{screen}"
        )


def main() -> int:
    artifacts = os.path.join(ROOT, "test-results", "real-e2e")
    os.makedirs(artifacts, exist_ok=True)
    home = tempfile.mkdtemp(prefix="relay-tui-stress-home-")
    workspace = tempfile.mkdtemp(prefix="relay-tui-stress-workspace-")
    agent_events = os.path.join(workspace, "agent-events.ndjson")

    env = os.environ.copy()
    env.pop("XDG_CONFIG_HOME", None)
    env.update({
        "HOME": home,
        "TERM": "xterm-256color",
        "NO_COLOR": "1",
        "RELAY_DISABLE_NOTIFICATIONS": "1",
        "RELAY_REAL_E2E_PROMPT_LOG": agent_events,
    })

    relay_dir = os.path.join(home, ".config", "relay")
    os.makedirs(relay_dir, exist_ok=True)
    agent_path = os.path.join(ROOT, "test", "real-e2e", "acp-agent.ts")
    config_path = os.path.join(relay_dir, "config.toml")
    with open(config_path, "w", encoding="utf-8") as file:
        file.write(
            '[agents]\n'
            'default = "real-e2e"\n\n'
            '[agents.runners.real-e2e]\n'
            'command = "bun"\n'
            f'args = ["run", "{agent_path}"]\n'
            'profile = "default"\n'
        )

    command = relay_command(ROOT, "real-e2e")
    master, slave = pty.openpty()
    set_pty_size(master)
    passed = False
    proc = subprocess.Popen(command, cwd=workspace, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
    os.close(slave)

    try:
        step("wait for Relay to connect to the real ACP subprocess")
        wait_for(master, proc, "Connected to", 10)

        step("start bursty first prompt through the terminal boundary")
        send(master, "real tui stress burst e2e\r")
        wait_for(master, proc, "STRESS-FIRST-START", 8)

        step("queue a second prompt while the first ACP turn is still running")
        send(master, "stress queued after burst\r")
        wait_for(master, proc, "Queue (1/10)", 5)

        step("observe burst completion before the queued prompt is rendered")
        wait_for(master, proc, "STRESS-FIRST-END", 20)
        wait_for(master, proc, "ack: stress queued after burst", 12)
        wait_for_absent(master, proc, "Queue (1/10)", 1)
        read_available(master, 0.5)
        assert_burst_before_queue()
        assert_no_render_warnings("burst queue drain")

        step("probe malformed ACP output without killing Relay")
        send(master, "real tui stress malformed e2e\r")
        wait_for(master, proc, "MALFORMED-STRESS-OK", 8)
        assert_no_render_warnings("malformed ACP probe")

        prompt_texts = read_agent_prompt_texts(agent_events)
        expected_prompts = [
            "real tui stress burst e2e",
            "stress queued after burst",
            "real tui stress malformed e2e",
        ]
        if prompt_texts[:3] != expected_prompts:
            raise AssertionError(f"Expected prompt order {expected_prompts}, got {prompt_texts}")

        passed = True
        return 0
    finally:
        with open(os.path.join(artifacts, "tui-stress-smoke.steps.txt"), "w", encoding="utf-8") as file:
            file.write("\n".join(STEPS))
        with open(os.path.join(artifacts, "tui-stress-smoke.transcript.txt"), "w", encoding="utf-8") as file:
            file.write(transcript_text())
        with open(os.path.join(artifacts, "tui-stress-smoke.screen.txt"), "w", encoding="utf-8") as file:
            file.write(SCREEN.text())
        if os.path.exists(config_path):
            shutil.copyfile(config_path, os.path.join(artifacts, "tui-stress-smoke.config.toml"))
        if os.path.exists(agent_events):
            shutil.copyfile(agent_events, os.path.join(artifacts, "tui-stress-smoke.agent-events.ndjson"))
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
        with open(os.path.join(artifacts, "tui-stress-smoke.process.txt"), "w", encoding="utf-8") as file:
            file.write(process_diagnostics(proc))
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
