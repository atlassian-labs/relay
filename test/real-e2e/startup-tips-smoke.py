#!/usr/bin/env python3
import os
import pty
import shutil
import signal
import subprocess
import sys
import tempfile
import time

from relay_command import relay_command

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
TEST_LIB = os.path.join(ROOT, "test", "lib")
if TEST_LIB not in sys.path:
    sys.path.insert(0, TEST_LIB)

from real_e2e_chat_autoscroll import ChatAutoscrollPtyHarness


def write_relay_config(relay_dir: str, agent_path: str, show_tips: bool) -> None:
    os.makedirs(relay_dir, exist_ok=True)
    with open(os.path.join(relay_dir, "config.toml"), "w", encoding="utf-8") as file:
        file.write(
            "[ui]\n"
            f"show_tips = {str(show_tips).lower()}\n\n"
            "[notifications]\n"
            "sound_enabled = false\n\n"
            "[plugins]\n"
            "enabled = false\n\n"
            "[agents]\n"
            'default = "real-e2e"\n\n'
            "[agents.runners.real-e2e]\n"
            'command = "bun"\n'
            f'args = ["run", "{agent_path}"]\n'
            'profile = "default"\n'
        )


def launch(show_tips: bool):
    home = tempfile.mkdtemp(prefix="relay-real-e2e-tips-home-")
    workspace = tempfile.mkdtemp(prefix="relay-real-e2e-tips-workspace-")
    relay_dir = os.path.join(home, ".config", "relay")
    agent_path = os.path.join(ROOT, "test", "real-e2e", "acp-agent.ts")
    write_relay_config(relay_dir, agent_path, show_tips=show_tips)

    env = os.environ.copy()
    env.pop("XDG_CONFIG_HOME", None)
    env.update({
        "HOME": home,
        "TERM": "xterm-256color",
        "NO_COLOR": "1",
        "RELAY_REAL_E2E_PROMPT_LOG": os.path.join(workspace, "agent-prompts.ndjson"),
        "RELAY_REAL_E2E_PROMPT_DELAY_MS": "1500",
    })

    master, slave = pty.openpty()
    harness = ChatAutoscrollPtyHarness(30, 120)
    harness.set_pty_size(master)
    harness.set_pty_size(slave)
    proc = subprocess.Popen(
        relay_command(ROOT, "real-e2e"),
        cwd=workspace,
        env=env,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        start_new_session=True,
    )
    os.close(slave)
    return harness, proc, master, home, workspace


def cleanup(harness: ChatAutoscrollPtyHarness, proc: subprocess.Popen, master: int, home: str, workspace: str, artifacts: str, label: str, passed: bool) -> None:
    with open(os.path.join(artifacts, f"startup-tips-{label}.screen.txt"), "w", encoding="utf-8") as file:
        file.write(harness.screen_text())
    with open(os.path.join(artifacts, f"startup-tips-{label}.transcript.txt"), "w", encoding="utf-8") as file:
        file.write(harness.transcript_text())
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
    with open(os.path.join(artifacts, f"startup-tips-{label}.process.txt"), "w", encoding="utf-8") as file:
        file.write(harness.process_diagnostics(proc))
    os.close(master)
    if passed:
        shutil.rmtree(home, ignore_errors=True)
        shutil.rmtree(workspace, ignore_errors=True)


def visible_tip_line(screen: str) -> str | None:
    marker = "L Tip:"
    for line in screen.splitlines():
        if marker not in line:
            continue
        if line.split(marker, 1)[1].strip():
            return line.strip()
    return None


def prompt_line_contains(screen: str, text: str) -> bool:
    return any(line.strip().startswith(">") and text in line for line in screen.splitlines())


def run_tips_enabled(artifacts: str) -> None:
    harness, proc, master, home, workspace = launch(show_tips=True)
    passed = False
    try:
        harness.step("turn tips: enabled tip renders under the working status")
        harness.wait_for(master, proc, "Connected to", 10)
        harness.send_text(master, "slow real active-turn prompt\r")
        deadline = time.time() + 5
        tip_line = None
        screen = ""
        while time.time() < deadline:
            harness.assert_process_running(proc)
            harness.read_available(master, 0.1)
            screen = harness.screen_text()
            tip_line = visible_tip_line(screen)
            if tip_line and "Working" in screen:
                break
        if not tip_line:
            raise AssertionError(f"Expected a turn tip under Working. Screen:\n{screen}")
        if prompt_line_contains(screen, "L Tip:"):
            raise AssertionError(f"Turn tip rendered inside composer prompt line: {tip_line!r}\n{screen}")
        passed = True
    finally:
        cleanup(harness, proc, master, home, workspace, artifacts, "enabled", passed)


def run_tips_disabled(artifacts: str) -> None:
    harness, proc, master, home, workspace = launch(show_tips=False)
    passed = False
    try:
        harness.step("startup tips: disabled config suppresses idle tips")
        harness.wait_for(master, proc, "Connected to", 10)
        end = time.time() + 1.5
        screen = ""
        while time.time() < end:
            harness.assert_process_running(proc)
            harness.read_available(master, 0.1)
            screen = harness.screen_text()
            tip_line = visible_tip_line(screen)
            if tip_line:
                raise AssertionError(f"show_tips=false still rendered startup tip {tip_line!r}\n{screen}")
        passed = True
    finally:
        cleanup(harness, proc, master, home, workspace, artifacts, "disabled", passed)


def main() -> int:
    artifacts = os.path.join(ROOT, "test-results", "real-e2e")
    os.makedirs(artifacts, exist_ok=True)
    run_tips_enabled(artifacts)
    run_tips_disabled(artifacts)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as err:
        print(f"real e2e failed: {err}", file=sys.stderr)
        raise
