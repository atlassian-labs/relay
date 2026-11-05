#!/usr/bin/env python3
import os
import pty
import shutil
import signal
import subprocess
import sys
import tempfile

from relay_command import relay_command

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
TEST_LIB = os.path.join(ROOT, "test", "lib")
if TEST_LIB not in sys.path:
    sys.path.insert(0, TEST_LIB)

from real_e2e_chat_autoscroll import ChatAutoscrollPtyHarness, run_chat_autoscroll_probe


def write_config(config_path: str, agent_path: str) -> None:
    with open(config_path, "w", encoding="utf-8") as file:
        file.write(
            '[plugins]\n'
            'enabled = true\n'
            'allow_project_plugins = false\n'
            'paths = []\n'
            'trusted_workspaces = []\n'
            'disabled = []\n\n'
            '[agents]\n'
            'default = "real-e2e"\n\n'
            '[agents.runners.real-e2e]\n'
            'command = "bun"\n'
            f'args = ["run", "{agent_path}"]\n'
            'profile = "default"\n'
        )


def main() -> int:
    artifacts = os.path.join(ROOT, "test-results", "real-e2e")
    os.makedirs(artifacts, exist_ok=True)
    home = tempfile.mkdtemp(prefix="relay-chat-autoscroll-home-")
    workspace = tempfile.mkdtemp(prefix="relay-chat-autoscroll-workspace-")
    agent_log = os.path.join(workspace, "agent-events.ndjson")
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

    relay_dir = os.path.join(home, ".config", "relay")
    os.makedirs(relay_dir, exist_ok=True)
    agent_path = os.path.join(ROOT, "test", "real-e2e", "acp-agent.ts")
    config_path = os.path.join(relay_dir, "config.toml")
    write_config(config_path, agent_path)

    harness = ChatAutoscrollPtyHarness()
    command = relay_command(ROOT, "real-e2e")
    master, slave = pty.openpty()
    harness.set_pty_size(master)
    harness.set_pty_size(slave)
    passed = False
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

    try:
        harness.step("wait for Relay to connect through real CLI")
        harness.wait_for(master, proc, "Connected to", 10)
        harness.wait_for(master, proc, "\n >", 5)
        run_chat_autoscroll_probe(harness, master, proc, agent_log)
        passed = True
        return 0
    finally:
        with open(os.path.join(artifacts, "chat-autoscroll-smoke.steps.txt"), "w", encoding="utf-8") as file:
            file.write("\n".join(harness.steps))
        with open(os.path.join(artifacts, "chat-autoscroll-smoke.transcript.txt"), "w", encoding="utf-8") as file:
            file.write(harness.transcript_text())
        with open(os.path.join(artifacts, "chat-autoscroll-smoke.screen.txt"), "w", encoding="utf-8") as file:
            file.write(harness.screen_text())
        if os.path.exists(config_path):
            shutil.copyfile(config_path, os.path.join(artifacts, "chat-autoscroll-smoke.config.toml"))
        if os.path.exists(agent_log):
            shutil.copyfile(agent_log, os.path.join(artifacts, "chat-autoscroll-smoke.agent-events.ndjson"))
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
        with open(os.path.join(artifacts, "chat-autoscroll-smoke.process.txt"), "w", encoding="utf-8") as file:
            file.write(harness.process_diagnostics(proc))
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
