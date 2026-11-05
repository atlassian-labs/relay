#!/usr/bin/env python3
import json
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
import fcntl

from relay_command import relay_command

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCREEN_ROWS = 30
SCREEN_COLS = 120
TRANSCRIPT: list[str] = []
STEPS: list[str] = []
ANSI_RE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def step(name: str) -> None:
    STEPS.append(name)
    print(f"[real-e2e] {name}", flush=True)


def clean(text: str) -> str:
    text = ANSI_RE.sub("", text)
    text = text.replace("\r", "\n")
    text = CONTROL_RE.sub("", text)
    return text


def transcript_text() -> str:
    return clean("".join(TRANSCRIPT))


def process_diagnostics(proc: subprocess.Popen) -> str:
    code = proc.poll()
    return "still running" if code is None else f"exited with code {code}"


def set_pty_size(fd: int) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", SCREEN_ROWS, SCREEN_COLS, 0, 0))


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
        chunks.append(decoded)
    return "".join(chunks)


def wait_for_text(fd: int, proc: subprocess.Popen, needle: str, timeout: float = 10.0) -> str:
    deadline = time.time() + timeout
    while time.time() < deadline:
        assert_process_running(proc)
        read_available(fd, 0.1)
        text = transcript_text()
        if needle in text:
            return text
    raise AssertionError(f"Timed out waiting for {needle!r}. Transcript tail:\n{transcript_text()[-5000:]}")


def wait_for_no_text(fd: int, proc: subprocess.Popen, needle: str, duration: float = 1.0) -> None:
    deadline = time.time() + duration
    while time.time() < deadline:
        assert_process_running(proc)
        read_available(fd, 0.1)
        if needle in transcript_text():
            raise AssertionError(f"Unexpected {needle!r} in terminal transcript:\n{transcript_text()[-5000:]}")


def send(fd: int, data: str) -> None:
    os.write(fd, data.encode("utf-8"))
    read_available(fd, 0.1)


def send_text(fd: int, text: str) -> None:
    for ch in text:
        send(fd, ch)


def read_agent_events(path: str) -> list[dict]:
    if not os.path.exists(path):
        return []
    events = []
    with open(path, "r", encoding="utf-8") as file:
        for line in file:
            line = line.strip()
            if line:
                events.append(json.loads(line))
    return events


def wait_for_agent_event(path: str, predicate, description: str, timeout: float = 8.0) -> list[dict]:
    deadline = time.time() + timeout
    events = read_agent_events(path)
    while time.time() < deadline:
        events = read_agent_events(path)
        if predicate(events):
            return events
        time.sleep(0.05)
    raise AssertionError(f"Timed out waiting for ACP transcript event {description}. Events: {events}")


def write_relay_config(relay_dir: str, agent_events_path: str, mode: str = "exit-after-first-prompt") -> None:
    os.makedirs(relay_dir, exist_ok=True)
    agent_path = os.path.join(ROOT, "test", "real-e2e", "acp-real-agent.ts")
    with open(os.path.join(relay_dir, "config.toml"), "w", encoding="utf-8") as file:
        file.write(
            "[notifications]\n"
            "sound_enabled = false\n\n"
            "[agents]\n"
            "default = \"acp\"\n\n"
            "[agents.runners.acp]\n"
            "command = \"bun\"\n"
            f"args = [\"{agent_path}\", \"{agent_events_path}\", \"{mode}\"]\n"
            "profile = \"default\"\n"
        )


def stop_relay(proc: subprocess.Popen) -> None:
    if proc.poll() is not None:
        return
    try:
        os.killpg(proc.pid, signal.SIGTERM)
        proc.wait(timeout=2)
    except Exception:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except Exception:
            pass


