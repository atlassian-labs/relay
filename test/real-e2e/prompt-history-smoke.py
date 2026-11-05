#!/usr/bin/env python3
import fcntl
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
import json

from relay_command import relay_command

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCREEN_ROWS = 40
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


def wait_for_history_entry(home: str, proc: subprocess.Popen, needle: str, timeout: float = 8.0) -> str:
    history_path = os.path.join(home, ".config", "relay", "prompt-history.jsonl")
    deadline = time.time() + timeout
    while time.time() < deadline:
        assert_process_running(proc)
        if os.path.exists(history_path):
            with open(history_path, "r", encoding="utf-8") as file:
                history = file.read()
            if needle in history:
                return history
        time.sleep(0.1)
    raise AssertionError(f"Timed out waiting for {needle!r} in {history_path}")


def read_history(home: str) -> str:
    history_path = os.path.join(home, ".config", "relay", "prompt-history.jsonl")
    if not os.path.exists(history_path):
        raise AssertionError(f"Expected durable prompt history at {history_path}")
    with open(history_path, "r", encoding="utf-8") as file:
        return file.read()


def prompt_region() -> str:
    return "\n".join(SCREEN.text().splitlines()[-6:])


def wait_for_prompt(fd: int, proc: subprocess.Popen, needle: str, timeout: float = 3.0) -> str:
    deadline = time.time() + timeout
    while time.time() < deadline:
        assert_process_running(proc)
        read_available(fd, 0.1)
        region = prompt_region()
        if needle in region:
            return region
    raise AssertionError(
        f"Timed out waiting for {needle!r} in prompt region:\n{prompt_region()}\n\nScreen:\n{SCREEN.text()}"
    )


def wait_for_prompt_absent(fd: int, proc: subprocess.Popen, needle: str, timeout: float = 1.0) -> str:
    deadline = time.time() + timeout
    last_region = prompt_region()
    while time.time() < deadline:
        assert_process_running(proc)
        read_available(fd, 0.1)
        last_region = prompt_region()
        if needle in last_region:
            raise AssertionError(f"Unexpected {needle!r} in prompt region:\n{last_region}\n\nScreen:\n{SCREEN.text()}")
    return last_region


def send(fd: int, data: str) -> None:
    os.write(fd, data.encode("utf-8"))
    read_available(fd, 0.1)


def send_text(fd: int, text: str) -> None:
    for ch in text:
        send(fd, ch)


def press_escape(fd: int) -> None:
    os.write(fd, b"\x1b")
    read_available(fd, 0.5)


def press_up(fd: int) -> None:
    send(fd, "\x1b[A")


def press_down(fd: int) -> None:
    send(fd, "\x1b[B")


def assert_screen_lacks(needle: str) -> None:
    screen = SCREEN.text()
    if needle in screen:
        raise AssertionError(f"Unexpected {needle!r} on current terminal screen:\n{screen}")


def append_history_entry(home: str, text: str, session_id: str) -> None:
    history_path = os.path.join(home, ".config", "relay", "prompt-history.jsonl")
    os.makedirs(os.path.dirname(history_path), exist_ok=True)
    with open(history_path, "a", encoding="utf-8") as file:
        file.write(json.dumps({"text": text, "timestamp": "2025-01-01T00:00:00.000Z", "sessionId": session_id}) + "\n")


def launch_relay(home: str, workspace: str, env: dict[str, str], resume_session_id: str | None = None) -> tuple[int, subprocess.Popen]:
    command = relay_command(ROOT, "real-e2e")
    if resume_session_id is not None:
        command.extend(["--resume", resume_session_id])

    master, slave = pty.openpty()
    set_pty_size(master)
    set_pty_size(slave)
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
    return master, proc


def stop_relay(master: int, proc: subprocess.Popen) -> None:
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


