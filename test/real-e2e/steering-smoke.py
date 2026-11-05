#!/usr/bin/env python3
import fcntl
import json
import os
import pty
import re
import shutil
import signal
import struct
import subprocess
import tempfile
import termios
import time
import select

from relay_command import relay_command

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
STEPS: list[str] = []
TRANSCRIPT: list[str] = []


def strip_control(text: str) -> str:
    text = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", text)
    text = re.sub(r"\x1b\][^\x07]*(?:\x07|\x1b\\)", "", text)
    return CONTROL_RE.sub("", text)


def set_pty_size(fd: int, rows: int = 36, cols: int = 120) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def read_available(fd: int, timeout: float = 0.1) -> str:
    chunks: list[str] = []
    while True:
        ready, _, _ = select.select([fd], [], [], timeout)
        if not ready:
            break
        try:
            data = os.read(fd, 8192)
        except OSError:
            break
        if not data:
            break
        decoded = data.decode("utf-8", errors="replace")
        TRANSCRIPT.append(decoded)
        chunks.append(decoded)
        timeout = 0
    return "".join(chunks)


def screen_text() -> str:
    return strip_control("".join(TRANSCRIPT))


def process_diagnostics(proc: subprocess.Popen[str]) -> str:
    status = proc.poll()
    return "still running" if status is None else f"exited with {status}"


def wait_for(fd: int, proc: subprocess.Popen[str], text: str, timeout: float) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        read_available(fd, 0.1)
        if text in screen_text():
            return
        if proc.poll() is not None:
            break
    raise AssertionError(f"Timed out waiting for {text!r}; process {process_diagnostics(proc)}; screen: {screen_text()[-4000:]}")


def send(fd: int, data: str) -> None:
    os.write(fd, data.encode("utf-8"))
    read_available(fd, 0.1)


def send_text(fd: int, text: str) -> None:
    for ch in text:
        send(fd, ch)


def press_option_enter(fd: int) -> None:
    send(fd, "\x1b\r")


def step(name: str) -> None:
    STEPS.append(name)
    print(f"[real-e2e] {name}", flush=True)


def read_events(path: str) -> list[dict[str, object]]:
    with open(path, "r", encoding="utf-8") as file:
        return [json.loads(line) for line in file if line.strip()]


def relay_log_paths(log_dir: str) -> list[str]:
    try:
        names = os.listdir(log_dir)
    except FileNotFoundError:
        return []
    return sorted(os.path.join(log_dir, name) for name in names if name.startswith("relay-") and name.endswith(".ndjson"))


def read_relay_log_events(log_dir: str) -> list[dict[str, object]]:
    events: list[dict[str, object]] = []
    for path in relay_log_paths(log_dir):
        events.extend(read_events(path))
    return events


def assert_steering_events(events: list[dict[str, object]]) -> None:
    active_turn_events = [entry for entry in events if entry.get("event") == "active-turn-input"]
    accepted_guidance = [entry for entry in active_turn_events if entry.get("text") == "steering e2e guidance"]
    legacy_requests = [entry for entry in events if entry.get("method") == "_alta/session/steer"]

    if len(accepted_guidance) != 1:
        raise AssertionError(f"Expected exactly one accepted steering guidance event, got: {active_turn_events}")
    guidance = accepted_guidance[0]
    if guidance.get("method") != "session/prompt" or guidance.get("hasSteerMeta") is not True or guidance.get("accepted") is not True:
        raise AssertionError(f"Expected steering over accepted session/prompt _meta, got: {guidance}")
    if legacy_requests:
        raise AssertionError(f"Expected no legacy steering method calls, got: {legacy_requests}")


def event_data(entry: dict[str, object]) -> dict[str, object]:
    data = entry.get("data")
    return data if isinstance(data, dict) else {}


def assert_relay_inline_profile_events(events: list[dict[str, object]]) -> None:
    configured_events = [entry for entry in events if entry.get("event") == "ui.agent.configured"]
    inline_alta_profiles = [
        entry
        for entry in configured_events
        if event_data(entry).get("agentName") == "real-e2e"
        and event_data(entry).get("profile") == "alta"
        and event_data(entry).get("inline") is True
    ]
    client_events = [entry for entry in events if entry.get("event") == "acp.client.create"]
    alta_behavior_profiles = [entry for entry in client_events if event_data(entry).get("behaviorProfile") == "alta"]

    if not inline_alta_profiles:
        raise AssertionError(f"Expected inline ACP launch to use configured alta profile, got: {configured_events}")
    if not alta_behavior_profiles:
        raise AssertionError(f"Expected ACP client to use alta behavior profile, got: {client_events}")


