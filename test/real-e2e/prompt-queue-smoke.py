#!/usr/bin/env python3
import fcntl
import os
import pty
import re
import select
import json
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
ANSI_RE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
SELF_ANCHOR_WARNING = "Anchor is the same as the node"
INSERT_BEFORE_WARNING = "being inserted, skipping insertBefore"


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


def reset_terminal_capture() -> None:
    TRANSCRIPT.clear()
    SCREEN.clear()


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
        raise AssertionError(f"Relay process exited before the expected terminal state: {process_diagnostics(proc)}")


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
    raise AssertionError(
        f"Timed out waiting for {needle!r}. Screen:\n{SCREEN.text()}\n\nTranscript:\n{transcript_text()[-4000:]}"
    )


def wait_for_absent(fd: int, proc: subprocess.Popen, needle: str, timeout: float = 1.5) -> str:
    deadline = time.time() + timeout
    last_screen = SCREEN.text()
    while time.time() < deadline:
        assert_process_running(proc)
        read_available(fd, 0.1)
        last_screen = SCREEN.text()
        if needle in last_screen:
            raise AssertionError(f"Unexpected {needle!r} on current terminal screen:\n{last_screen}")
    return last_screen


def assert_no_self_anchor_warning(label: str) -> None:
    screen = SCREEN.text()
    transcript = transcript_text()
    for needle in (SELF_ANCHOR_WARNING, INSERT_BEFORE_WARNING):
        if needle in screen or needle in transcript:
            raise AssertionError(
                f"OpenTUI self-anchor insert warning leaked after {label}.\n"
                f"Screen:\n{screen}\n\nTranscript tail:\n{transcript[-4000:]}"
            )


def screen_after_last(screen: str, marker: str) -> str:
    index = screen.rfind(marker)
    if index == -1:
        raise AssertionError(f"Expected marker {marker!r} on current terminal screen:\n{screen}")
    return screen[index:]


def sound_events(path: str) -> list[str]:
    if not os.path.exists(path):
        return []
    with open(path, "r", encoding="utf-8") as file:
        return [line.strip() for line in file if line.strip()]


def write_sound_shim(path: str, log_path: str) -> None:
    with open(path, "w", encoding="utf-8") as file:
        file.write(
            "#!/bin/sh\n"
            "printf '%s\\n' \"$*\" >> \"$RELAY_REAL_E2E_SOUND_LOG\"\n"
        )
    os.chmod(path, 0o755)


def assert_sound_count(path: str, expected: int, label: str) -> None:
    events = sound_events(path)
    if len(events) != expected:
        raise AssertionError(f"Expected {expected} notification sound(s) {label}, got {len(events)}: {events}")


def wait_for_sound_count(path: str, expected: int, label: str, timeout: float = 2.0) -> None:
    deadline = time.time() + timeout
    events = sound_events(path)
    while time.time() < deadline and len(events) < expected:
        time.sleep(0.05)
        events = sound_events(path)
    if len(events) != expected:
        raise AssertionError(f"Expected {expected} notification sound(s) {label}, got {len(events)}: {events}")


def assert_sound_count_stays(path: str, expected: int, label: str, duration: float = 0.6) -> None:
    deadline = time.time() + duration
    while time.time() < deadline:
        events = sound_events(path)
        if len(events) != expected:
            raise AssertionError(f"Expected {expected} notification sound(s) {label}, got {len(events)}: {events}")
        time.sleep(0.05)


def read_agent_events(path: str) -> list[dict]:
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


def read_agent_prompt_texts(path: str) -> list[str]:
    return [
        entry["text"]
        for entry in read_agent_events(path)
        if entry.get("event") == "prompt" and isinstance(entry.get("text"), str)
    ]


def send(fd: int, data: str) -> None:
    os.write(fd, data.encode("utf-8"))
    read_available(fd, 0.1)


def send_text(fd: int, text: str) -> None:
    for ch in text:
        send(fd, ch)


def press_up(fd: int) -> None:
    send(fd, "\x1b[A")


def press_end(fd: int) -> None:
    send(fd, "\x1b[F")


def press_alt_up(fd: int) -> None:
    send(fd, "\x1b[1;3A")


def press_shift_alt_up(fd: int) -> None:
    send(fd, "\x1b[1;4A")


def press_shift_enter(fd: int) -> None:
    send(fd, "\x1b[13;2u")


def press_ctrl_enter(fd: int) -> None:
    send(fd, "\x1b[13;5u")


def press_escape(fd: int) -> None:
    send(fd, "\x1b")


