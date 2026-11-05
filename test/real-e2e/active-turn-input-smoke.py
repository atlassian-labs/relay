#!/usr/bin/env python3
import fcntl
import json
import os
import pty
import re
import select
import shutil
import struct
import termios
import signal
import subprocess
import sys
import tempfile
import time

from relay_command import relay_command

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCREEN_ROWS = 40
SCREEN_COLS = 120
TRANSCRIPT = []
STEPS = []
CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
SKILL_SHAPED_ACTIVE_TURN_INPUT = "\n".join(
    [
        '<skill name="real-skill" location="/tmp/real-skill/SKILL.md">',
        "Use the real skill body.",
        "</skill>",
        "",
        "focus on regressions",
    ]
)


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
            start = self.col
            for col in range(max(0, start), self.cols):
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
                    continue
                self.pending_escape = data[i:]
                break
            elif kind == "]":
                j = data.find("\x07", i + 2)
                st = data.find("\x1b\\", i + 2)
                stops = [pos for pos in (j, st) if pos != -1]
                if stops:
                    stop = min(stops)
                    i = stop + (2 if stop == st else 1)
                    continue
                self.pending_escape = data[i:]
                break
            i += 2


SCREEN = Screen()


def clean(text: str) -> str:
    return CONTROL_RE.sub("", text.replace("\r", "\n"))


def transcript_text() -> str:
    return clean("".join(TRANSCRIPT))


def step(name: str) -> None:
    STEPS.append(name)
    print(f"[real-e2e] {name}", flush=True)


def set_pty_size(fd: int) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", SCREEN_ROWS, SCREEN_COLS, 0, 0))


def assert_process_running(proc: subprocess.Popen) -> None:
    if proc.poll() is not None:
        raise AssertionError(f"Relay exited early with code {proc.poll()}")


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


def wait_for_absent(fd: int, proc: subprocess.Popen, needle: str, timeout: float = 1.5) -> str:
    deadline = time.time() + timeout
    while time.time() < deadline:
        assert_process_running(proc)
        read_available(fd, 0.1)
        if needle in SCREEN.text():
            raise AssertionError(f"Unexpected {needle!r} on current terminal screen:\n{SCREEN.text()}")
    return SCREEN.text()


SETTINGS_STARTUP_TIP = "Use /settings to update themes, notifications, and more"


def wait_for_absent_outside_settings_tip(fd: int, proc: subprocess.Popen, needle: str, timeout: float = 1.5) -> str:
    deadline = time.time() + timeout
    while time.time() < deadline:
        assert_process_running(proc)
        read_available(fd, 0.1)
        screen = SCREEN.text()
        if needle in screen.replace(SETTINGS_STARTUP_TIP, ""):
            raise AssertionError(f"Unexpected {needle!r} outside startup tip on current terminal screen:\n{screen}")
    return SCREEN.text()


def read_agent_events(path: str) -> list[dict[str, object]]:
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


def assert_agent_events(path: str) -> None:
    events = read_agent_events(path)
    prompts = [entry.get("text") for entry in events if entry.get("event") == "prompt"]
    active_turn_events = [entry for entry in events if entry.get("event") == "active-turn-input"]
    active_turn_inputs = [entry.get("text") for entry in active_turn_events]
    legacy_requests = [entry for entry in events if entry.get("method") == "_alta/session/steer"]
    expected_prompts = [
        "slow real active-turn prompt",
        "real keypad submit prompt",
        "real keypad line one\nreal keypad line two",
    ]
    expected_active_turn_inputs = [
        "real steering guidance",
        SKILL_SHAPED_ACTIVE_TURN_INPUT,
        "real keypad steering guidance",
    ]
    if prompts != expected_prompts:
        raise AssertionError(f"Expected real ACP prompts {expected_prompts!r} and no slash prompt fallback, got events: {events}")
    if active_turn_inputs != expected_active_turn_inputs:
        raise AssertionError(
            f"Expected ordinary, skill-shaped, and keypad guidance to reach active-turn input, got events: {events}"
        )
    if legacy_requests:
        raise AssertionError(f"Expected steering over session/prompt _meta, got legacy method calls: {legacy_requests}")
    for entry in active_turn_events:
        if entry.get("method") != "session/prompt" or entry.get("hasSteerMeta") is not True or entry.get("accepted") is not True:
            raise AssertionError(f"Expected accepted session/prompt steering metadata events, got: {active_turn_events}")


def send(fd: int, data: str) -> None:
    os.write(fd, data.encode("utf-8"))
    read_available(fd, 0.1)


def send_text(fd: int, text: str) -> None:
    for ch in text:
        send(fd, ch)


def press_option_enter(fd: int) -> None:
    send(fd, "\x1b\r")


def press_escape(fd: int) -> None:
    send(fd, "\x1b")


def press_keypad_enter(fd: int) -> None:
    send(fd, "\x1b[57414u")


def press_shift_keypad_enter(fd: int) -> None:
    send(fd, "\x1b[57414;2u")


def press_option_keypad_enter(fd: int) -> None:
    send(fd, "\x1b[57414;3u")


def press_backspace(fd: int, count: int) -> None:
    for _ in range(count):
        send(fd, "\x7f")