def main() -> int:
    artifacts = os.path.join(ROOT, "test-results", "real-e2e")
    os.makedirs(artifacts, exist_ok=True)
    home = tempfile.mkdtemp(prefix="relay-real-e2e-home-")
    workspace = tempfile.mkdtemp(prefix="relay-real-e2e-workspace-")
    env = os.environ.copy()
    env.pop("XDG_CONFIG_HOME", None)
    env.update({
        "HOME": home,
        "TERM": "xterm-256color",
        "NO_COLOR": "1",
        "RELAY_DISABLE_NOTIFICATIONS": "1",
        "RELAY_REAL_E2E_PROMPT_DELAY_MS": "8000",
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
            'profile = "default"\n'
        )

    append_history_entry(home, "seeded global continuation prompt", "older-real-e2e-session")

    step("launch a resumed real ACP session and prove prompt history is global")
    resumed_master, resumed_proc = launch_relay(home, workspace, env, "resumed-real-e2e-session")
    try:
        wait_for(resumed_master, resumed_proc, "Resumed ACP session: resumed-real-e2e-session", 10)
        press_up(resumed_master)
        wait_for_prompt(resumed_master, resumed_proc, "seeded global continuation prompt")
    finally:
        stop_relay(resumed_master, resumed_proc)
        SCREEN.clear()

    step("launch a brand-new real ACP session that uses the same persisted global history")
    master, proc = launch_relay(home, workspace, env)
    passed = False

    try:
        step("wait for Relay to connect to the configured ACP agent")
        wait_for(master, proc, "Connected to", 10)

        step("prove a brand-new real ACP session seeds recall from persisted global history")
        press_up(master)
        wait_for_prompt(master, proc, "seeded global continuation prompt")
        press_escape(master)

        step("submit a normal prompt through the terminal")
        send_text(master, "ordinary real history prompt")
        send(master, "\r")
        wait_for(master, proc, "ack: ordinary real history prompt")

        step("prove local history is recalled before global continuation in the same new session")
        press_up(master)
        wait_for_prompt(master, proc, "ordinary real history prompt")
        press_up(master)
        wait_for_prompt(master, proc, "seeded global continuation prompt")
        press_down(master)
        wait_for_prompt(master, proc, "ordinary real history prompt")
        press_down(master)
        wait_for_prompt_absent(master, proc, "ordinary real history prompt")
        wait_for_prompt_absent(master, proc, "seeded global continuation prompt")
        press_escape(master)

        step("create a second real thread and prove slash command triggers are not recalled")
        send_text(master, "/new")
        send(master, "\r")
        wait_for(master, proc, "New thread")
        press_up(master)
        wait_for_prompt(master, proc, "ordinary real history prompt")
        press_up(master)
        wait_for_prompt(master, proc, "seeded global continuation prompt")
        press_escape(master)
        send_text(master, "second session scoped history prompt")
        send(master, "\r")
        wait_for(master, proc, "ack: second session scoped history prompt")
        wait_for_history_entry(home, proc, "second session scoped history prompt")

        step("prove plain up recalls newest global history first")
        press_up(master)
        wait_for_prompt(master, proc, "second session scoped history prompt")
        press_up(master)
        wait_for_prompt(master, proc, "ordinary real history prompt")
        press_up(master)
        wait_for_prompt(master, proc, "seeded global continuation prompt")
        press_escape(master)

        step("return to a third real thread for broader history behavior")
        send_text(master, "/new")
        send(master, "\r")
        wait_for(master, proc, "New thread")
        send_text(master, "third session ordinary real history prompt")
        send(master, "\r")
        wait_for(master, proc, "ack: third session ordinary real history prompt")

        step("submit /copy and prove slash command triggers are not stored")
        send_text(master, "/copy")
        send(master, "\r")
        time.sleep(0.2)
        history_after_copy = read_history(home)
        if "/copy" in history_after_copy:
            raise AssertionError(f"Prompt history unexpectedly stored /copy:\n{history_after_copy}")

        step("plain up recalls the prior normal prompt instead of the slash command")
        send(master, "\x1b[A")
        wait_for(master, proc, "third session ordinary real history prompt")

        step("restore a non-empty draft after Escape cancels history browsing")
        press_escape(master)
        send_text(master, "draft survives real history")
        press_up(master)
        wait_for(master, proc, "third session ordinary real history prompt")
        press_escape(master)
        wait_for(master, proc, "draft survives real history")

        step("submit a slow prompt so history can be browsed while the real ACP turn is running")
        send(master, "\x03")
        send_text(master, "slow real history prompt")
        send(master, "\r")
        wait_for(master, proc, "Working", 3)

        step("type a draft during the running turn and recall prompt history with plain up")
        send_text(master, "draft while real agent works")
        wait_for_prompt(master, proc, "draft while real agent works")
        press_up(master)
        wait_for_prompt(master, proc, "slow real history prompt")
        wait_for_prompt_absent(master, proc, "draft while real agent works")

        step("continue browsing to older normal history while the turn is still running")
        press_up(master)
        wait_for_prompt(master, proc, "third session ordinary real history prompt")

        step("plain down restores each newer history entry then the running-turn draft")
        press_down(master)
        wait_for_prompt(master, proc, "slow real history prompt")
        press_down(master)
        wait_for_prompt(master, proc, "draft while real agent works")

        step("wait for the slow real ACP turn to finish")
        wait_for(master, proc, "ack: slow real history prompt", 8)

        history = read_history(home)
        history_entries = [json.loads(line) for line in history.splitlines() if line.strip()]
        history_by_text = {entry.get("text"): entry for entry in history_entries}
        for expected in (
            "seeded global continuation prompt",
            "ordinary real history prompt",
            "second session scoped history prompt",
            "third session ordinary real history prompt",
        ):
            if expected not in history_by_text:
                raise AssertionError(f"Prompt history missing {expected!r}:\n{history}")
        expected_session_ids = {
            "ordinary real history prompt": "real-e2e-session",
            "second session scoped history prompt": "real-e2e-session-2",
            "third session ordinary real history prompt": "real-e2e-session-3",
            "slow real history prompt": "real-e2e-session-3",
        }
        for prompt_text, expected_session_id in expected_session_ids.items():
            actual_session_id = history_by_text.get(prompt_text, {}).get("sessionId")
            if actual_session_id != expected_session_id:
                raise AssertionError(
                    f"Prompt history stored {prompt_text!r} with sessionId {actual_session_id!r}; "
                    f"expected {expected_session_id!r}:\n{history}"
                )

        passed = True
        return 0
    finally:
        with open(os.path.join(artifacts, "prompt-history-smoke.steps.txt"), "w", encoding="utf-8") as file:
            file.write("\n".join(STEPS))
        with open(os.path.join(artifacts, "prompt-history-smoke.transcript.txt"), "w", encoding="utf-8") as file:
            file.write(transcript_text())
        with open(os.path.join(artifacts, "prompt-history-smoke.screen.txt"), "w", encoding="utf-8") as file:
            file.write(SCREEN.text())
        config_path = os.path.join(relay_dir, "config.toml")
        history_path = os.path.join(home, ".config", "relay", "prompt-history.jsonl")
        if os.path.exists(config_path):
            shutil.copyfile(config_path, os.path.join(artifacts, "config.toml"))
        if os.path.exists(history_path):
            shutil.copyfile(history_path, os.path.join(artifacts, "prompt-history.jsonl"))
        process_state = process_diagnostics(proc)
        stop_relay(master, proc)
        with open(os.path.join(artifacts, "prompt-history-smoke.process.txt"), "w", encoding="utf-8") as file:
            file.write(process_state)
        if passed:
            shutil.rmtree(home, ignore_errors=True)
            shutil.rmtree(workspace, ignore_errors=True)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as err:
        print(f"real e2e failed: {err}", file=sys.stderr)
        raise
