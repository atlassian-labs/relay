#!/usr/bin/env python3
import fcntl
import glob
import os
import pty
import re
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time
import select

from relay_command import relay_command

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCREEN_ROWS = 42
SCREEN_COLS = 140
CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
TRANSCRIPT: list[str] = []
STEPS: list[str] = []


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
                    continue
                self.pending_escape = data[i:]
                break
            if kind == "]":
                bell = data.find("\x07", i + 2)
                st = data.find("\x1b\\", i + 2)
                stops = [pos for pos in (bell, st) if pos != -1]
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
    print(f"[config-reload-reason-smoke] {name}", flush=True)


def set_pty_size(fd: int) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", SCREEN_ROWS, SCREEN_COLS, 0, 0))


def process_diagnostics(proc: subprocess.Popen) -> str:
    code = proc.poll()
    return "still running" if code is None else f"exited with code {code}"


def assert_process_running(proc: subprocess.Popen) -> None:
    if proc.poll() is not None:
        raise AssertionError(f"Relay exited before expected terminal state: {process_diagnostics(proc)}")


def read_available(fd: int, timeout: float = 0.05) -> str:
    chunks: list[str] = []
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


def wait_for_screen(fd: int, proc: subprocess.Popen, needle: str, timeout: float = 8.0) -> str:
    deadline = time.time() + timeout
    while time.time() < deadline:
        assert_process_running(proc)
        read_available(fd, 0.1)
        screen = SCREEN.text()
        if needle in screen:
            return screen
    raise AssertionError(f"Timed out waiting for {needle!r}. Screen:\n{SCREEN.text()}\n\nTranscript:\n{transcript_text()[-4000:]}")


def wait_for_screen_without(fd: int, proc: subprocess.Popen, needle: str, timeout: float = 8.0) -> str:
    deadline = time.time() + timeout
    while time.time() < deadline:
        assert_process_running(proc)
        read_available(fd, 0.1)
        screen = SCREEN.text()
        if needle not in screen:
            return screen
    raise AssertionError(f"Timed out waiting for {needle!r} to disappear. Screen:\n{SCREEN.text()}")


def relay_log_text(relay_dir: str) -> str:
    log_text = ""
    for path in sorted(glob.glob(os.path.join(relay_dir, "logs", "relay-*.ndjson"))):
        with open(path, "r", encoding="utf-8") as file:
            log_text += file.read()
    return log_text


def wait_for_log(relay_dir: str, *needles: str, timeout: float = 8.0) -> str:
    deadline = time.time() + timeout
    while time.time() < deadline:
        log_text = relay_log_text(relay_dir)
        if all(needle in log_text for needle in needles):
            return log_text
        time.sleep(0.1)
    raise AssertionError(f"Timed out waiting for log needles {needles!r}")


def send_text(fd: int, text: str) -> None:
    for ch in text:
        os.write(fd, ch.encode("utf-8"))
        read_available(fd, 0.02)


def press_enter(fd: int) -> None:
    os.write(fd, b"\r")
    read_available(fd, 0.1)


def write_config(config_path: str, *, vim_keybindings: bool = False) -> None:
    with open(config_path, "w", encoding="utf-8") as file:
        file.write(
            "[ui]\n"
            f"vim_keybindings = {str(vim_keybindings).lower()}\n\n"
            "[agents]\n"
            "default = \"real-e2e\"\n\n"
            "[agents.runners.real-e2e]\n"
            "command = \"bun\"\n"
            f"args = [\"run\", \"{os.path.join(ROOT, 'test', 'real-e2e', 'acp-agent.ts')}\"]\n"
            "profile = \"default\"\n"
        )


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
    try:
        os.close(master)
    except OSError:
        pass


def copy_latest_relay_log(relay_dir: str, target_path: str) -> None:
    logs = sorted(glob.glob(os.path.join(relay_dir, "logs", "relay-*.ndjson")))
    if logs:
        shutil.copyfile(logs[-1], target_path)