def main() -> int:
    artifacts = os.path.join(ROOT, "test-results", "real-e2e")
    os.makedirs(artifacts, exist_ok=True)
    for name in (
        "steering-smoke.agent-events.ndjson",
        "steering-smoke.failure.txt",
        "steering-smoke.relay-log.ndjson",
        "steering-smoke.steps.txt",
        "steering-smoke.transcript.txt",
    ):
        try:
            os.remove(os.path.join(artifacts, name))
        except FileNotFoundError:
            pass
    home = tempfile.mkdtemp(prefix="relay-steering-e2e-home-")
    workspace = tempfile.mkdtemp(prefix="relay-steering-e2e-workspace-")
    agent_log = os.path.join(workspace, "steering-agent-events.ndjson")
    relay_dir = os.path.join(home, ".config", "relay")
    relay_log_dir = os.path.join(relay_dir, "logs")
    os.makedirs(relay_dir, exist_ok=True)

    env = os.environ.copy()
    env.pop("XDG_CONFIG_HOME", None)
    env.update(
        {
            "HOME": home,
            "TERM": "xterm-256color",
            "NO_COLOR": "1",
            "RELAY_DISABLE_NOTIFICATIONS": "1",
            "RELAY_REAL_E2E_PROMPT_DELAY_MS": "9000",
            "RELAY_REAL_E2E_ACTIVE_TURN_INPUT": "1",
            "RELAY_REAL_E2E_PROMPT_LOG": agent_log,
        }
    )

    agent_path = os.path.join(ROOT, "test", "real-e2e", "acp-agent.ts")
    with open(os.path.join(relay_dir, "config.toml"), "w", encoding="utf-8") as file:
        file.write(
            '[agents]\n'
            'default = "real-e2e"\n\n'
            '[agents.runners.real-e2e]\n'
            'command = "bun"\n'
            f'args = ["run", "{agent_path}"]\n'
            'profile = "alta"\n'
        )

    command = relay_command(ROOT, "real-e2e") + ["acp", f"bun run {agent_path}"]
    master, slave = pty.openpty()
    set_pty_size(master)
    set_pty_size(slave)
    proc = subprocess.Popen(command, cwd=workspace, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
    os.close(slave)
    passed = False

    try:
        step("wait for Relay to connect to the real ACP stdio agent")
        wait_for(master, proc, "Connected to", 10)

        step("start a slow prompt so steering targets a live turn")
        send_text(master, "slow real active-turn prompt")
        send(master, "\r")
        wait_for(master, proc, "Working", 3)

        step("send steering guidance with option-enter")
        send_text(master, "steering e2e guidance")
        press_option_enter(master)
        wait_for(master, proc, "Added to current turn", 5)

        step("observe final agent output containing steered guidance")
        wait_for(master, proc, "guidance: steering e2e guidance", 12)

        step("assert ACP transcript used session/prompt steering metadata")
        events = read_events(agent_log)
        assert_steering_events(events)

        step("assert Relay preserved configured profile metadata for inline ACP")
        assert_relay_inline_profile_events(read_relay_log_events(relay_log_dir))
        passed = True
        return 0
    finally:
        read_available(master, 0.2)
        with open(os.path.join(artifacts, "steering-smoke.transcript.txt"), "w", encoding="utf-8") as file:
            file.write(screen_text())
        with open(os.path.join(artifacts, "steering-smoke.steps.txt"), "w", encoding="utf-8") as file:
            file.write("\n".join(STEPS) + "\n")
        if os.path.exists(agent_log):
            shutil.copyfile(agent_log, os.path.join(artifacts, "steering-smoke.agent-events.ndjson"))
        relay_artifact = os.path.join(artifacts, "steering-smoke.relay-log.ndjson")
        for path in relay_log_paths(relay_log_dir):
            with open(path, "r", encoding="utf-8") as source:
                with open(relay_artifact, "a", encoding="utf-8") as target:
                    shutil.copyfileobj(source, target)
        if not passed:
            with open(os.path.join(artifacts, "steering-smoke.failure.txt"), "w", encoding="utf-8") as file:
                file.write(screen_text()[-8000:])
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
        shutil.rmtree(home, ignore_errors=True)
        shutil.rmtree(workspace, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
