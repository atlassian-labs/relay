#!/usr/bin/env python3
import fcntl
import os
import pty
import select
import shlex
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
SHELL_PROMPT = b"RELAY_EXIT_MOUSE_SHELL> "
MOUSE_ENABLE = b"\x1b[?1003h"
MOUSE_DISABLE = b"\x1b[?1003l"
MOUSE_REPORT = b"\x1b[<35;78;78M"
MOUSE_REPORT_SUFFIX = b"35;78;78M"
SHUTDOWN_TRIGGERS = {"ctrl-c", "/exit", ":q"}


def set_pty_size(fd: int, rows: int = 30, cols: int = 120) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def read_available(fd: int, transcript: bytearray, timeout: float = 0.05) -> bytes:
    chunks: list[bytes] = []
    deadline = time.time() + timeout
    while time.time() < deadline:
        ready, _, _ = select.select([fd], [], [], max(0, deadline - time.time()))
        if not ready:
            break
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        if not chunk:
            break
        chunks.append(chunk)
        transcript.extend(chunk)
        deadline = time.time() + 0.02
    return b"".join(chunks)


def wait_for(
    fd: int,
    proc: subprocess.Popen[bytes],
    transcript: bytearray,
    predicate,
    description: str,
    timeout: float = 10.0,
) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if proc.poll() is not None:
            raise AssertionError(f"shell exited while waiting for {description}: {proc.returncode}")
        read_available(fd, transcript, 0.1)
        if predicate(bytes(transcript)):
            return
    raise AssertionError(f"timed out waiting for {description}; transcript tail: {bytes(transcript[-4000:])!r}")


def write_config(home: str) -> None:
    relay_dir = os.path.join(home, ".config", "relay")
    os.makedirs(relay_dir, exist_ok=True)
    agent_path = os.path.join(ROOT, "test", "real-e2e", "acp-agent.ts")
    with open(os.path.join(relay_dir, "config.toml"), "w", encoding="utf-8") as file:
        file.write(
            'default = "real-e2e"\n\n'
            '[agents.runners.real-e2e]\n'
            'command = "bun"\n'
            f'args = ["{agent_path}"]\n'
            'profile = "default"\n'
        )

    plugin_dir = os.path.join(relay_dir, "plugins", "exit-mouse-shutdown-delay")
    os.makedirs(plugin_dir, exist_ok=True)
    with open(os.path.join(plugin_dir, "index.mjs"), "w", encoding="utf-8") as file:
        file.write(
            'import { access, writeFile } from "node:fs/promises";\n\n'
            'const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));\n\n'
            'export default function exitMouseShutdownDelay(relay) {\n'
            '  relay.on("relay:shutdown", async () => {\n'
            '    await writeFile(process.env.RELAY_EXIT_MOUSE_SHUTDOWN_STARTED, "started");\n'
            '    while (true) {\n'
            '      try {\n'
            '        await access(process.env.RELAY_EXIT_MOUSE_SHUTDOWN_RELEASE);\n'
            '        return;\n'
            '      } catch {\n'
            '        await sleep(10);\n'
            '      }\n'
            '    }\n'
            '  });\n'
            '}\n'
        )