def main() -> int:
    artifacts = os.path.join(ROOT, "test-results", "real-e2e")
    os.makedirs(artifacts, exist_ok=True)
    home = tempfile.mkdtemp(prefix="relay-config-reload-home-")
    workspace = tempfile.mkdtemp(prefix="relay-config-reload-workspace-")
    relay_dir = os.path.join(home, ".config", "relay")
    config_path = os.path.join(relay_dir, "config.toml")
    master: int | None = None
    proc: subprocess.Popen | None = None
    passed = False

    try:
        os.makedirs(relay_dir, exist_ok=True)
        write_config(config_path, vim_keybindings=False)

        env = os.environ.copy()
        env.pop("XDG_CONFIG_HOME", None)
        env.update(
            {
                "HOME": home,
                "TERM": "xterm-256color",
                "NO_COLOR": "1",
                "RELAY_DISABLE_NOTIFICATIONS": "1",
                "RELAY_REAL_E2E_FINAL_QUEUE_DELAY_MS": "0",
                "RELAY_REAL_E2E_PROMPT_DELAY_MS": "0",
            }
        )

        step("launch Relay through the real CLI with a valid config")
        command = relay_command(ROOT, "real-e2e")
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

        wait_for_screen(master, proc, "Connected to", 10)

        step("settle a transient valid partial config save without applying defaults")
        partial_start = len(TRANSCRIPT)
        with open(config_path, "w", encoding="utf-8") as file:
            file.write("[ui]\nvim_keybindings = true\n")
        time.sleep(0.18)
        read_available(master, 0.02)
        partial_transcript = clean("".join(TRANSCRIPT[partial_start:]))
        if "-- INSERT --" in partial_transcript or "-- INSERT --" in SCREEN.text():
            raise AssertionError(f"Transient partial config applied before the final save landed:\n{partial_transcript[-2000:]}")
        if "Config reload failed" in partial_transcript:
            raise AssertionError(f"Transient partial config surfaced a reload warning:\n{partial_transcript[-2000:]}")
        if "config.load.error" in relay_log_text(relay_dir):
            raise AssertionError("Transient partial config emitted config.load.error")
        write_config(config_path, vim_keybindings=False)

        step("settle a transient malformed config save without warning")
        transient_start = len(TRANSCRIPT)
        with open(config_path, "w", encoding="utf-8") as file:
            file.write("[notifications\nsound_enabled = true\n")
        time.sleep(0.25)
        read_available(master, 0.2)
        write_config(config_path, vim_keybindings=True)
        wait_for_screen(master, proc, "-- INSERT --", 8)
        transient_transcript = clean("".join(TRANSCRIPT[transient_start:]))
        if "Config reload failed" in transient_transcript:
            raise AssertionError(f"Transient config save surfaced a reload warning:\n{transient_transcript[-2000:]}")
        if "config.load.error" in relay_log_text(relay_dir):
            raise AssertionError("Transient config save emitted config.load.error")
        write_config(config_path, vim_keybindings=False)
        wait_for_screen_without(master, proc, "-- INSERT --", 8)

        step("write persistently malformed TOML through the real config file boundary")
        with open(config_path, "w", encoding="utf-8") as file:
            file.write("[notifications\nsound_enabled = true\n")
        wait_for_screen(master, proc, "Config reload failed; keeping previous settings:", 8)
        wait_for_screen(master, proc, "Expected", 3)
        wait_for_log(relay_dir, "config.load.error", "Expected")

        step("recover with valid TOML and verify the runtime applies it")
        write_config(config_path, vim_keybindings=True)
        wait_for_screen(master, proc, "-- INSERT --", 8)

        step("submit a prompt after recovery through the real ACP protocol boundary")
        send_text(master, "config reload recovered")
        press_enter(master)
        wait_for_screen(master, proc, "ack: config reload recovered", 8)

        passed = True
        return 0
    finally:
        with open(os.path.join(artifacts, "config-reload-reason-smoke.steps.txt"), "w", encoding="utf-8") as file:
            file.write("\n".join(STEPS))
        with open(os.path.join(artifacts, "config-reload-reason-smoke.transcript.txt"), "w", encoding="utf-8") as file:
            file.write(transcript_text())
        with open(os.path.join(artifacts, "config-reload-reason-smoke.screen.txt"), "w", encoding="utf-8") as file:
            file.write(SCREEN.text())
        if os.path.exists(config_path):
            shutil.copyfile(config_path, os.path.join(artifacts, "config-reload-reason-smoke.config.toml"))
        copy_latest_relay_log(relay_dir, os.path.join(artifacts, "config-reload-reason-smoke.relay.ndjson"))
        if proc is not None:
            process_state = process_diagnostics(proc)
            if master is not None:
                stop_relay(master, proc)
            with open(os.path.join(artifacts, "config-reload-reason-smoke.process.txt"), "w", encoding="utf-8") as file:
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
