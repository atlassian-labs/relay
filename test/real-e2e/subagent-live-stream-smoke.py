#!/usr/bin/env python3
import os
import pty
import shutil
import signal
import subprocess
import sys
import tempfile
from typing import Any

from relay_command import relay_command

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
TEST_LIB = os.path.join(ROOT, "test", "lib")
if TEST_LIB not in sys.path:
    sys.path.insert(0, TEST_LIB)

from real_e2e_chat_autoscroll import ChatAutoscrollPtyHarness

SCREEN_ROWS = 40
SCREEN_COLS = 150
HARNESS = ChatAutoscrollPtyHarness(SCREEN_ROWS, SCREEN_COLS)


def wait_for(fd: int, proc: subprocess.Popen, needle: str, timeout: float = 10.0) -> str:
    return HARNESS.wait_for(fd, proc, needle, timeout)


def wait_for_absent(fd: int, proc: subprocess.Popen, needle: str, duration: float = 1.0) -> str:
    return HARNESS.wait_for_absent(fd, proc, needle, duration)


def send(fd: int, data: str) -> None:
    HARNESS.send(fd, data)


def send_text(fd: int, text: str) -> None:
    HARNESS.send_text(fd, text)


def read_agent_events(path: str) -> list[dict[str, Any]]:
    return HARNESS.read_agent_events(path)


def find_screen_line(screen: str, needle: str) -> int:
    for index, line in enumerate(screen.splitlines()):
        if needle in line:
            return index
    raise AssertionError(f"Expected {needle!r} in screen:\n{screen}")


def assert_ordered(screen: str, needles: list[str]) -> None:
    positions = [find_screen_line(screen, needle) for needle in needles]
    if positions != sorted(positions) or len(set(positions)) != len(positions):
        raise AssertionError(f"Expected ordered nested subagent lines {list(zip(needles, positions))}. Screen:\n{screen}")


def assert_not_rendered(needle: str, screen: str) -> None:
    transcript = HARNESS.transcript_text()
    if needle in screen or needle in transcript:
        raise AssertionError(f"Expected {needle!r} to stay out of rendered output. Screen:\n{screen}\n\nTranscript:\n{transcript[-6000:]}")


def assert_live_stream_capability(agent_log: str) -> None:
    for event in read_agent_events(agent_log):
        if event.get("event") != "initialize-client-capabilities":
            continue
        capabilities = event.get("clientCapabilities")
        if not isinstance(capabilities, dict):
            break
        meta = capabilities.get("_meta")
        if not isinstance(meta, dict):
            break
        subagent = meta.get("alta/subagent")
        if isinstance(subagent, dict) and subagent.get("liveStreaming") is True:
            return
        break
    raise AssertionError(f"Relay did not advertise alta/subagent liveStreaming. Agent events: {read_agent_events(agent_log)}")


def write_config(relay_dir: str, agent_path: str) -> str:
    config_path = os.path.join(relay_dir, "config.toml")
    with open(config_path, "w", encoding="utf-8") as file:
        file.write(
            "[agents]\n"
            'default = "subagent-real-e2e"\n\n'
            "[agents.runners.subagent-real-e2e]\n"
            'command = "bun"\n'
            f'args = ["run", "{agent_path}"]\n'
            'profile = "alta"\n'
        )
    return config_path


