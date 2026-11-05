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
ARTIFACTS = os.path.join(ROOT, "test-results", "real-e2e")


def set_pty_size(fd: int, rows: int = 30, cols: int = 100) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def read_available(fd: int, timeout: float = 0.05) -> bytes:
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
    return b"".join(chunks)


def text(data: bytes) -> str:
    return data.decode("utf-8", errors="replace")


def assert_running(proc: subprocess.Popen) -> None:
    if proc.poll() is not None:
        raise AssertionError(f"Relay exited early with code {proc.returncode}")


def wait_for_output(fd: int, proc: subprocess.Popen, needle: str, transcript: list[bytes], timeout: float = 8.0) -> bytes:
    deadline = time.time() + timeout
    seen = b""
    encoded = needle.encode("utf-8")
    while time.time() < deadline:
        assert_running(proc)
        chunk = read_available(fd, 0.1)
        if chunk:
            transcript.append(chunk)
            seen += chunk
        if encoded in seen:
            return seen
    raise AssertionError(f"Timed out waiting for {needle!r}. Output tail:\n{text(seen[-4000:])}")


def wait_for_bytes(
    fd: int,
    proc: subprocess.Popen,
    needle: bytes,
    transcript: list[bytes],
    timeout: float = 4.0,
) -> bytes:
    deadline = time.time() + timeout
    seen = b"".join(transcript)
    if needle in seen:
        return seen
    while time.time() < deadline:
        assert_running(proc)
        chunk = read_available(fd, 0.1)
        if chunk:
            transcript.append(chunk)
            seen += chunk
        if needle in seen:
            return seen
    raise AssertionError(f"Timed out waiting for terminal notification bytes {needle!r}. Output tail:\n{text(seen[-4000:])}")


def collect_for(fd: int, proc: subprocess.Popen, transcript: list[bytes], duration: float) -> bytes:
    deadline = time.time() + duration
    seen = b""
    while time.time() < deadline:
        assert_running(proc)
        chunk = read_available(fd, 0.1)
        if chunk:
            transcript.append(chunk)
            seen += chunk
    return seen


def send_text(fd: int, value: str) -> None:
    os.write(fd, value.encode("utf-8"))
    read_available(fd, 0.1)


def press_enter(fd: int) -> None:
    os.write(fd, b"\r")


def write_sound_shim(path: str) -> None:
    with open(path, "w", encoding="utf-8") as file:
        file.write("#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$RELAY_REAL_E2E_SOUND_LOG\"\n")
    os.chmod(path, 0o755)


def terminate_process(proc: subprocess.Popen, sig: signal.Signals) -> None:
    try:
        os.killpg(os.getpgid(proc.pid), sig)
    except ProcessLookupError:
        pass
    except OSError:
        pass
    try:
        os.kill(proc.pid, sig)
    except ProcessLookupError:
        pass
    except OSError:
        pass