def main() -> int:
    artifacts = os.path.join(ROOT, "test-results", "real-e2e")
    os.makedirs(artifacts, exist_ok=True)
    home = tempfile.mkdtemp(prefix="relay-steering-home-")
    workspace = tempfile.mkdtemp(prefix="relay-steering-workspace-")
    agent_log = os.path.join(workspace, "agent-events.ndjson")
    env = os.environ.copy()
    env.pop("XDG_CONFIG_HOME", None)
    env.update({
        "HOME": home,
        "TERM": "xterm-256color",
        "NO_COLOR": "1",
        "RELAY_DISABLE_NOTIFICATIONS": "1",
        "RELAY_REAL_E2E_PROMPT_DELAY_MS": "12000",
        "RELAY_REAL_E2E_ACTIVE_TURN_INPUT": "1",
        "RELAY_REAL_E2E_PROMPT_LOG": agent_log,
    })

    relay_dir = os.path.join(home, ".config", "relay")
    os.makedirs(relay_dir, exist_ok=True)
    agent_path = os.path.join(ROOT, "test", "real-e2e", "acp-agent.ts")
    with open(os.path.join(relay_dir, "config.toml"), "w", encoding="utf-8") as file:
        file.write(
            '[agents]\n'
            'default = "real-e2e"\n\n'
            '[agents.runners.real-e2e]\n'
            'command = "bun"\n'
            f'args = ["run", "{agent_path}"]\n'
            'profile = "alta"\n'
        )

    command = relay_command(ROOT, "real-e2e")
    master, slave = pty.openpty()
    set_pty_size(master)
    set_pty_size(slave)
    passed = False
    proc = subprocess.Popen(command, cwd=workspace, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
    os.close(slave)

    try:
        step("wait for Relay to connect")
        wait_for(master, proc, "Connected to", 10)

        step("open shortcut reference and verify current-turn action wording")
        send(master, "?")
        wait_for(master, proc, "Keyboard shortcuts", 3)
        wait_for(master, proc, "Add to current turn", 3)
        wait_for_absent(master, proc, "Add active-turn input", 1)
        press_escape(master)
        wait_for_absent(master, proc, "Keyboard shortcuts", 1)

        step("start a slow prompt")
        send_text(master, "slow real active-turn prompt")
        send(master, "\r")
        wait_for(master, proc, "Working", 3)

        step("send guidance to current prompt with option-enter")
        send_text(master, "real steering guidance")
        press_option_enter(master)
        wait_for(master, proc, "Added to current turn", 3)
        wait_for_absent(master, proc, "Queue (1/10)", 1)

        step("observe accepted guidance displayed as current-turn context before the turn completes")
        wait_for(master, proc, "[turn update]", 3)
        wait_for_absent(master, proc, "[current turn]", 1)
        wait_for(master, proc, "real steering guidance", 3)

        step("send skill-shaped guidance to current prompt as literal current-turn text")
        send(master, '<skill name="real-skill" location="/tmp/real-skill/SKILL.md">')
        press_shift_keypad_enter(master)
        send(master, "Use the real skill body.")
        press_shift_keypad_enter(master)
        send(master, "</skill>")
        press_shift_keypad_enter(master)
        press_shift_keypad_enter(master)
        send(master, "focus on regressions")
        press_option_enter(master)
        wait_for(master, proc, "Added to current turn", 3)
        wait_for(master, proc, "[turn update]", 3)
        wait_for(master, proc, '<skill name="real-skill"', 3)
        wait_for(master, proc, "focus on regressions", 3)
        wait_for_absent(master, proc, "[skill] real-skill", 1)
        wait_for_absent(master, proc, "Queue (1/10)", 1)

        step("send guidance to current prompt with option-keypad-enter")
        send_text(master, "real keypad steering guidance")
        press_option_keypad_enter(master)
        wait_for(master, proc, "Added to current turn", 3)
        wait_for(master, proc, "real keypad steering guidance", 3)
        wait_for_absent(master, proc, "Queue (1/10)", 1)

        step("reject slash-shaped guidance without sending it to active-turn input")
        send_text(master, "/settings")
        press_option_enter(master)
        wait_for(master, proc, "Only ordinary prompts can be added to the current turn", 3)
        wait_for(master, proc, "/settings", 3)
        wait_for_absent(master, proc, "Queue (1/10)", 1)

        step("observe final agent output proving steered text reached the same turn")
        wait_for(master, proc, 'guidance: real steering guidance | <skill name="real-skill"', 10)
        wait_for(master, proc, "focus on regressions | real keypad steering guidance", 10)

        step("clear the restored slash-shaped guidance draft")
        press_backspace(master, len("/settings"))
        wait_for_absent_outside_settings_tip(master, proc, "/settings", 1)

        step("submit an idle prompt with keypad enter")
        send_text(master, "real keypad submit prompt")
        press_keypad_enter(master)
        wait_for(master, proc, "ack: real keypad submit prompt", 5)

        step("insert a newline with shift-keypad-enter before submitting with keypad enter")
        send_text(master, "real keypad line one")
        press_shift_keypad_enter(master)
        send_text(master, "real keypad line two")
        press_keypad_enter(master)
        wait_for(master, proc, "ack: real keypad line one ↵ real keypad line two", 5)

        assert_agent_events(agent_log)
        passed = True
        return 0
    finally:
        with open(os.path.join(artifacts, "active-turn-input-smoke.steps.txt"), "w", encoding="utf-8") as file:
            file.write("\n".join(STEPS))
        with open(os.path.join(artifacts, "active-turn-input-smoke.transcript.txt"), "w", encoding="utf-8") as file:
            file.write(transcript_text())
        with open(os.path.join(artifacts, "active-turn-input-smoke.screen.txt"), "w", encoding="utf-8") as file:
            file.write(SCREEN.text())
        if os.path.exists(agent_log):
            shutil.copyfile(agent_log, os.path.join(artifacts, "active-turn-input-smoke.agent-events.ndjson"))
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