def main() -> int:
    artifacts = os.path.join(ROOT, "test-results", "real-e2e")
    os.makedirs(artifacts, exist_ok=True)
    home = tempfile.mkdtemp(prefix="relay-subagent-home-")
    workspace = tempfile.mkdtemp(prefix="relay-subagent-workspace-")
    agent_log = os.path.join(workspace, "agent-events.ndjson")
    relay_dir = os.path.join(home, ".config", "relay")
    os.makedirs(relay_dir, exist_ok=True)
    agent_path = os.path.join(ROOT, "test", "real-e2e", "acp-agent.ts")
    config_path = write_config(relay_dir, agent_path)

    env = os.environ.copy()
    env.pop("XDG_CONFIG_HOME", None)
    env.update(
        {
            "HOME": home,
            "TERM": "xterm-256color",
            "NO_COLOR": "1",
            "RELAY_DISABLE_NOTIFICATIONS": "1",
            "RELAY_REAL_E2E_PROMPT_LOG": agent_log,
        }
    )

    master, slave = pty.openpty()
    HARNESS.set_pty_size(master)
    HARNESS.set_pty_size(slave)
    proc: subprocess.Popen | None = None
    passed = False

    try:
        proc = subprocess.Popen(
            relay_command(ROOT, "subagent-real-e2e"),
            cwd=workspace,
            env=env,
            stdin=slave,
            stdout=slave,
            stderr=slave,
            start_new_session=True,
        )
        os.close(slave)

        HARNESS.step("wait for Relay to connect to live ACP peer")
        wait_for(master, proc, "Connected to", 10)
        assert_live_stream_capability(agent_log)

        HARNESS.step("start live subagents and verify tool progress stays in the parent summary")
        send_text(master, "subagent live stream e2e")
        send(master, "\r")
        screen = wait_for(master, proc, "search repository", 5)
        for required in [
            "↪ subagent scout",
            "foreground",
            "Map Relay ACP subagent flow before editing",
            "↪ subagent reviewer",
            "background",
            "Check subagent live stream isolation",
        ]:
            if required not in screen:
                raise AssertionError(f"Missing rendered subagent summary {required!r}. Screen:\n{screen}")
        if "scout inspecting mapping" in screen or "reviewer stays isolated" in screen:
            raise AssertionError(f"Expected child conversation text only in /subagents detail. Screen:\n{screen}")

        HARNESS.step("open /subagents while the child tool is running")
        send_text(master, "/subagents")
        wait_for(master, proc, "list and inspect subagents", 3)
        send(master, "\r")
        picker = wait_for(master, proc, "scout (", 3)
        if "reviewer (" not in picker:
            raise AssertionError(f"Expected both live subagents in the picker. Screen:\n{picker}")
        send(master, "\r")

        HARNESS.step("inspect the scout conversation while its live stream completes")
        screen = wait_for(master, proc, "Subagents / scout (child-scout-real-e2e)", 3)
        screen = wait_for(master, proc, "scout inspecting mapping", 3)
        screen = wait_for(master, proc, "scout found renderer seam", 5)
        for required in [
            "Map Relay ACP subagent flow before editing",
            "scout inspecting mapping",
            "scout found renderer seam",
            "done",
        ]:
            if required not in screen:
                raise AssertionError(f"Missing scout detail proof {required!r}. Screen:\n{screen}")
        assert_ordered(
            screen,
            [
                "Map Relay ACP subagent flow before editing",
                "scout inspecting mapping",
                "scout found renderer seam",
            ],
        )
        if "reviewer stays isolated" in screen or "reviewer checked isolation" in screen:
            raise AssertionError(f"Reviewer output leaked into scout detail. Screen:\n{screen}")

        HARNESS.step("return to the picker and inspect the isolated reviewer conversation")
        send(master, "\x1b")
        picker = wait_for(master, proc, "reviewer (", 3)
        send(master, "\x1b[B")
        send(master, "\r")
        screen = wait_for(master, proc, "Subagents / reviewer (child-reviewer-real-e2e)", 3)
        screen = wait_for(master, proc, "reviewer checked isolation", 3)
        for required in [
            "Check subagent live stream isolation",
            "reviewer stays isolated",
            "reviewer checked isolation",
            "done",
        ]:
            if required not in screen:
                raise AssertionError(f"Missing reviewer detail proof {required!r}. Screen:\n{screen}")
        assert_ordered(
            screen,
            [
                "Check subagent live stream isolation",
                "reviewer stays isolated",
                "reviewer checked isolation",
            ],
        )
        if "scout inspecting mapping" in screen or "scout found renderer seam" in screen:
            raise AssertionError(f"Scout output leaked into reviewer detail. Screen:\n{screen}")

        HARNESS.step("close subagent views and verify compact completed summaries")
        send(master, "\x1b")
        wait_for(master, proc, "scout (", 3)
        send(master, "\x1b")
        screen = wait_for(master, proc, "subagent live stream e2e complete", 5)
        for required in ["↪ subagent scout", "1 tool call", "↪ subagent reviewer", "0 tool calls"]:
            if required not in screen:
                raise AssertionError(f"Missing completed subagent summary {required!r}. Screen:\n{screen}")
        for child_text in [
            "scout inspecting mapping",
            "scout found renderer seam",
            "reviewer stays isolated",
            "reviewer checked isolation",
        ]:
            if child_text in screen:
                raise AssertionError(f"Expected {child_text!r} to stay out of the parent transcript. Screen:\n{screen}")

        HARNESS.step("prove malformed and orphan child metadata did not leak rendered output")
        wait_for_absent(master, proc, "bad metadata leak sentinel", 1.5)
        wait_for_absent(master, proc, "orphan child leak sentinel", 1.5)
        assert_not_rendered("bad metadata leak sentinel", screen)
        assert_not_rendered("orphan child leak sentinel", screen)
        assert_not_rendered("≡ invoke-agent", screen)
        assert_not_rendered("invoke_agent", screen)

        passed = True
        return 0
    finally:
        with open(os.path.join(artifacts, "subagent-live-stream-smoke.steps.txt"), "w", encoding="utf-8") as file:
            file.write("\n".join(HARNESS.steps))
        with open(os.path.join(artifacts, "subagent-live-stream-smoke.transcript.txt"), "w", encoding="utf-8") as file:
            file.write(HARNESS.transcript_text())
        with open(os.path.join(artifacts, "subagent-live-stream-smoke.screen.txt"), "w", encoding="utf-8") as file:
            file.write(HARNESS.screen_text())
        if os.path.exists(config_path):
            shutil.copyfile(config_path, os.path.join(artifacts, "subagent-live-stream-smoke.config.toml"))
        if os.path.exists(agent_log):
            shutil.copyfile(agent_log, os.path.join(artifacts, "subagent-live-stream-smoke.agent-events.ndjson"))
        if proc is not None and proc.poll() is None:
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
        if proc is not None:
            with open(os.path.join(artifacts, "subagent-live-stream-smoke.process.txt"), "w", encoding="utf-8") as file:
                file.write(HARNESS.process_diagnostics(proc))
        try:
            os.close(master)
        except OSError:
            pass
        if passed:
            shutil.rmtree(home, ignore_errors=True)
            shutil.rmtree(workspace, ignore_errors=True)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as err:
        print(f"real e2e failed: {err}", file=sys.stderr)
        raise