def press_macos_delete(fd: int) -> None:
    send(fd, "\x7f")


def press_down(fd: int) -> None:
    send(fd, "\x1b[B")


def write_relay_config(relay_dir: str, agent_path: str, notifications_enabled: bool = True) -> None:
    os.makedirs(relay_dir, exist_ok=True)
    with open(os.path.join(relay_dir, "config.toml"), "w", encoding="utf-8") as file:
        file.write(
            "[notifications]\n"
            f"sound_enabled = {str(notifications_enabled).lower()}\n"
            "volume = 0.5\n\n"
            "[agents]\n"
            'default = "real-e2e"\n\n'
            "[agents.runners.real-e2e]\n"
            'command = "bun"\n'
            f'args = ["run", "{agent_path}"]\n'
            'profile = "default"\n'
        )


def run_startup_initial_prompt_queue_smoke(artifacts: str) -> None:
    step("startup queue: boot Relay with delayed ACP session and an initial prompt")
    reset_terminal_capture()
    home = tempfile.mkdtemp(prefix="relay-real-e2e-startup-home-")
    workspace = tempfile.mkdtemp(prefix="relay-real-e2e-startup-workspace-")
    agent_prompt_log = os.path.join(workspace, "startup-agent-prompts.ndjson")
    relay_dir = os.path.join(home, ".config", "relay")
    agent_path = os.path.join(ROOT, "test", "real-e2e", "acp-agent.ts")
    write_relay_config(relay_dir, agent_path, notifications_enabled=False)

    env = os.environ.copy()
    env.pop("XDG_CONFIG_HOME", None)
    env.update({
        "HOME": home,
        "TERM": "xterm-256color",
        "NO_COLOR": "1",
        "RELAY_REAL_E2E_PROMPT_LOG": agent_prompt_log,
        "RELAY_REAL_E2E_SESSION_NEW_DELAY_MS": "6000",
        "RELAY_REAL_E2E_PROMPT_DELAY_MS": "1800",
        "RELAY_REAL_E2E_REJECT_CONCURRENT_PROMPTS": "1",
    })

    initial_prompt = "startup initial real prompt"
    queued_prompt = "startup queued real prompt"
    command = relay_command(ROOT, "real-e2e") + ["--prompt", initial_prompt]
    master, slave = pty.openpty()
    set_pty_size(master)
    set_pty_size(slave)
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
        step("startup queue: type a prompt before ACP session readiness")
        wait_for(master, proc, "\n >", 8)
        send_text(master, queued_prompt)
        send(master, "\r")
        wait_for(master, proc, "Queue (1/10)", 5)
        wait_for(master, proc, f"Queued prompt #1 · {queued_prompt}", 5)

        step("startup queue: initial prompt and queued prompt are serialized after readiness")
        wait_for(master, proc, "Connected to", 10)
        wait_for(master, proc, f"ack: {initial_prompt}", 8)
        wait_for(master, proc, f"ack: {queued_prompt}", 8)
        wait_for_absent(master, proc, "ACP prompt error", 1)

        prompt_texts = read_agent_prompt_texts(agent_prompt_log)
        if prompt_texts != [initial_prompt, queued_prompt]:
            raise AssertionError(f"Expected serialized startup prompts, got {prompt_texts}")
        concurrent_events = [entry for entry in read_agent_events(agent_prompt_log) if entry.get("event") == "concurrent-prompt"]
        if concurrent_events:
            raise AssertionError(f"Startup queue sent concurrent ACP prompts: {concurrent_events}")

        passed = True
    finally:
        with open(os.path.join(artifacts, "prompt-queue-startup.transcript.txt"), "w", encoding="utf-8") as file:
            file.write(transcript_text())
        with open(os.path.join(artifacts, "prompt-queue-startup.screen.txt"), "w", encoding="utf-8") as file:
            file.write(SCREEN.text())
        config_path = os.path.join(relay_dir, "config.toml")
        if os.path.exists(config_path):
            shutil.copyfile(config_path, os.path.join(artifacts, "prompt-queue-startup.config.toml"))
        if os.path.exists(agent_prompt_log):
            shutil.copyfile(agent_prompt_log, os.path.join(artifacts, "prompt-queue-startup.agent-prompts.ndjson"))
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
        with open(os.path.join(artifacts, "prompt-queue-startup.process.txt"), "w", encoding="utf-8") as file:
            file.write(process_diagnostics(proc))
        os.close(master)
        if passed:
            shutil.rmtree(home, ignore_errors=True)
            shutil.rmtree(workspace, ignore_errors=True)


