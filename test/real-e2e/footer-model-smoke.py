#!/usr/bin/env python3
import json
import os
import pty
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from typing import Any, Callable

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "test", "lib"))

from real_e2e_chat_autoscroll import ChatAutoscrollPtyHarness  # noqa: E402


def toml_string(value: str) -> str:
    return json.dumps(value)


def write_config(
    relay_dir: str,
    agent_path: str,
    transcript_path: str,
    *,
    preferred_model: str | None = None,
    agent_mode: str | None = None,
) -> None:
    os.makedirs(relay_dir, exist_ok=True)
    agent_args = [agent_path, transcript_path]
    if agent_mode:
        agent_args.append(agent_mode)
    preferred_model_line = f"preferred_model = {toml_string(preferred_model)}\n" if preferred_model else ""
    with open(os.path.join(relay_dir, "config.toml"), "w", encoding="utf-8") as file:
        file.write(
            f'''[ui]
show_tips = false

[notifications]
sound_enabled = false
terminal_enabled = false

[plugins]
enabled = false

[agents]
default = "acp"

[agents.runners.acp]
command = "bun"
args = [{", ".join(toml_string(arg) for arg in agent_args)}]
profile = "default"
{preferred_model_line}'''
        )


def read_transcript(path: str) -> list[str]:
    if not os.path.exists(path):
        return []
    with open(path, "r", encoding="utf-8") as file:
        return file.readlines()


def read_events(path: str) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for line in read_transcript(path):
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return events


def request_count(transcript_path: str, method: str) -> int:
    return sum(1 for event in read_events(transcript_path) if event.get("event") == "request" and event.get("method") == method)


def request_methods(transcript_path: str) -> list[str]:
    return [
        str(event.get("method"))
        for event in read_events(transcript_path)
        if event.get("event") == "request" and event.get("method")
    ]


def first_event_index(transcript_path: str, predicate: Callable[[dict[str, Any]], bool]) -> int:
    for index, event in enumerate(read_events(transcript_path)):
        if predicate(event):
            return index
    return -1


