#!/usr/bin/env python3
import fcntl
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

from relay_command import relay_command

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
ANSI_RE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
TRANSCRIPT: list[str] = []
STEPS: list[str] = []


def clean(text: str) -> str:
    text = ANSI_RE.sub("", text)
    text = text.replace("\r", "\n")
    return CONTROL_RE.sub("", text)


def step(name: str) -> None:
    STEPS.append(name)
    print(f"[replayed-config-sound-smoke] {name}", flush=True)


def write_sound_shim(path: str) -> None:
    with open(path, "w", encoding="utf-8") as file:
        file.write("#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$RELAY_REAL_E2E_SOUND_LOG\"\n")
    os.chmod(path, 0o755)


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
    decoded = b"".join(chunks).decode("utf-8", errors="replace")
    if decoded:
        TRANSCRIPT.append(decoded)
    return decoded


def process_diagnostics(proc: subprocess.Popen) -> str:
    code = proc.poll()
    return "still running" if code is None else f"exited with code {code}"


def assert_running(proc: subprocess.Popen) -> None:
    if proc.poll() is not None:
        raise AssertionError(f"Relay exited early with code {proc.returncode}")


def wait_for_output(fd: int, proc: subprocess.Popen, needle: str, timeout: float = 8.0) -> str:
    deadline = time.time() + timeout
    seen = ""
    while time.time() < deadline:
        assert_running(proc)
        seen += read_available(fd, 0.1)
        if needle in clean(seen):
            return seen
    raise AssertionError(f"Timed out waiting for {needle!r}. Output tail:\n{clean(seen)[-4000:]}")


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


def assert_sound_count_stays(path: str, expected: int, duration: float, label: str) -> None:
    deadline = time.time() + duration
    while time.time() < deadline:
        events = sound_events(path)
        if len(events) != expected:
            raise AssertionError(f"Expected {expected} notification sound(s) {label}, got {len(events)}: {events}")
        time.sleep(0.05)


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


def main() -> int:
    artifacts = os.path.join(ROOT, "test-results", "real-e2e")
    os.makedirs(artifacts, exist_ok=True)
    home = tempfile.mkdtemp(prefix="relay-replayed-config-home-")
    workspace = tempfile.mkdtemp(prefix="relay-replayed-config-workspace-")
    sound_log = os.path.join(workspace, "notification-sounds.log")
    master: int | None = None
    proc: subprocess.Popen | None = None
    passed = False

    try:
        bin_dir = os.path.join(home, "bin")
        os.makedirs(bin_dir, exist_ok=True)
        write_sound_shim(os.path.join(bin_dir, "afplay"))
        write_sound_shim(os.path.join(bin_dir, "paplay"))

        relay_dir = os.path.join(home, ".config", "relay")
        os.makedirs(relay_dir, exist_ok=True)
        agent_path = os.path.join(ROOT, "test", "real-e2e", "acp-agent.ts")
        config_path = os.path.join(relay_dir, "config.toml")
        with open(config_path, "w", encoding="utf-8") as file:
            file.write(
                "[notifications]\n"
                "sound_enabled = false\n"
                "volume = 0.5\n\n"
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
                "HOME": home,
                "TERM": "xterm-256color",
                "NO_COLOR": "1",
                "PATH": f"{bin_dir}{os.pathsep}{env.get('PATH', '')}",
                "RELAY_REAL_E2E_SOUND_LOG": sound_log,
                "RELAY_REAL_E2E_REPLAY_NOTIFICATION_CONFIG": "1",
                "RELAY_REAL_E2E_FINAL_QUEUE_DELAY_MS": "0",
                "RELAY_REAL_E2E_PROMPT_DELAY_MS": "0",
            }
        )

        step("launch Relay through the real CLI and resume a session")
        command = relay_command(ROOT, "real-e2e") + ["--resume", "replayed-config-session"]
        master, slave = pty.openpty()
        set_pty_size(master)
        set_pty_size(slave)
        flags = fcntl.fcntl(master, fcntl.F_GETFL)
        fcntl.fcntl(master, fcntl.F_SETFL, flags | os.O_NONBLOCK)
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

        wait_for_output(master, proc, "Resumed ACP session: replayed-config-session", 10)
        assert_sound_count_stays(sound_log, 0, 0.5, "during replayed config option history")

        step("verify replayed config option did not rewrite local notification config")
        with open(config_path, "r", encoding="utf-8") as file:
            config_text = file.read()
        if "sound_enabled = false" not in config_text or "sound_enabled = true" in config_text:
            raise AssertionError(f"Expected notifications to remain disabled, config was:\n{config_text}")

        step("submit a normal prompt and prove completion still does not play sound")
        send_text(master, "sound should remain disabled")
        press_enter(master)
        wait_for_output(master, proc, "ack: sound should remain disabled", 8)
        assert_sound_count_stays(sound_log, 0, 1.0, "after completion with notifications disabled")

        passed = True
        return 0
    finally:
        with open(os.path.join(artifacts, "replayed-config-sound-smoke.steps.txt"), "w", encoding="utf-8") as file:
            file.write("\n".join(STEPS))
        with open(os.path.join(artifacts, "replayed-config-sound-smoke.transcript.txt"), "w", encoding="utf-8") as file:
            file.write(clean("".join(TRANSCRIPT)))
        if os.path.exists(sound_log):
            shutil.copyfile(sound_log, os.path.join(artifacts, "replayed-config-sound-smoke.sounds.txt"))
        config_path = os.path.join(home, ".config", "relay", "config.toml")
        if os.path.exists(config_path):
            shutil.copyfile(config_path, os.path.join(artifacts, "replayed-config-sound-smoke.config.toml"))
        if proc is not None:
            process_state = process_diagnostics(proc)
            if master is not None:
                stop_relay(master, proc)
            with open(os.path.join(artifacts, "replayed-config-sound-smoke.process.txt"), "w", encoding="utf-8") as file:
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