def main() -> int:
    shutdown_trigger = sys.argv[1] if len(sys.argv) > 1 else "ctrl-c"
    if shutdown_trigger not in SHUTDOWN_TRIGGERS:
        raise AssertionError(f"unsupported shutdown trigger: {shutdown_trigger}")
    artifact_label = shutdown_trigger.replace("/", "slash-").replace(":", "colon-")

    os.makedirs(ARTIFACTS, exist_ok=True)
    home = tempfile.mkdtemp(prefix="relay-exit-mouse-home-")
    workspace = tempfile.mkdtemp(prefix="relay-exit-mouse-workspace-")
    shutdown_started = os.path.join(workspace, "shutdown-started")
    shutdown_release = os.path.join(workspace, "shutdown-release")
    transcript = bytearray()
    write_config(home)

    env = os.environ.copy()
    env.pop("XDG_CONFIG_HOME", None)
    env.update(
        {
            "HOME": home,
            "TERM": "xterm-256color",
            "NO_COLOR": "1",
            "RELAY_DISABLE_NOTIFICATIONS": "1",
            "RELAY_EXIT_MOUSE_SHUTDOWN_STARTED": shutdown_started,
            "RELAY_EXIT_MOUSE_SHUTDOWN_RELEASE": shutdown_release,
            "PS1": SHELL_PROMPT.decode(),
            "PROMPT": SHELL_PROMPT.decode(),
        }
    )

    zsh = shutil.which("zsh")
    if zsh is None:
        raise AssertionError("zsh is required for the exit mouse-report smoke test")

    master, slave = pty.openpty()
    set_pty_size(master)
    set_pty_size(slave)
    proc = subprocess.Popen(
        [zsh, "-f"],
        cwd=workspace,
        env=env,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        start_new_session=True,
    )
    os.close(slave)
    passed = False

    try:
        print("[real-e2e] wait for the parent shell", flush=True)
        wait_for(master, proc, transcript, lambda data: data.count(SHELL_PROMPT) >= 1, "initial shell prompt")

        print("[real-e2e] launch Relay and wait for mouse tracking", flush=True)
        command = shlex.join(relay_command(ROOT, "real-e2e"))
        os.write(master, f"{command}\n".encode())
        wait_for(master, proc, transcript, lambda data: MOUSE_ENABLE in data, "Relay mouse tracking")
        wait_for(master, proc, transcript, lambda data: b"Connected to" in data, "Relay connection")

        print(f"[real-e2e] close Relay with {shutdown_trigger} and wait for the controlled shutdown boundary", flush=True)
        if shutdown_trigger == "ctrl-c":
            os.write(master, b"\x03")
            time.sleep(0.1)
            os.write(master, b"\x03")
        else:
            os.write(master, f"{shutdown_trigger}\r".encode())

        deadline = time.time() + 10
        while time.time() < deadline and not os.path.exists(shutdown_started):
            if proc.poll() is not None:
                raise AssertionError(f"shell exited during Relay shutdown: {proc.returncode}")
            read_available(master, transcript, 0.05)
        if not os.path.exists(shutdown_started):
            raise AssertionError("shutdown plugin did not reach its controlled wait point")
        read_available(master, transcript, 0.1)
        if MOUSE_DISABLE not in transcript:
            raise AssertionError("mouse tracking was still enabled when plugin shutdown began")

        print("[real-e2e] inject a mouse report while Relay still owns stdin", flush=True)
        os.write(master, MOUSE_REPORT)
        time.sleep(0.1)
        read_available(master, transcript, 0.1)
        with open(shutdown_release, "w", encoding="utf-8") as file:
            file.write("release")
        wait_for(
            master,
            proc,
            transcript,
            lambda data: data.count(SHELL_PROMPT) >= 2,
            "shell prompt after Relay shutdown",
        )

        print("[real-e2e] verify no mouse-report text leaked and the shell remains usable", flush=True)
        os.write(master, b"\n")
        wait_for(master, proc, transcript, lambda data: data.count(SHELL_PROMPT) >= 3, "prompt after empty command")
        if MOUSE_REPORT_SUFFIX in transcript:
            raise AssertionError(f"mouse report leaked into the shell after Relay exited: {bytes(transcript[-2000:])!r}")

        shell_marker = b"RELAY_EXIT_MOUSE_SHELL_USABLE"
        os.write(master, b"printf 'RELAY_EXIT_MOUSE_SHELL_USABLE\\n'\n")
        wait_for(
            master,
            proc,
            transcript,
            lambda data: data.count(shell_marker) >= 2 and data.count(SHELL_PROMPT) >= 4,
            "successful shell command after Relay shutdown",
        )

        passed = True
        return 0
    finally:
        with open(os.path.join(ARTIFACTS, f"exit-mouse-report-{artifact_label}.transcript.bin"), "wb") as file:
            file.write(transcript)
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