def wait_for_request(transcript_path: str, method: str, timeout: float = 5.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if request_count(transcript_path, method) > 0:
            return
        time.sleep(0.05)
    raise AssertionError(f"Timed out waiting for ACP request {method!r}: {read_transcript(transcript_path)}")


def wait_for_event(
    transcript_path: str,
    description: str,
    predicate: Callable[[dict[str, Any]], bool],
    timeout: float = 5.0,
) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if first_event_index(transcript_path, predicate) != -1:
            return
        time.sleep(0.05)
    raise AssertionError(f"Timed out waiting for ACP event {description}: {read_transcript(transcript_path)}")


def assert_no_request_for(transcript_path: str, method: str, duration: float) -> None:
    deadline = time.time() + duration
    while time.time() < deadline:
        if request_count(transcript_path, method) > 0:
            raise AssertionError(f"Unexpected ACP request {method!r}: {read_transcript(transcript_path)}")
        time.sleep(0.05)


def stop_relay(harness: ChatAutoscrollPtyHarness, proc: subprocess.Popen, master: int) -> None:
    if proc.poll() is not None:
        return
    try:
        harness.send(master, "\x1b\x15/quit\r")
    except OSError:
        pass
    deadline = time.time() + 5
    while proc.poll() is None and time.time() < deadline:
        harness.read_available(master, 0.1)
    if proc.poll() is None:
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        time.sleep(0.5)
    if proc.poll() is None:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def start_relay(
    *,
    temp_prefix: str,
    preferred_model: str | None = None,
    agent_mode: str | None = None,
    relay_args: list[str] | None = None,
) -> tuple[str, str, ChatAutoscrollPtyHarness, subprocess.Popen, int]:
    root = tempfile.mkdtemp(prefix=temp_prefix)
    home = os.path.join(root, "home")
    xdg_config = os.path.join(home, ".config")
    relay_dir = os.path.join(xdg_config, "relay")
    workspace = os.path.join(root, "workspace")
    transcript_path = os.path.join(root, "acp-transcript.ndjson")
    agent_path = os.path.join(ROOT, "test", "real-e2e", "acp-real-agent.ts")
    os.makedirs(workspace, exist_ok=True)
    write_config(relay_dir, agent_path, transcript_path, preferred_model=preferred_model, agent_mode=agent_mode)

    harness = ChatAutoscrollPtyHarness(rows=30, cols=120)
    master, slave = pty.openpty()
    harness.set_pty_size(master)
    env = os.environ.copy()
    env.update({
        "HOME": home,
        "XDG_CONFIG_HOME": xdg_config,
        "TERM": "xterm-256color",
        "FORCE_COLOR": "0",
    })
    env.pop("RELAY_CONFIG_DIR", None)
    env.pop("RELAY_CACHE_DIR", None)

    proc = subprocess.Popen(
        [
            "bun",
            "run",
            "--conditions=browser",
            os.path.join(ROOT, "src", "index.ts"),
            "--agent",
            "acp",
            *(relay_args or []),
        ],
        cwd=ROOT,
        env=env,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        preexec_fn=os.setsid,
    )
    os.close(slave)
    return root, transcript_path, harness, proc, master


def write_artifacts(
    artifact_name: str,
    harness: ChatAutoscrollPtyHarness,
    transcript_path: str,
    *,
    passed: bool,
    root: str,
) -> None:
    artifacts = os.path.join(ROOT, "test-results", "real-e2e")
    os.makedirs(artifacts, exist_ok=True)
    artifact_prefix = os.path.join(artifacts, artifact_name)
    with open(f"{artifact_prefix}-screen.txt", "w", encoding="utf-8") as file:
        file.write(harness.screen_text())
    with open(f"{artifact_prefix}-transcript.txt", "w", encoding="utf-8") as file:
        file.write(harness.transcript_text())
    shutil.copyfile(transcript_path, f"{artifact_prefix}-acp.ndjson") if os.path.exists(transcript_path) else None
    if passed:
        shutil.rmtree(root, ignore_errors=True)
    else:
        print(f"[real-e2e] retained temp root: {root}", file=sys.stderr)


def active_thread_session_id(root: str) -> str | None:
    threads_dir = os.path.join(root, "home", ".config", "relay", "threads")
    if not os.path.isdir(threads_dir):
        return None
    for name in os.listdir(threads_dir):
        if not name.endswith(".json"):
            continue
        try:
            with open(os.path.join(threads_dir, name), "r", encoding="utf-8") as file:
                parsed = json.load(file)
        except (json.JSONDecodeError, OSError):
            continue
        threads = parsed.get("threads")
        if not isinstance(threads, list):
            continue
        active_thread_id = parsed.get("activeThreadId")
        for thread in threads:
            if isinstance(thread, dict) and thread.get("id") == active_thread_id:
                session_id = thread.get("sessionId")
                return session_id if isinstance(session_id, str) else None
    return None


def wait_for_active_thread_session(root: str, expected_session_id: str, timeout: float = 5.0) -> None:
    deadline = time.time() + timeout
    last_session_id: str | None = None
    while time.time() < deadline:
        last_session_id = active_thread_session_id(root)
        if last_session_id == expected_session_id:
            return
        time.sleep(0.05)
    raise AssertionError(f"Expected active thread session {expected_session_id!r}, got {last_session_id!r}")


def assert_active_thread_session_stays(root: str, expected_session_id: str, duration: float) -> None:
    deadline = time.time() + duration
    while time.time() < deadline:
        actual_session_id = active_thread_session_id(root)
        if actual_session_id != expected_session_id:
            raise AssertionError(f"Active thread session changed to {actual_session_id!r}; expected {expected_session_id!r}")
        time.sleep(0.05)


def run_preferred_model_flow() -> None:
    root, transcript_path, harness, proc, master = start_relay(
        temp_prefix="relay-footer-model-",
        preferred_model="model-b",
        agent_mode="slow-config",
    )
    passed = False
    try:
        harness.step("wait for Relay to connect to the real ACP process")
        harness.wait_for(master, proc, "Connected to acp agent", 10)

        harness.step("submit the first prompt while preferred model application is still pending")
        wait_for_event(
            transcript_path,
            "preferred model request",
            lambda event: event.get("event") == "set-config-start" and event.get("params", {}).get("value") == "model-b",
            10,
        )
        harness.send(master, "first prompt waits for preferred model\r")
        wait_for_request(transcript_path, "session/prompt", 10)

        set_config_complete = first_event_index(
            transcript_path,
            lambda event: event.get("event") == "set-config-complete" and event.get("params", {}).get("value") == "model-b",
        )
        prompt_request = first_event_index(
            transcript_path,
            lambda event: event.get("event") == "request" and event.get("method") == "session/prompt",
        )
        if set_config_complete == -1 or prompt_request == -1 or set_config_complete > prompt_request:
            raise AssertionError(
                "First prompt reached ACP before preferred model application completed. "
                f"Transcript:\n{''.join(read_transcript(transcript_path))}"
            )

        harness.step("verify startup session capabilities hydrate the visible preferred model")
        screen = harness.wait_for(master, proc, "model-b", 10)
        if "(no model)" in screen:
            raise AssertionError(f"Footer still shows lazy model placeholder. Screen:\n{screen}")
        if request_count(transcript_path, "session/new") != 1:
            raise AssertionError(f"Expected exactly one startup session/new. Transcript:\n{read_transcript(transcript_path)}")
        if request_count(transcript_path, "session/set_config_option") != 1:
            raise AssertionError(f"Expected one preferred model update. Transcript:\n{read_transcript(transcript_path)}")

        harness.step("run /models through the same TUI boundary and verify it reuses the hydrated session")
        harness.send(master, "/models model-a\r")
        screen = harness.wait_for(master, proc, "Switched to model: model-a", 10)
        if request_count(transcript_path, "session/new") != 1:
            raise AssertionError(f"/models created an extra session. Transcript:\n{read_transcript(transcript_path)}")
        if "model-a" not in screen:
            raise AssertionError(f"Expected footer to reflect switched model. Screen:\n{screen}")

        passed = True
    finally:
        stop_relay(harness, proc, master)
        harness.read_available(master, 0.2)
        os.close(master)
        write_artifacts("footer-model", harness, transcript_path, passed=passed, root=root)


def run_resume_during_warmup_flow() -> None:
    root, transcript_path, harness, proc, master = start_relay(
        temp_prefix="relay-resume-during-warmup-",
        preferred_model="model-b",
        agent_mode="slow-config",
    )
    passed = False
    try:
        harness.step("start session warm-up and open manual resume before it completes")
        harness.wait_for(master, proc, "Connected to acp agent", 10)
        wait_for_event(
            transcript_path,
            "startup preferred model request",
            lambda event: event.get("event") == "set-config-start"
            and event.get("params", {}).get("sessionId") == "real-new-session"
            and event.get("params", {}).get("value") == "model-b",
            10,
        )
        harness.send(master, "/resume\r")
        screen = harness.wait_for(master, proc, "Latest", 10)
        if "→ Latest" not in screen:
            raise AssertionError(f"Expected Latest session to be selected. Screen:\n{screen}")

        harness.step("resume selected session and verify stale warm-up cannot overwrite it")
        harness.send(master, "\r")
        harness.wait_for(master, proc, "Resumed ACP session: latest-session", 10)
        wait_for_request(transcript_path, "session/load", 5)
        wait_for_active_thread_session(root, "latest-session", 5)
        wait_for_event(
            transcript_path,
            "startup preferred model completion",
            lambda event: event.get("event") == "set-config-complete"
            and event.get("params", {}).get("sessionId") == "real-new-session"
            and event.get("params", {}).get("value") == "model-b",
            10,
        )
        assert_active_thread_session_stays(root, "latest-session", 1.0)
        if request_count(transcript_path, "session/new") != 1:
            raise AssertionError(f"Expected exactly one startup session/new. Transcript:\n{read_transcript(transcript_path)}")
        if request_count(transcript_path, "session/load") != 1:
            raise AssertionError(f"Expected exactly one session/load. Transcript:\n{read_transcript(transcript_path)}")

        passed = True
    finally:
        stop_relay(harness, proc, master)
        harness.read_available(master, 0.2)
        os.close(master)
        write_artifacts("resume-during-warmup", harness, transcript_path, passed=passed, root=root)


def run_resume_picker_flow() -> None:
    root, transcript_path, harness, proc, master = start_relay(
        temp_prefix="relay-resume-picker-",
        relay_args=["--resume"],
    )
    passed = False
    try:
        harness.step("open startup resume picker without warming a blank session")
        screen = harness.wait_for(master, proc, "Latest", 10)
        if "Older" not in screen:
            screen = harness.wait_for(master, proc, "Older", 5)
        if "→ Latest" not in screen:
            raise AssertionError(f"Expected Latest session to be selected. Screen:\n{screen}")
        assert_no_request_for(transcript_path, "session/new", 1.0)

        harness.step("select the existing session and verify resume uses session/load")
        harness.send(master, "\r")
        harness.wait_for(master, proc, "Resumed ACP session: latest-session", 10)
        wait_for_request(transcript_path, "session/load", 5)
        if request_count(transcript_path, "session/new") != 0:
            raise AssertionError(f"Resume flow created a blank session. Transcript:\n{read_transcript(transcript_path)}")
        if request_count(transcript_path, "session/load") != 1:
            raise AssertionError(f"Expected exactly one session/load. Transcript:\n{read_transcript(transcript_path)}")
        if request_methods(transcript_path) != ["initialize", "session/list", "session/load"]:
            raise AssertionError(f"Unexpected resume ACP sequence: {request_methods(transcript_path)}")

        passed = True
    finally:
        stop_relay(harness, proc, master)
        harness.read_available(master, 0.2)
        os.close(master)
        write_artifacts("resume-picker", harness, transcript_path, passed=passed, root=root)


def main() -> int:
    run_preferred_model_flow()
    run_resume_during_warmup_flow()
    run_resume_picker_flow()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