def main() -> int:
    artifacts = os.path.join(ROOT, "test-results", "real-e2e")
    os.makedirs(artifacts, exist_ok=True)
    run_startup_initial_prompt_queue_smoke(artifacts)
    reset_terminal_capture()
    home = tempfile.mkdtemp(prefix="relay-real-e2e-home-")
    workspace = tempfile.mkdtemp(prefix="relay-real-e2e-workspace-")
    bin_dir = os.path.join(home, "bin")
    os.makedirs(bin_dir, exist_ok=True)
    sound_log = os.path.join(workspace, "notification-sounds.log")
    agent_prompt_log = os.path.join(workspace, "agent-prompts.ndjson")
    write_sound_shim(os.path.join(bin_dir, "afplay"), sound_log)
    write_sound_shim(os.path.join(bin_dir, "paplay"), sound_log)

    env = os.environ.copy()
    env.pop("XDG_CONFIG_HOME", None)
    env.update({
        "HOME": home,
        "TERM": "xterm-256color",
        "NO_COLOR": "1",
        "PATH": f"{bin_dir}{os.pathsep}{env.get('PATH', '')}",
        "RELAY_REAL_E2E_SOUND_LOG": sound_log,
        "RELAY_REAL_E2E_PROMPT_LOG": agent_prompt_log,
        "RELAY_REAL_E2E_ADVERTISE_REAL_SKILL_COMMAND": "1",
        "RELAY_REAL_E2E_PROMPT_DELAY_MS": "45000",
        "RELAY_REAL_E2E_FINAL_QUEUE_DELAY_MS": "1200",
    })

    relay_dir = os.path.join(home, ".config", "relay")
    agent_path = os.path.join(ROOT, "test", "real-e2e", "acp-agent.ts")
    write_relay_config(relay_dir, agent_path, notifications_enabled=True)

    command = relay_command(ROOT, "real-e2e")

    master, slave = pty.openpty()
    set_pty_size(master)
    set_pty_size(slave)
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
        step("wait for Relay to connect to the configured ACP agent")
        wait_for(master, proc, "Connected to", 10)

        step("submit one completed prompt so real prompt history has an entry")
        send_text(master, "real queue history prompt")
        send(master, "\r")
        wait_for(master, proc, "ack: real queue history prompt")

        step("advertised slash commands autocomplete in the normal composer")
        send_text(master, "/real-")
        wait_for(master, proc, "agent-side real skill command", 3)
        wait_for(master, proc, "↑/↓ navigate · enter select · esc close", 3)
        press_escape(master)
        send(master, "\x7f" * len("/real-"))
        wait_for_absent(master, proc, "/real-", 1)

        step("submit a slow prompt through the public terminal boundary")
        send_text(master, "slow real queue prompt")
        send(master, "\r")
        wait_for(master, proc, "Working", 3)

        step("queue prompts while the real ACP turn is still running")
        send_text(master, "queued real prompt one")
        send(master, "\r")
        wait_for(master, proc, "Queue (1/10)", 3)
        send_text(master, "queued real prompt two")
        send(master, "\r")
        wait_for(master, proc, "Queue (2/10)", 3)
        wait_for(master, proc, "⌥↑/⌥↓ browse queued prompts", 3)
        step("plain up recalls prompt history and does not enter queue selection")
        press_up(master)
        wait_for(master, proc, "real queue history prompt", 3)
        wait_for_absent(master, proc, "Prompt queue selection", 1)

        step("restore the empty draft before entering queue selection")
        press_down(master)
        read_available(master, 0.5)

        step("alt-up enters non-mutating queue selection through the real terminal escape sequence")
        press_alt_up(master)
        wait_for(master, proc, "❯ Queued prompt #2", 3)
        wait_for(master, proc, "enter edit", 3)

        step("macOS delete removes the selected queue row and focuses the adjacent row")
        press_macos_delete(master)
        wait_for(master, proc, "❯ Queued prompt #1", 3)
        wait_for(master, proc, "Queued prompt #1 · queued real prompt one", 3)
        wait_for_absent(master, proc, "queued real prompt two", 1)

        step("restore the second queued row for queue edit coverage")
        press_escape(master)
        wait_for(master, proc, "Queue (1/10)", 3)
        send_text(master, "queued real prompt two")
        send(master, "\r")
        wait_for(master, proc, "Queue (2/10)", 3)
        press_alt_up(master)
        wait_for(master, proc, "❯ Queued prompt #2", 3)

        step("empty queued edits stay open with actionable feedback")
        send(master, "\r")
        wait_for(master, proc, "enter save", 3)
        send(master, "\x7f" * len("queued real prompt two"))
        send(master, "\r")
        wait_for(master, proc, "Queued prompt cannot be empty", 3)
        wait_for(master, proc, "enter save", 3)
        press_escape(master)
        wait_for(master, proc, "❯ Queued prompt #2", 3)
        wait_for(master, proc, "Queued prompt #2 · queued real prompt two", 3)

        step("enter explicitly edits at the end and escape restores the committed prompt")
        send(master, "\r")
        wait_for(master, proc, "enter save", 3)
        send_text(master, " typed through explicit queue edit")
        wait_for(master, proc, "queued real prompt two typed through explicit queue edit", 3)
        press_escape(master)
        wait_for(master, proc, "❯ Queued prompt #2", 3)
        wait_for_absent(master, proc, "typed through explicit queue edit", 1)

        step("ctrl-enter is guarded while the real ACP turn is still running")
        press_ctrl_enter(master)
        wait_for(master, proc, "Send now is only available after", 3)
        wait_for(master, proc, "enter edit", 3)
        wait_for(master, proc, "queued real prompt one", 3)
        wait_for(master, proc, "queued real prompt two", 3)
        wait_for_absent(master, proc, "ack: queued real prompt one", 1)
        wait_for_absent(master, proc, "ack: queued real prompt two", 1)

        step("escape exits queue selection without interrupting the running prompt")
        press_escape(master)
        wait_for(master, proc, "Queue (2/10)", 3)
        wait_for_absent(master, proc, "Interrupted; 2 queued prompts preserved.", 1)
        press_alt_up(master)
        wait_for(master, proc, "enter edit", 3)

        step("shift-alt-up reorders the selected queued prompt through the real terminal escape sequence")
        press_shift_alt_up(master)
        wait_for(master, proc, "Queued prompt #1 · queued real prompt two", 3)
        wait_for(master, proc, "Queued prompt #2 · queued real prompt one", 3)
        wait_for_absent(master, proc, "1. queued real prompt two", 1)
        assert_no_self_anchor_warning("queue reorder")

        step("escape cancels an active queued prompt edit and clears discarded text")
        wait_for(master, proc, "❯ Queued prompt #1", 3)
        send(master, "\r")
        wait_for(master, proc, "enter save", 3)
        press_end(master)
        send_text(master, " discarded queue edit")
        wait_for(master, proc, "queued real prompt two discarded queue edit", 3)
        press_escape(master)
        wait_for(master, proc, "❯ Queued prompt #1", 3)
        wait_for(master, proc, "Queued prompt #1 · queued real prompt two", 3)
        wait_for(master, proc, "Queued prompt #2 · queued real prompt one", 3)
        wait_for_absent(master, proc, "discarded queue edit", 1)

        step("option-up browses rows and explicit editing supports shift-enter")
        press_escape(master)
        press_alt_up(master)
        wait_for(master, proc, "❯ Queued prompt #2", 3)
        press_alt_up(master)
        wait_for(master, proc, "❯ Queued prompt #1", 3)
        send(master, "\r")
        wait_for(master, proc, "enter save", 3)
        press_end(master)
        send_text(master, " edited")
        wait_for(master, proc, "queued real prompt two edited", 3)
        assert_no_self_anchor_warning("post-reorder queued prompt edit")
        press_shift_enter(master)
        send_text(master, "second line")
        send(master, "\r")
        wait_for(master, proc, "Queue (2/10)", 3)
        wait_for(master, proc, "queued real prompt two edited", 3)

        step("escape interrupts the running prompt and preserves queued prompts")
        press_escape(master)
        screen = wait_for(master, proc, "Interrupted; 2 queued prompts preserved.", 3)
        if "✓ Interrupted; 2 queued prompts preserved." in screen:
            raise AssertionError(f"Expected interruption without success checkmark. Screen:\n{screen}")
        wait_for(master, proc, "Use ⌥↑/⌥↓ to manage queue.", 3)
        wait_for(master, proc, "Queue (2/10)", 3)
        wait_for(master, proc, "queued real prompt two edited", 3)
        wait_for(master, proc, "queued real prompt one", 3)

        step("ctrl-enter sends one focused queued prompt after interrupt and then drains the rest")
        wait_for_sound_count(sound_log, 1, "after the completed history prompt")
        assert_sound_count_stays(sound_log, 1, "after the interrupted prompt and before send-now")
        press_alt_up(master)
        wait_for(master, proc, "❯ Queued prompt #2", 3)
        press_ctrl_enter(master)
        wait_for(master, proc, "Sent queued prompt #2", 3)
        wait_for(master, proc, "ack: queued real prompt one", 5)
        assert_sound_count_stays(sound_log, 1, "after send-now completes while the remaining queue is draining", 0.5)
        wait_for(master, proc, "ack: queued real prompt two edited ↵ second line", 5)
        wait_for_sound_count(sound_log, 2, "after the final queued prompt completes with no remaining queue")
        wait_for_absent(master, proc, "Queue (1/10)", 1)
        prompt_texts = read_agent_prompt_texts(agent_prompt_log)
        expected_queue_tail = [
            "slow real queue prompt",
            "queued real prompt one",
            "queued real prompt two edited\nsecond line",
        ]
        if prompt_texts[-len(expected_queue_tail) :] != expected_queue_tail:
            raise AssertionError(f"Expected send-now to drain remaining queue in order, got {prompt_texts}")
        if any("discarded queue edit" in text for text in prompt_texts):
            raise AssertionError(f"Cancelled queued prompt edit leaked to ACP prompt log: {prompt_texts}")

        step("queue an ACP-advertised slash command as literal text and edit the full command")
        send_text(master, "slow real queue prompt")
        send(master, "\r")
        wait_for(master, proc, "Working", 3)
        send_text(master, "/real-skill")
        send(master, "\r")
        wait_for(master, proc, "Queue (1/10)", 3)
        wait_for(master, proc, "Queued prompt #1 · /real-skill", 3)
        press_alt_up(master)
        wait_for(master, proc, "❯ Queued prompt #1", 3)
        send(master, "\r")
        wait_for(master, proc, "enter save", 3)
        wait_for(master, proc, "Queued prompt #1 · /real-skill", 3)
        wait_for_absent(master, proc, "agent-side real skill command", 1)
        wait_for_absent(master, proc, "↑/↓ · enter · esc", 1)
        press_end(master)
        send_text(master, " main branch plus tags")
        wait_for_absent(master, proc, "agent-side real skill command", 1)
        wait_for_absent(master, proc, "↑/↓ · enter · esc", 1)
        send(master, "\r")
        wait_for(master, proc, "Queue (1/10)", 3)
        wait_for(master, proc, "/real-skill main branch plus tags", 3)
        press_escape(master)
        wait_for(master, proc, "Interrupted; 1 queued prompt preserved.", 3)
        send_text(master, "drain queued slash command")
        send(master, "\r")
        wait_for(master, proc, "ack: drain queued slash command", 5)
        wait_for(master, proc, "ack: /real-skill main branch plus tags", 5)
        prompt_texts = read_agent_prompt_texts(agent_prompt_log)
        literal_skill_prompts = [text for text in prompt_texts if text.startswith("/real-skill")]
        if literal_skill_prompts != ["/real-skill main branch plus tags"]:
            raise AssertionError(f"Expected edited literal ACP slash prompt, got {literal_skill_prompts}")
        if any('<skill name="real-skill"' in text for text in prompt_texts):
            raise AssertionError(f"Expected no Relay-local skill expansion, got {prompt_texts}")
        assert_no_self_anchor_warning("complete prompt queue smoke")

        passed = True
        return 0
    finally:
        with open(os.path.join(artifacts, "prompt-queue-smoke.steps.txt"), "w", encoding="utf-8") as file:
            file.write("\n".join(STEPS))
        with open(os.path.join(artifacts, "prompt-queue-smoke.transcript.txt"), "w", encoding="utf-8") as file:
            file.write(transcript_text())
        with open(os.path.join(artifacts, "prompt-queue-smoke.screen.txt"), "w", encoding="utf-8") as file:
            file.write(SCREEN.text())
        config_path = os.path.join(relay_dir, "config.toml")
        if os.path.exists(config_path):
            shutil.copyfile(config_path, os.path.join(artifacts, "prompt-queue-smoke.config.toml"))
        if os.path.exists(sound_log):
            shutil.copyfile(sound_log, os.path.join(artifacts, "prompt-queue-smoke.notification-sounds.log"))
        if os.path.exists(agent_prompt_log):
            shutil.copyfile(agent_prompt_log, os.path.join(artifacts, "prompt-queue-smoke.agent-prompts.ndjson"))
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
        with open(os.path.join(artifacts, "prompt-queue-smoke.process.txt"), "w", encoding="utf-8") as file:
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
