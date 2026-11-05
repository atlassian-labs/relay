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

ARTIFACTS = os.path.join(ROOT, "test-results", "real-e2e")
MAIN_TOAST = "Live toast main scenario"
WARNING_TOAST = (
    "Warning live toast edge scenario with a deliberately long message "
    "that should wrap inside the corner without overflowing"
)
WARNING_HEAD = "Warning live toast edge scenario"
WARNING_TAIL = "without overflowing"


def write_config(config_path: str, agent_path: str) -> None:
    with open(config_path, "w", encoding="utf-8") as file:
        file.write(
            '[ui]\n'
            'theme = "github-dark"\n'
            'show_tips = false\n\n'
            '[plugins]\n'
            'enabled = true\n'
            'allow_project_plugins = false\n'
            'paths = []\n'
            'trusted_workspaces = []\n'
            'disabled = ["bundled:overclock"]\n\n'
            '[notifications]\n'
            'terminal_enabled = false\n'
            'sound_enabled = false\n\n'
            '[agents]\n'
            'default = "real-e2e"\n\n'
            '[agents.runners.real-e2e]\n'
            'command = "bun"\n'
            f'args = ["run", "{agent_path}"]\n'
            'profile = "default"\n'
        )


def write_plugin(plugin_dir: str) -> None:
    os.makedirs(plugin_dir, exist_ok=True)
    with open(os.path.join(plugin_dir, "package.json"), "w", encoding="utf-8") as file:
        file.write(
            '{\n'
            '  "name": "relay-plugin-toast-smoke",\n'
            '  "description": "Relay toast real E2E smoke plugin",\n'
            '  "author": "relay",\n'
            '  "type": "module",\n'
            '  "relay": { "plugin": "index.mjs" }\n'
            '}\n'
        )
    with open(os.path.join(plugin_dir, "index.mjs"), "w", encoding="utf-8") as file:
        file.write(
            "export default function toastSmoke(relay) {\n"
            "  relay.on('session:new', () => {\n"
            "    setTimeout(() => {\n"
            f"      relay.ui.toast({MAIN_TOAST!r}, 'info', 4200);\n"
            "      setTimeout(() => {\n"
            f"        relay.ui.toast({WARNING_TOAST!r}, 'warning', 5200);\n"
            "      }, 2400);\n"
            "    }, 300);\n"
            "  });\n"
            "}\n"
        )


def line_containing(screen: str, needle: str) -> str:
    for line in screen.splitlines():
        if needle in line:
            return line
    raise AssertionError(f"Expected line containing {needle!r}. Screen:\n{screen}")


def wait_for_warning_wrap(
    harness: ChatAutoscrollPtyHarness,
    master: int,
    proc: subprocess.Popen,
    timeout: float = 8.0,
) -> tuple[str, str]:
    screen = harness.wait_for(master, proc, "⚠ Warning", timeout)
    deadline = time.time() + timeout
    while time.time() < deadline:
        warning_line = line_containing(screen, "⚠ Warning")
        if WARNING_HEAD in screen and WARNING_TAIL in screen:
            return screen, warning_line
        harness.read_available(master, 0.1)
        screen = harness.screen_text()
    raise AssertionError(f"Warning toast never showed wrapped message content. Screen:\n{screen}")


