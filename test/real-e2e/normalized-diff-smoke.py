#!/usr/bin/env python3
import fcntl
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
TEST_LIB = os.path.join(ROOT, "test", "lib")
if TEST_LIB not in sys.path:
    sys.path.insert(0, TEST_LIB)

from real_e2e_chat_autoscroll import Screen
SCREEN_ROWS = 40
SCREEN_COLS = 140
SCREEN = Screen(SCREEN_ROWS, SCREEN_COLS)
ANSI_RE = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x1b]*(?:\x07|\x1b\\)|[@-_])")
TRANSCRIPT: list[str] = []


def clean(text: str) -> str:
    return ANSI_RE.sub("", text).replace("\r", "")


def transcript_text() -> str:
    return clean("".join(TRANSCRIPT))


def set_pty_size(fd: int) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", SCREEN_ROWS, SCREEN_COLS, 0, 0))


def read_available(fd: int, timeout: float = 0.1) -> str:
    chunks: list[str] = []
    while True:
        ready, _, _ = select.select([fd], [], [], timeout)
        if not ready:
            break
        try:
            data = os.read(fd, 65536)
        except OSError:
            break
        if not data:
            break
        decoded = data.decode("utf-8", "replace")
        TRANSCRIPT.append(decoded)
        SCREEN.feed(decoded)
        chunks.append(decoded)
        timeout = 0
    return "".join(chunks)


def assert_process_running(proc: subprocess.Popen) -> None:
    code = proc.poll()
    if code is not None:
        raise AssertionError(f"Relay exited with {code}. Transcript:\n{transcript_text()[-4000:]}")


def wait_for(fd: int, proc: subprocess.Popen, needle: str, timeout: float = 10.0) -> str:
    deadline = time.time() + timeout
    while time.time() < deadline:
        assert_process_running(proc)
        read_available(fd, 0.1)
        text = transcript_text()
        if needle in text:
            return text
    raise AssertionError(f"Timed out waiting for {needle!r}. Transcript:\n{transcript_text()[-6000:]}")


def wait_for_screen(fd: int, proc: subprocess.Popen, needle: str, timeout: float = 5.0) -> str:
    deadline = time.time() + timeout
    while time.time() < deadline:
        assert_process_running(proc)
        read_available(fd, 0.1)
        screen = SCREEN.text()
        if needle in screen:
            return screen
    raise AssertionError(f"Timed out waiting for visible {needle!r}. Screen:\n{SCREEN.text()}")


def send(fd: int, data: str) -> None:
    os.write(fd, data.encode("utf-8"))
    read_available(fd, 0.1)


def main() -> int:
    home = tempfile.mkdtemp(prefix="relay-real-diff-home-")
    workspace = tempfile.mkdtemp(prefix="relay-real-diff-workspace-")
    master, slave = pty.openpty()
    proc: subprocess.Popen | None = None
    try:
        relay_dir = os.path.join(home, ".config", "relay")
        os.makedirs(relay_dir, exist_ok=True)
        os.makedirs(os.path.join(workspace, "src"), exist_ok=True)
        agent_path = os.path.join(ROOT, "test", "real-e2e", "acp-agent.ts")
        with open(os.path.join(relay_dir, "config.toml"), "w", encoding="utf-8") as file:
            file.write(
                '[agents]\n'
                'default = "real-diff"\n\n'
                '[agents.runners.real-diff]\n'
                'command = "bun"\n'
                f'args = ["run", "{agent_path}"]\n'
                'profile = "default"\n'
            )
        env = os.environ.copy()
        env.pop("XDG_CONFIG_HOME", None)
        env.update({"HOME": home, "TERM": "xterm-256color", "NO_COLOR": "1", "RELAY_DISABLE_NOTIFICATIONS": "1"})
        set_pty_size(master)
        set_pty_size(slave)
        proc = subprocess.Popen(
            relay_command(ROOT, "real-diff"),
            cwd=workspace,
            env=env,
            stdin=slave,
            stdout=slave,
            stderr=slave,
            start_new_session=True,
        )
        os.close(slave)
        wait_for(master, proc, "Connected to", 10)
        send(master, "normalized diff e2e\r")
        wait_for(master, proc, "normalized diff e2e complete", 10)
        screen = wait_for_screen(master, proc, "src/relay-real-diff.txt", 5)
        for needle in ["custom_diff_tool", "BETA", "gamma", "+2", "-1"]:
            if needle not in screen:
                raise AssertionError(f"Missing visible diff proof {needle!r}. Screen:\n{screen}")
        return 0
    finally:
        if proc is not None and proc.poll() is None:
            os.killpg(proc.pid, signal.SIGTERM)
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL)
        try:
            os.close(master)
        except OSError:
            pass
        shutil.rmtree(home, ignore_errors=True)
        shutil.rmtree(workspace, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
