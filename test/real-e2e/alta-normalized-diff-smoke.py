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

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCREEN_ROWS = 40
SCREEN_COLS = 140
TRANSCRIPT: list[str] = []
ANSI_RE = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x1b]*(?:\x07|\x1b\\)|[@-_])")
CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def clean(text: str) -> str:
    return CONTROL_RE.sub("", ANSI_RE.sub("", text).replace("\r", "\n"))


def transcript_text() -> str:
    return clean("".join(TRANSCRIPT))


def set_pty_size(fd: int) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", SCREEN_ROWS, SCREEN_COLS, 0, 0))


def read_available(fd: int, timeout: float = 0.1) -> str:
    chunks: list[str] = []
    deadline = time.time() + timeout
    while time.time() < deadline:
        ready, _, _ = select.select([fd], [], [], max(0, deadline - time.time()))
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
        chunks.append(decoded)
    return "".join(chunks)


def assert_process_running(proc: subprocess.Popen) -> None:
    code = proc.poll()
    if code is not None:
        raise AssertionError(f"Relay exited with {code}. Transcript:\n{transcript_text()[-12000:]}")


def wait_for(fd: int, proc: subprocess.Popen, needle: str, timeout: float = 60.0) -> str:
    deadline = time.time() + timeout
    while time.time() < deadline:
        assert_process_running(proc)
        read_available(fd, 0.2)
        text = transcript_text()
        if needle in text:
            return text
    raise AssertionError(f"Timed out waiting for {needle!r}. Transcript:\n{transcript_text()[-16000:]}")


def wait_for_file(path: str, needle: str, fd: int, proc: subprocess.Popen, timeout: float = 180.0) -> str:
    deadline = time.time() + timeout
    while time.time() < deadline:
        assert_process_running(proc)
        read_available(fd, 0.5)
        with open(path, "r", encoding="utf-8") as file:
            content = file.read()
        if needle in content:
            return content
    raise AssertionError(
        f"Timed out waiting for {needle!r} in {path}. Transcript:\n{transcript_text()[-16000:]}"
    )


def send(fd: int, data: str) -> None:
    os.write(fd, data.encode("utf-8"))
    read_available(fd, 0.2)


def env_path(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise AssertionError(f"{name} is required for real Alta normalized diff E2E")
    return os.path.abspath(os.path.expanduser(value))


def main() -> int:
    alta_root = env_path("RELAY_REAL_ALTA_ROOT")
    agent_source = env_path("RELAY_REAL_ALTA_AGENT")
    relay_command = os.environ.get("RELAY_REAL_ALTA_RELAY_COMMAND", os.path.join(ROOT, "dist", "index.js"))
    tsx = os.environ.get("RELAY_REAL_ALTA_TSX", os.path.join(alta_root, "node_modules", ".bin", "tsx"))
    alta_bin = os.environ.get(
        "RELAY_REAL_ALTA_BIN", os.path.join(alta_root, "services", "alta-cli", "bin", "alta.ts")
    )

    for required_path in [alta_root, agent_source, relay_command, tsx, alta_bin]:
        if not os.path.exists(required_path):
            raise AssertionError(f"Required real E2E path does not exist: {required_path}")

    artifacts = os.path.join(ROOT, "test-results", "real-e2e")
    os.makedirs(artifacts, exist_ok=True)
    xdg_config_home = tempfile.mkdtemp(prefix="relay-real-alta-xdg-")
    alta_home = tempfile.mkdtemp(prefix="relay-real-alta-home-")
    workspace = tempfile.mkdtemp(prefix="relay-real-alta-workspace-")
    rivetkit = tempfile.mkdtemp(prefix="relay-real-alta-rivet-")
    master, slave = pty.openpty()
    proc: subprocess.Popen | None = None
    passed = False

    try:
        os.makedirs(os.path.join(workspace, "src"), exist_ok=True)
        target_path = os.path.join(workspace, "src", "config.json")
        with open(target_path, "w", encoding="utf-8") as file:
            file.write('{\n  "debug": false,\n  "name": "relay-alta-real-e2e"\n}\n')

        relay_dir = os.path.join(xdg_config_home, "relay")
        os.makedirs(relay_dir, exist_ok=True)
        with open(os.path.join(relay_dir, "config.toml"), "w", encoding="utf-8") as file:
            file.write(
                '[agents]\n'
                'default = "local-alta"\n\n'
                '[agents.runners.local-alta]\n'
                f'command = "{tsx}"\n'
                f'args = ["{alta_bin}", "agent", "run", "{agent_source}", "--workspace", "{workspace}"]\n'
                'profile = "default"\n'
            )

        env = os.environ.copy()
        env.update(
            {
                "HOME": alta_home,
                "XDG_CONFIG_HOME": xdg_config_home,
                "TERM": "xterm-256color",
                "NO_COLOR": "1",
                "RELAY_DISABLE_NOTIFICATIONS": "1",
                "ALTA_RIVETKIT_DIR": rivetkit,
            }
        )

        command = ["bun", "run", relay_command, "--agent", "local-alta"]
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

        wait_for(master, proc, "Connected to", 180)
        send(
            master,
            'Use find_and_replace_code to change "debug": false to "debug": true in src/config.json. '
            "Do not make any other changes.\r",
        )
        file_content = wait_for_file(target_path, '"debug": true', master, proc, 300)
        time.sleep(2)
        read_available(master, 0.5)
        transcript = transcript_text()
        required = [
            "find_and_replace_code",
            "src/config.json",
            '"debug": false',
            '"debug": true',
            "+1",
            "-1",
        ]
        missing = [needle for needle in required if needle not in transcript]
        if missing:
            raise AssertionError(f"Missing rendered diff proof {missing}. Transcript:\n{transcript[-16000:]}")

        print("REAL_ALTA_NORMALIZED_DIFF_E2E_PASS")
        print(f"workspace={workspace}")
        print(f"agent={agent_source}")
        print(file_content)
        passed = True
        return 0
    finally:
        if proc is not None and proc.poll() is None:
            os.killpg(proc.pid, signal.SIGTERM)
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL)
        try:
            os.close(master)
        except OSError:
            pass

        with open(os.path.join(artifacts, "alta-normalized-diff-smoke.transcript.txt"), "w", encoding="utf-8") as file:
            file.write(transcript_text())
        with open(os.path.join(artifacts, "alta-normalized-diff-smoke.config.toml"), "w", encoding="utf-8") as file:
            config_path = os.path.join(xdg_config_home, "relay", "config.toml")
            if os.path.exists(config_path):
                with open(config_path, "r", encoding="utf-8") as config:
                    file.write(config.read())
        if not passed:
            print("REAL_ALTA_NORMALIZED_DIFF_E2E_FAILED", file=sys.stderr)
            print(f"workspace={workspace}", file=sys.stderr)
            print(f"xdg_config_home={xdg_config_home}", file=sys.stderr)
            print(f"alta_home={alta_home}", file=sys.stderr)
            print(f"rivetkit={rivetkit}", file=sys.stderr)
            print(f"artifacts={artifacts}", file=sys.stderr)
            print(transcript_text()[-16000:], file=sys.stderr)
        else:
            shutil.rmtree(xdg_config_home, ignore_errors=True)
            shutil.rmtree(alta_home, ignore_errors=True)
            shutil.rmtree(workspace, ignore_errors=True)
            shutil.rmtree(rivetkit, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