def main() -> int:
    os.makedirs(ARTIFACTS, exist_ok=True)
    home = tempfile.mkdtemp(prefix="relay-toast-smoke-home-")
    workspace = tempfile.mkdtemp(prefix="relay-toast-smoke-workspace-")
    relay_dir = os.path.join(home, ".config", "relay")
    plugin_dir = os.path.join(relay_dir, "plugins", "toast-smoke")
    config_path = os.path.join(relay_dir, "config.toml")
    agent_path = os.path.join(ROOT, "test", "real-e2e", "acp-agent.ts")
    os.makedirs(relay_dir, exist_ok=True)
    os.makedirs(os.path.join(workspace, ".git"), exist_ok=True)
    write_config(config_path, agent_path)
    write_plugin(plugin_dir)

    env = os.environ.copy()
    env.pop("XDG_CONFIG_HOME", None)
    env.update(
        {
            "HOME": home,
            "TERM": "xterm-256color",
            "NO_COLOR": "1",
            "RELAY_DISABLE_NOTIFICATIONS": "1",
        }
    )

    harness = ChatAutoscrollPtyHarness(rows=24, cols=88)
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

        harness.step("submit first prompt to trigger lazy session and plugin toast")
        harness.send_text(master, "toast smoke prompt")
        harness.send(master, "\r")

        harness.step("observe plugin-triggered info toast through real TUI")
        main_screen = harness.wait_for(master, proc, "※ " + MAIN_TOAST, 8)
        main_line = line_containing(main_screen, MAIN_TOAST)
        if "┌" in main_screen or "└" in main_screen:
            raise AssertionError(f"Toast rendered old framed border chrome. Screen:\n{main_screen}")
        if "Info" in main_line:
            raise AssertionError(f"Info toast should stay visually quiet without label. Line:\n{main_line}")

        harness.step("observe long warning toast wraps without overflowing")
        warning_screen, warning_line = wait_for_warning_wrap(harness, master, proc)
        if "┌" in warning_screen or "└" in warning_screen:
            raise AssertionError(f"Toast rendered old framed border chrome. Screen:\n{warning_screen}")
        if len(warning_line) > harness.default_cols:
            raise AssertionError(f"Warning toast line exceeded terminal width. Line:\n{warning_line}")

        passed = True
        print("[toast-smoke] observed compact info toast and wrapped warning toast", flush=True)
        return 0
    finally:
        cleanup_notes: list[str] = []
        with open(os.path.join(ARTIFACTS, "toast-smoke.steps.txt"), "w", encoding="utf-8") as file:
            file.write("\n".join(harness.steps))
        with open(os.path.join(ARTIFACTS, "toast-smoke.transcript.txt"), "w", encoding="utf-8") as file:
            file.write(harness.transcript_text())
        with open(os.path.join(ARTIFACTS, "toast-smoke.screen.txt"), "w", encoding="utf-8") as file:
            file.write(harness.screen_text())
        if os.path.exists(config_path):
            shutil.copyfile(config_path, os.path.join(ARTIFACTS, "toast-smoke.config.toml"))
        plugin_index = os.path.join(plugin_dir, "index.mjs")
        if os.path.exists(plugin_index):
            shutil.copyfile(plugin_index, os.path.join(ARTIFACTS, "toast-smoke.plugin-index.mjs"))
        try:
            os.killpg(proc.pid, signal.SIGTERM)
            cleanup_notes.append(f"sent SIGTERM to Relay process group pid={proc.pid}")
        except ProcessLookupError:
            cleanup_notes.append("Relay process already exited")
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
                cleanup_notes.append(f"sent SIGKILL to Relay process group pid={proc.pid}")
            except ProcessLookupError:
                cleanup_notes.append("Relay process exited before SIGKILL")
            proc.wait(timeout=3)
        with open(os.path.join(ARTIFACTS, "toast-smoke.process.txt"), "w", encoding="utf-8") as file:
            file.write(harness.process_diagnostics(proc))
        os.close(master)
        cleanup_notes.append("closed PTY master")
        if passed:
            shutil.rmtree(home, ignore_errors=True)
            shutil.rmtree(workspace, ignore_errors=True)
            cleanup_notes.append(f"removed temp home {home}")
            cleanup_notes.append(f"removed temp workspace {workspace}")
        else:
            cleanup_notes.append(f"left temp home for debugging {home}")
            cleanup_notes.append(f"left temp workspace for debugging {workspace}")
        with open(os.path.join(ARTIFACTS, "toast-smoke.cleanup.txt"), "w", encoding="utf-8") as file:
            file.write("\n".join(cleanup_notes) + "\n")


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as err:
        print(f"toast real e2e failed: {err}", file=sys.stderr)
        raise
