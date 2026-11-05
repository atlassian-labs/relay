#!/usr/bin/env python3
import fcntl
import os
import pty
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


def set_pty_size(fd: int, rows: int = 30, cols: int = 100) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def read_available(fd: int, timeout: float = 0.05) -> str:
    deadline = time.time() + timeout
    chunks: list[bytes] = []
    while time.time() < deadline:
        try:
            data = os.read(fd, 4096)
            if data:
                chunks.append(data)
                continue
        except BlockingIOError:
            pass
        except OSError:
            break
        time.sleep(0.01)
    return b"".join(chunks).decode("utf-8", errors="replace")


def assert_running(proc: subprocess.Popen) -> None:
    if proc.poll() is not None:
        raise AssertionError(f"Relay exited early with code {proc.returncode}")


def wait_for_output(fd: int, proc: subprocess.Popen, needle: str, timeout: float = 8.0) -> str:
    deadline = time.time() + timeout
    seen = ""
    while time.time() < deadline:
        assert_running(proc)
        seen += read_available(fd, 0.1)
        if needle in seen:
            return seen
    raise AssertionError(f"Timed out waiting for {needle!r}. Output tail:\n{seen[-4000:]}")


def send_text(fd: int, text: str) -> None:
    os.write(fd, text.encode("utf-8"))
    read_available(fd, 0.1)


def press_enter(fd: int) -> None:
    os.write(fd, b"\r")


def sound_events(path: str) -> list[str]:
    if not os.path.exists(path):
        return []
    with open(path, "r", encoding="utf-8") as file:
        return [line.strip() for line in file if line.strip()]


def wait_for_sound_count(path: str, expected: int, timeout: float = 1.5) -> list[str]:
    deadline = time.time() + timeout
    events = sound_events(path)
    while time.time() < deadline and len(events) < expected:
        time.sleep(0.05)
        events = sound_events(path)
    if len(events) != expected:
        raise AssertionError(f"Expected {expected} notification sound(s), got {len(events)}: {events}")
    return events


def assert_sound_count_stays(path: str, expected: int, duration: float, label: str) -> None:
    deadline = time.time() + duration
    while time.time() < deadline:
        events = sound_events(path)
        if len(events) != expected:
            raise AssertionError(f"Expected {expected} notification sound(s) {label}, got {len(events)}: {events}")
        time.sleep(0.05)


def write_sound_shim(path: str) -> None:
    with open(path, "w", encoding="utf-8") as file:
        file.write("#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$RELAY_REAL_E2E_SOUND_LOG\"\n")
    os.chmod(path, 0o755)


class RelayHarness:
    def __init__(self, name: str, config_notifications: str, extra_env: dict[str, str] | None = None):
        self.name = name
        self.home = tempfile.mkdtemp(prefix=f"relay-sound-{name}-home-")
        self.workspace = tempfile.mkdtemp(prefix=f"relay-sound-{name}-workspace-")
        self.proc: subprocess.Popen | None = None
        self.master: int | None = None
        self.sound_log = os.path.join(self.workspace, "notification-sounds.log")
        self.config_notifications = config_notifications
        self.extra_env = extra_env or {}

    def __enter__(self) -> "RelayHarness":
        bin_dir = os.path.join(self.home, "bin")
        os.makedirs(bin_dir, exist_ok=True)
        write_sound_shim(os.path.join(bin_dir, "afplay"))
        write_sound_shim(os.path.join(bin_dir, "paplay"))

        relay_dir = os.path.join(self.home, ".config", "relay")
        os.makedirs(relay_dir, exist_ok=True)
        agent_path = os.path.join(ROOT, "test", "real-e2e", "acp-agent.ts")
        with open(os.path.join(relay_dir, "config.toml"), "w", encoding="utf-8") as file:
            file.write(
                "[notifications]\n"
                f"{self.config_notifications}\n\n"
                "[agents]\n"
                "default = \"real-e2e\"\n\n"
                "[agents.runners.real-e2e]\n"
                "command = \"bun\"\n"
                f"args = [\"run\", \"{agent_path}\"]\n"
                "profile = \"default\"\n"
            )

        env = os.environ.copy()
        env.pop("XDG_CONFIG_HOME", None)
        env.update(
            {
                "HOME": self.home,
                "TERM": "xterm-256color",
                "NO_COLOR": "1",
                "PATH": f"{bin_dir}{os.pathsep}{env.get('PATH', '')}",
                "RELAY_REAL_E2E_SOUND_LOG": self.sound_log,
                "RELAY_REAL_E2E_FINAL_QUEUE_DELAY_MS": "0",
                "RELAY_REAL_E2E_PROMPT_DELAY_MS": "0",
                **self.extra_env,
            }
        )

        master, slave = pty.openpty()
        self.master = master
        set_pty_size(master)
        set_pty_size(slave)
        flags = fcntl.fcntl(master, fcntl.F_GETFL)
        fcntl.fcntl(master, fcntl.F_SETFL, flags | os.O_NONBLOCK)
        self.proc = subprocess.Popen(
            relay_command(ROOT, "real-e2e"),
            cwd=self.workspace,
            env=env,
            stdin=slave,
            stdout=slave,
            stderr=slave,
            start_new_session=True,
        )
        os.close(slave)
        wait_for_output(self.master, self.proc, "Connected to", 10)
        assert_sound_count_stays(self.sound_log, 0, 0.6, "before any prompt is submitted")
        return self

    def __exit__(self, _exc_type: object, _exc: object, _tb: object) -> None:
        if self.proc is not None:
            try:
                os.killpg(self.proc.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                self.proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(self.proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                self.proc.wait(timeout=2)
        if self.master is not None:
            try:
                os.close(self.master)
            except OSError:
                pass
        shutil.rmtree(self.home, ignore_errors=True)
        shutil.rmtree(self.workspace, ignore_errors=True)

    def submit_and_wait(self, prompt: str, expected_output: str, timeout: float = 8.0) -> None:
        if self.master is None or self.proc is None:
            raise AssertionError("RelayHarness is not running")
        send_text(self.master, prompt)
        press_enter(self.master)
        wait_for_output(self.master, self.proc, expected_output, timeout)


def test_empty_queue_completion_plays() -> None:
    with RelayHarness(
        "empty-queue-completion",
        "sound_enabled = true\nvolume = 0.5",
    ) as relay:
        relay.submit_and_wait("plain empty queue prompt", "ack: plain empty queue prompt")
        events = wait_for_sound_count(relay.sound_log, 1)
        print(f"[completion-sound-smoke] empty queue completion: {events}")


def test_tool_turn_empty_queue_completion_plays() -> None:
    with RelayHarness(
        "empty-queue-tool-turn",
        "sound_enabled = true\nvolume = 0.5",
    ) as relay:
        relay.submit_and_wait("normalized diff e2e", "normalized diff e2e complete")
        events = wait_for_sound_count(relay.sound_log, 1)
        print(f"[completion-sound-smoke] empty queue tool turn completion: {events}")


def main() -> int:
    test_empty_queue_completion_plays()
    test_tool_turn_empty_queue_completion_plays()
    return 0


if __name__ == "__main__":
    sys.exit(main())