def process_exists(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    if not sys.platform.startswith("linux"):
        return True
    try:
        with open(f"/proc/{pid}/stat", "r", encoding="utf-8") as stat_file:
            stat = stat_file.read()
        command_end = stat.rfind(")")
        state = stat[command_end + 2 : command_end + 3] if command_end >= 0 else ""
        return state not in {"Z", "X"}
    except FileNotFoundError:
        return False


def wait_for_process_exit(pid: int, timeout: float = 2.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if not process_exists(pid):
            return
        time.sleep(0.05)
    raise AssertionError(f"ACP child process {pid} remained alive after Relay exited")


def kill_process_group(pid: int) -> None:
    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


def run_startup_exit_smoke(workspace: str, env: dict[str, str], agent_events_path: str) -> None:
    master_fd, slave_fd = pty.openpty()
    set_pty_size(master_fd)
    proc: subprocess.Popen | None = None
    try:
        step("start Relay with a child that exits after initialize")
        proc = subprocess.Popen(
            relay_command(ROOT, "acp"),
            cwd=workspace,
            env=env,
            stdin=slave_fd,
            stdout=slave_fd,
            stderr=slave_fd,
            preexec_fn=os.setsid,
            close_fds=True,
        )
        os.close(slave_fd)
        wait_for_text(fd=master_fd, proc=proc, needle="ACP agent process exited unexpectedly (code 0)", timeout=12.0)
        wait_for_text(fd=master_fd, proc=proc, needle="Start a new prompt", timeout=4.0)
        wait_for_text(fd=master_fd, proc=proc, needle="reconnect", timeout=4.0)
        wait_for_no_text(fd=master_fd, proc=proc, needle="Connected to acp agent", duration=1.0)
        wait_for_agent_event(
            agent_events_path,
            lambda items: any(item.get("event") == "intentional-startup-exit" and item.get("code") == 0 for item in items),
            "startup child exit",
        )
    finally:
        if proc is not None:
            stop_relay(proc)
        try:
            read_available(master_fd, 0.2)
            os.close(master_fd)
        except OSError:
            pass


def run_signal_shutdown_cleanup_smoke(workspace: str, env: dict[str, str], agent_events_path: str) -> None:
    """Verify repeated SIGTERM signals shut down Relay and reap its detached ACP child."""
    master_fd, slave_fd = pty.openpty()
    set_pty_size(master_fd)
    proc: subprocess.Popen | None = None
    child_pid: int | None = None
    try:
        step("start Relay with an ACP child that ignores SIGTERM")
        proc = subprocess.Popen(
            relay_command(ROOT, "acp"),
            cwd=workspace,
            env=env,
            stdin=slave_fd,
            stdout=slave_fd,
            stderr=slave_fd,
            preexec_fn=os.setsid,
            close_fds=True,
        )
        os.close(slave_fd)
        wait_for_text(fd=master_fd, proc=proc, needle="Connected to acp agent", timeout=12.0)
        events = wait_for_agent_event(
            agent_events_path,
            lambda items: any(item.get("event") == "started" and isinstance(item.get("pid"), int) for item in items),
            "ACP child start with pid",
        )
        child_pid = next(
            int(item["pid"])
            for item in reversed(events)
            if item.get("event") == "started" and isinstance(item.get("pid"), int)
        )

        step("send repeated SIGTERM signals to Relay and verify its detached ACP child also exits")
        os.kill(proc.pid, signal.SIGTERM)
        time.sleep(0.01)
        if proc.poll() is None:
            os.kill(proc.pid, signal.SIGTERM)
        proc.wait(timeout=5)
        wait_for_process_exit(child_pid)
    finally:
        if proc is not None:
            stop_relay(proc)
        if child_pid is not None and process_exists(child_pid):
            kill_process_group(child_pid)
        try:
            read_available(master_fd, 0.2)
            os.close(master_fd)
        except OSError:
            pass


def run_web_signal_shutdown_cleanup_smoke(workspace: str, env: dict[str, str], agent_events_path: str) -> None:
    master_fd, slave_fd = pty.openpty()
    set_pty_size(master_fd)
    proc: subprocess.Popen | None = None
    child_pid: int | None = None
    try:
        event_count_before = len(read_agent_events(agent_events_path))
        step("start Relay web with an ACP child that ignores SIGTERM")
        proc = subprocess.Popen(
            relay_command(ROOT, "acp") + ["--web", "--no-open", "--port", "0"],
            cwd=workspace,
            env=env,
            stdin=slave_fd,
            stdout=slave_fd,
            stderr=slave_fd,
            preexec_fn=os.setsid,
            close_fds=True,
        )
        os.close(slave_fd)
        wait_for_text(fd=master_fd, proc=proc, needle="Relay web dashboard listening at", timeout=12.0)
        events = wait_for_agent_event(
            agent_events_path,
            lambda items: any(
                item.get("event") == "started" and isinstance(item.get("pid"), int)
                for item in items[event_count_before:]
            ),
            "web ACP child start with pid",
        )
        child_pid = next(
            int(item["pid"])
            for item in reversed(events[event_count_before:])
            if item.get("event") == "started" and isinstance(item.get("pid"), int)
        )

        step("send repeated SIGHUP signals to Relay web and verify its detached ACP child also exits")
        os.kill(proc.pid, signal.SIGHUP)
        time.sleep(0.01)
        if proc.poll() is None:
            os.kill(proc.pid, signal.SIGHUP)
        proc.wait(timeout=5)
        wait_for_process_exit(child_pid)
    finally:
        if proc is not None:
            stop_relay(proc)
        if child_pid is not None and process_exists(child_pid):
            kill_process_group(child_pid)
        try:
            read_available(master_fd, 0.2)
            os.close(master_fd)
        except OSError:
            pass


def main() -> int:
    artifacts = os.path.join(ROOT, "test-results", "real-e2e")
    os.makedirs(artifacts, exist_ok=True)
    home = tempfile.mkdtemp(prefix="relay-child-exit-home-")
    workspace = tempfile.mkdtemp(prefix="relay-child-exit-workspace-")
    relay_dir = os.path.join(home, ".config", "relay")
    agent_events_path = os.path.join(home, "child-process-exit-agent.ndjson")
    write_relay_config(relay_dir, agent_events_path, "exit-after-initialize")

    env = os.environ.copy()
    env.pop("XDG_CONFIG_HOME", None)
    env.update({
        "HOME": home,
        "TERM": "xterm-256color",
        "NO_COLOR": "1",
        "RELAY_DISABLE_NOTIFICATIONS": "1",
    })

    run_startup_exit_smoke(workspace, env, agent_events_path)
    write_relay_config(relay_dir, agent_events_path, "ignore-sigterm")
    TRANSCRIPT.clear()
    run_signal_shutdown_cleanup_smoke(workspace, env, agent_events_path)
    TRANSCRIPT.clear()
    run_web_signal_shutdown_cleanup_smoke(workspace, env, agent_events_path)
    write_relay_config(relay_dir, agent_events_path, "exit-after-first-prompt")
    TRANSCRIPT.clear()

    master_fd, slave_fd = pty.openpty()
    set_pty_size(master_fd)
    proc: subprocess.Popen | None = None
    try:
        step("start Relay with an initial prompt that makes the ACP child exit code 0")
        cmd = relay_command(ROOT, "acp") + ["--prompt", "child exit first prompt"]
        proc = subprocess.Popen(
            cmd,
            cwd=workspace,
            env=env,
            stdin=slave_fd,
            stdout=slave_fd,
            stderr=slave_fd,
            preexec_fn=os.setsid,
            close_fds=True,
        )
        os.close(slave_fd)

        step("observe clear process-exit failure, not a generic prompt error")
        wait_for_text(fd=master_fd, proc=proc, needle="ACP agent process exited unexpectedly (code 0)", timeout=12.0)
        wait_for_text(fd=master_fd, proc=proc, needle="Start a new prompt", timeout=4.0)
        wait_for_text(fd=master_fd, proc=proc, needle="reconnect", timeout=4.0)
        wait_for_no_text(fd=master_fd, proc=proc, needle="ACP prompt error", duration=1.0)

        step("submit a second prompt through the same terminal boundary")
        send_text(master_fd, "child exit second prompt")
        send(master_fd, "\r")
        wait_for_text(fd=master_fd, proc=proc, needle="child exit second prompt complete", timeout=12.0)

        step("verify ACP transcript proves child restart and second prompt completion")
        events = wait_for_agent_event(
            agent_events_path,
            lambda items: sum(1 for item in items if item.get("event") == "started") >= 2
            and any(item.get("event") == "intentional-unexpected-exit" and item.get("code") == 0 for item in items)
            and any(item.get("event") == "prompt" and item.get("text") == "child exit first prompt" for item in items)
            and any(item.get("event") == "prompt" and item.get("text") == "child exit second prompt" for item in items)
            and any(item.get("event") == "child-exit-second-prompt-complete" for item in items),
            "child restart plus second prompt completion",
        )
        if len([item for item in events if item.get("event") == "started"]) < 2:
            raise AssertionError(f"Expected at least two ACP child starts, got events: {events}")
        return 0
    except Exception as err:
        print(f"[real-e2e] FAILURE: {err}", file=sys.stderr)
        return 1
    finally:
        if proc is not None:
            stop_relay(proc)
        try:
            read_available(master_fd, 0.2)
            os.close(master_fd)
        except OSError:
            pass
        with open(os.path.join(artifacts, "child-process-exit-smoke.steps.txt"), "w", encoding="utf-8") as file:
            file.write("\n".join(STEPS))
        with open(os.path.join(artifacts, "child-process-exit-smoke.transcript.txt"), "w", encoding="utf-8") as file:
            file.write(transcript_text())
        with open(os.path.join(artifacts, "child-process-exit-smoke.agent.ndjson"), "w", encoding="utf-8") as file:
            if os.path.exists(agent_events_path):
                with open(agent_events_path, "r", encoding="utf-8") as source:
                    file.write(source.read())
        shutil.rmtree(home, ignore_errors=True)
        shutil.rmtree(workspace, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