class RelayHarness:
    def __init__(
        self,
        name: str,
        terminal_enabled: bool,
        notification_protocol: str | None = None,
        extra_env: dict[str, str] | None = None,
    ):
        self.name = name
        self.terminal_enabled = terminal_enabled
        self.notification_protocol = notification_protocol
        self.extra_env = extra_env or {}
        self.home = tempfile.mkdtemp(prefix=f"relay-terminal-notification-{name}-home-")
        self.workspace = tempfile.mkdtemp(prefix=f"relay-terminal-notification-{name}-workspace-")
        self.master: int | None = None
        self.proc: subprocess.Popen | None = None
        self.transcript: list[bytes] = []
        self.sound_log = os.path.join(self.workspace, "notification-sounds.log")

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
                f"terminal_enabled = {str(self.terminal_enabled).lower()}\n"
                "sound_enabled = true\n"
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
                "HOME": self.home,
                "TERM": "xterm-256color",
                "NO_COLOR": "1",
                "PATH": f"{bin_dir}{os.pathsep}{env.get('PATH', '')}",
                "RELAY_REAL_E2E_SOUND_LOG": self.sound_log,
                "RELAY_REAL_E2E_FINAL_QUEUE_DELAY_MS": "0",
                "RELAY_REAL_E2E_PROMPT_DELAY_MS": "0",
            }
        )
        if self.notification_protocol:
            env["OPENTUI_NOTIFICATION_PROTOCOL"] = self.notification_protocol
        env.update(self.extra_env)

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
        wait_for_output(master, self.proc, "Connected to", self.transcript, 10)
        return self

    def __exit__(self, _exc_type: object, _exc: object, _tb: object) -> None:
        if self.master is not None:
            try:
                os.close(self.master)
            except OSError:
                pass
            self.master = None
        if self.proc is not None:
            terminate_process(self.proc, signal.SIGTERM)
            try:
                self.proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                terminate_process(self.proc, signal.SIGKILL)
                self.proc.wait(timeout=2)
        write_artifact(f"terminal-notification-smoke.{self.name}.raw.txt", b"".join(self.transcript))
        if os.path.exists(self.sound_log):
            shutil.copyfile(self.sound_log, os.path.join(ARTIFACTS, f"terminal-notification-smoke.{self.name}.sounds.txt"))
        shutil.rmtree(self.home, ignore_errors=True)
        shutil.rmtree(self.workspace, ignore_errors=True)

    def submit_and_wait(self, prompt: str, expected_output: str) -> bytes:
        if self.master is None or self.proc is None:
            raise AssertionError("RelayHarness is not running")
        send_text(self.master, prompt)
        press_enter(self.master)
        return wait_for_output(self.master, self.proc, expected_output, self.transcript, 8)


def write_artifact(name: str, data: bytes) -> None:
    os.makedirs(ARTIFACTS, exist_ok=True)
    with open(os.path.join(ARTIFACTS, name), "wb") as file:
        file.write(data)


def test_osc777_completion_notification() -> None:
    prompt = "terminal notification osc777 e2e"
    expected_message = b"\x1b]777;notify;Relay;ack: terminal notification osc777 e2e\x1b\\"
    with RelayHarness("osc777", True, notification_protocol="osc777") as relay:
        relay.submit_and_wait(prompt, f"ack: {prompt}")
        assert relay.master is not None and relay.proc is not None
        wait_for_bytes(relay.master, relay.proc, expected_message, relay.transcript, 4)
        print("[terminal-notification-smoke] observed OSC 777 completion notification")


def assert_no_terminal_notification_bytes(label: str, emitted: bytes) -> None:
    if b"\x1b]777;notify;Relay;" in emitted or b"\x1b]9;" in emitted or b"\x1b]99;" in emitted:
        raise AssertionError(f"{label} emitted terminal notification bytes: {emitted!r}")


def test_terminal_enabled_false_suppresses_terminal_notification() -> None:
    prompt = "terminal notification off e2e"
    with RelayHarness("off", False, notification_protocol="osc777") as relay:
        during_completion = relay.submit_and_wait(prompt, f"ack: {prompt}")
        assert relay.master is not None and relay.proc is not None
        emitted = during_completion + collect_for(relay.master, relay.proc, relay.transcript, 1.0)
        assert_no_terminal_notification_bytes("terminal_enabled=false", emitted)
        print("[terminal-notification-smoke] terminal_enabled=false suppressed terminal notification bytes")


def test_opentui_notifications_env_suppresses_terminal_notification() -> None:
    prompt = "terminal notification opentui disabled e2e"
    with RelayHarness(
        "opentui-off",
        True,
        notification_protocol="osc777",
        extra_env={"OPENTUI_NOTIFICATIONS": "0"},
    ) as relay:
        during_completion = relay.submit_and_wait(prompt, f"ack: {prompt}")
        assert relay.master is not None and relay.proc is not None
        emitted = during_completion + collect_for(relay.master, relay.proc, relay.transcript, 1.0)
        assert_no_terminal_notification_bytes("OPENTUI_NOTIFICATIONS=0", emitted)
        print("[terminal-notification-smoke] OPENTUI_NOTIFICATIONS=0 suppressed terminal notification bytes")


def main() -> int:
    os.makedirs(ARTIFACTS, exist_ok=True)
    test_osc777_completion_notification()
    test_terminal_enabled_false_suppresses_terminal_notification()
    test_opentui_notifications_env_suppresses_terminal_notification()
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as err:
        print(f"real e2e failed: {err}", file=sys.stderr)
        raise
