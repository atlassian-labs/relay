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
from typing import Any

from relay_command import relay_command

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
TEST_LIB = os.path.join(ROOT, "test", "lib")
if TEST_LIB not in sys.path:
    sys.path.insert(0, TEST_LIB)

from real_e2e_chat_autoscroll import ChatAutoscrollPtyHarness

SCREEN_ROWS = 30
SCREEN_COLS = 120
CACHE_FILE = os.path.join(".config", "relay", "cache", "agent-slash-commands.json")


def toml_string_array(values: list[str]) -> str:
    return "[" + ", ".join(json.dumps(value) for value in values) + "]"


def write_relay_config(relay_dir: str, agent_path: str, disabled_builtin_slash_commands: list[str] | None = None) -> None:
    os.makedirs(relay_dir, exist_ok=True)
    disabled_commands = disabled_builtin_slash_commands or []
    ui_section = ""
    if disabled_commands:
        ui_section = "[ui]\n" f"disabled_builtin_slash_commands = {toml_string_array(disabled_commands)}\n\n"
    with open(os.path.join(relay_dir, "config.toml"), "w", encoding="utf-8") as file:
        file.write(
            ui_section
            + "[plugins]\n"
            "enabled = false\n\n"
            "[notifications]\n"
            "sound_enabled = false\n\n"
            "[agents]\n"
            'default = "real-e2e"\n\n'
            "[agents.runners.real-e2e]\n"
            'command = "bun"\n'
            f'args = ["run", "{agent_path}"]\n'
            'profile = "default"\n'
        )


class RelayRun:
    def __init__(
        self,
        name: str,
        home: str,
        workspace: str,
        command_delay_ms: int,
        late_delay_ms: int = 0,
        advertise_real_skill: bool = True,
        empty_available_commands: bool = False,
        advertise_review_command: bool = False,
    ) -> None:
        self.name = name
        self.home = home
        self.workspace = workspace
        self.agent_log = os.path.join(workspace, f"{name}.agent-events.ndjson")
        env = os.environ.copy()
        env.pop("XDG_CONFIG_HOME", None)
        env.update(
            {
                "HOME": home,
                "TERM": "xterm-256color",
                "NO_COLOR": "1",
                "RELAY_DISABLE_NOTIFICATIONS": "1",
                "RELAY_REAL_E2E_PROMPT_LOG": self.agent_log,
                "RELAY_REAL_E2E_ADVERTISE_REAL_SKILL_COMMAND": "1" if advertise_real_skill else "0",
                "RELAY_REAL_E2E_EMPTY_AVAILABLE_COMMANDS": "1" if empty_available_commands else "0",
                "RELAY_REAL_E2E_ADVERTISE_REVIEW_COMMAND": "1" if advertise_review_command else "0",
                "RELAY_REAL_E2E_DELAY_AVAILABLE_COMMANDS_UPDATE_MS": str(command_delay_ms),
                "RELAY_REAL_E2E_LATE_AVAILABLE_COMMANDS_UPDATE_MS": str(late_delay_ms),
            }
        )
        master, slave = pty.openpty()
        self.master = master
        self.harness = ChatAutoscrollPtyHarness(SCREEN_ROWS, SCREEN_COLS)
        self.harness.set_pty_size(master)
        self.harness.set_pty_size(slave)
        self.proc = subprocess.Popen(
            relay_command(ROOT, "real-e2e"),
            cwd=workspace,
            env=env,
            stdin=slave,
            stdout=slave,
            stderr=slave,
            start_new_session=True,
        )
        os.close(slave)

    def stop(self, artifacts: str) -> None:
        os.makedirs(artifacts, exist_ok=True)
        prefix = f"slash-command-smoke.{self.name}"
        with open(os.path.join(artifacts, f"{prefix}.steps.txt"), "w", encoding="utf-8") as file:
            file.write("\n".join(self.harness.steps))
        with open(os.path.join(artifacts, f"{prefix}.screen.txt"), "w", encoding="utf-8") as file:
            file.write(self.harness.screen_text())
        with open(os.path.join(artifacts, f"{prefix}.transcript.txt"), "w", encoding="utf-8") as file:
            file.write(self.harness.transcript_text())
        if os.path.exists(self.agent_log):
            shutil.copyfile(self.agent_log, os.path.join(artifacts, f"{prefix}.agent-events.ndjson"))
        try:
            os.killpg(self.proc.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            self.proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(self.proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            self.proc.wait(timeout=3)
        with open(os.path.join(artifacts, f"{prefix}.process.txt"), "w", encoding="utf-8") as file:
            file.write(self.harness.process_diagnostics(self.proc))
        try:
            os.close(self.master)
        except OSError:
            pass


def cache_path(home: str) -> str:
    return os.path.join(home, CACHE_FILE)


def cache_commands(home: str) -> list[str]:
    path = cache_path(home)
    if not os.path.exists(path):
        return []
    try:
        data = json.load(open(path, "r", encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    commands: list[str] = []
    for entry in data.get("entries", {}).values():
        for command in entry.get("commands", []):
            name = command.get("name")
            if isinstance(name, str):
                commands.append(name)
    return commands


def wait_for_cache(home: str, command_name: str, present: bool, timeout: float = 5.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        commands = cache_commands(home)
        if (command_name in commands) == present:
            return
        time.sleep(0.05)
    state = cache_commands(home)
    expected = "contain" if present else "not contain"
    raise AssertionError(f"Expected command cache to {expected} {command_name!r}; found {state}")


def request_count(run: RelayRun, method: str) -> int:
    return sum(
        1
        for entry in run.harness.read_agent_events(run.agent_log)
        if entry.get("event") == "request" and entry.get("method") == method
    )


def wait_for_request(run: RelayRun, method: str, timeout: float = 5.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if request_count(run, method) > 0:
            return
        time.sleep(0.05)
    raise AssertionError(f"Timed out waiting for ACP request {method!r}: {run.harness.read_agent_events(run.agent_log)}")


def available_command_events(run: RelayRun, command_name: str) -> list[dict[str, Any]]:
    return [
        entry
        for entry in run.harness.read_agent_events(run.agent_log)
        if entry.get("event") == "available-commands-update" and command_name in entry.get("commands", [])
    ]


def wait_for_available_commands(run: RelayRun, command_name: str, timeout: float = 5.0) -> dict[str, Any]:
    deadline = time.time() + timeout
    while time.time() < deadline:
        events = available_command_events(run, command_name)
        if events:
            return events[0]
        time.sleep(0.05)
    raise AssertionError(
        f"Timed out waiting for available_commands_update containing {command_name!r}: {run.harness.read_agent_events(run.agent_log)}"
    )


def assert_no_agent_prompts(run: RelayRun) -> None:
    prompts = [entry for entry in run.harness.read_agent_events(run.agent_log) if entry.get("event") == "prompt"]
    if prompts:
        raise AssertionError(f"Slash autocomplete/settings browsing unexpectedly submitted ACP prompts: {prompts}")


def wait_for_prompt_text(run: RelayRun, text: str, timeout: float = 5.0) -> dict[str, Any]:
    deadline = time.time() + timeout
    while time.time() < deadline:
        for entry in run.harness.read_agent_events(run.agent_log):
            if entry.get("event") == "prompt" and entry.get("text") == text:
                return entry
        time.sleep(0.05)
    raise AssertionError(f"Timed out waiting for prompt text {text!r}: {run.harness.read_agent_events(run.agent_log)}")


def wait_connected(run: RelayRun) -> None:
    run.harness.step("wait for Relay to connect through real CLI and ACP stdio")
    run.harness.wait_for(run.master, run.proc, "Connected to", 10)
    wait_for_request(run, "session/new", 5)


def main() -> int:
    artifacts = os.path.join(ROOT, "test-results", "real-e2e")
    home = tempfile.mkdtemp(prefix="relay-real-e2e-slash-home-")
    workspace = tempfile.mkdtemp(prefix="relay-real-e2e-slash-workspace-")
    write_relay_config(
        os.path.join(home, ".config", "relay"),
        os.path.join(ROOT, "test", "real-e2e", "acp-agent.ts"),
    )
    passed = False
    runs: list[RelayRun] = []

    try:
        warm = RelayRun("01-warm-cache", home, workspace, command_delay_ms=0)
        runs.append(warm)
        wait_connected(warm)
        warm.harness.step("warm the persisted command cache from authoritative ACP startup commands")
        warm.harness.send_text(warm.master, "/real-")
        screen = warm.harness.wait_for(warm.master, warm.proc, "/real-skill", 5)
        if "agent-side real skill command" not in screen:
            raise AssertionError(f"Expected authoritative command metadata while warming cache. Screen:\n{screen}")
        wait_for_cache(home, "real-skill", True, 5)
        assert_no_agent_prompts(warm)
        warm.stop(artifacts)

        cached = RelayRun("02-cached-before-hydration", home, workspace, command_delay_ms=3500)
        runs.append(cached)
        wait_connected(cached)
        cached.harness.step("show cached ACP command before delayed live hydration publishes it")
        cached.harness.send_text(cached.master, "/real-")
        screen = cached.harness.wait_for(cached.master, cached.proc, "/real-skill", 1.5)
        if "agent-side real skill command" not in screen:
            raise AssertionError(f"Expected cached command metadata before live hydration. Screen:\n{screen}")
        if available_command_events(cached, "real-skill"):
            raise AssertionError(
                "Cached command appeared only after live available_commands_update; expected pre-hydration autocomplete."
            )
        assert_no_agent_prompts(cached)
        wait_for_available_commands(cached, "real-skill", 5)
        cached.stop(artifacts)

        clear = RelayRun("03-clear-cache", home, workspace, command_delay_ms=0, empty_available_commands=True)
        runs.append(clear)
        wait_connected(clear)
        clear.harness.step("authoritative empty ACP command list clears stale cached commands")
        wait_for_cache(home, "real-skill", False, 5)
        clear.harness.send_text(clear.master, "/real-")
        clear.harness.wait_for_absent(clear.master, clear.proc, "/real-skill", 0.7)
        assert_no_agent_prompts(clear)
        clear.stop(artifacts)

        delayed = RelayRun("04-delayed-live-update", home, workspace, command_delay_ms=1400, late_delay_ms=3500)
        runs.append(delayed)
        wait_connected(delayed)
        delayed.harness.step("open bare slash autocomplete and verify native commands render immediately")
        delayed.harness.send_text(delayed.master, "/")
        screen = delayed.harness.wait_for(delayed.master, delayed.proc, "/copy", 5)
        if "copy last response" not in screen:
            raise AssertionError(f"Expected native slash command metadata before ACP command metadata. Screen:\n{screen}")
        delayed.harness.wait_for_absent(delayed.master, delayed.proc, "/real-skill", 0.25)
        if request_count(delayed, "session/new") != 1:
            raise AssertionError(
                f"Slash autocomplete created an extra session/new request: {delayed.harness.read_agent_events(delayed.agent_log)}"
            )
        assert_no_agent_prompts(delayed)

        delayed.harness.step("type an agent-only slash prefix before delayed commands arrive")
        delayed.harness.send_text(delayed.master, "real-")
        delayed.harness.wait_for_absent(delayed.master, delayed.proc, "/real-skill", 0.25)
        assert_no_agent_prompts(delayed)

        delayed.harness.step("verify delayed available_commands_update refreshes the open slash overlay")
        wait_for_available_commands(delayed, "real-skill", 5)
        screen = delayed.harness.wait_for(delayed.master, delayed.proc, "/real-skill", 5)
        if "agent-side real skill command" not in screen:
            raise AssertionError(f"Expected delayed ACP command description in slash overlay. Screen:\n{screen}")
        assert_no_agent_prompts(delayed)

        delayed.harness.step("verify later ACP command updates do not hijack a non-slash selection overlay")
        delayed.harness.send(delayed.master, "\x15")
        delayed.harness.wait_for_absent(delayed.master, delayed.proc, "/real-skill", 2)
        delayed.harness.send_text(delayed.master, "/settings")
        delayed.harness.send(delayed.master, "\r")
        settings_screen = delayed.harness.wait_for(delayed.master, delayed.proc, "slash panel position", 5)
        if "/settings" in settings_screen and "slash panel position" not in settings_screen:
            raise AssertionError(f"Expected settings overlay, not slash autocomplete. Screen:\n{settings_screen}")
        wait_for_available_commands(delayed, "late-settings-skill", 5)
        delayed.harness.read_available(delayed.master, 0.5)
        screen = delayed.harness.screen_text()
        if "slash panel position" not in screen:
            raise AssertionError(f"Expected settings overlay to remain after late command update. Screen:\n{screen}")
        if "late-settings-skill" in screen or "late command must not hijack settings overlay" in screen:
            raise AssertionError(f"Late ACP command update hijacked settings overlay. Screen:\n{screen}")
        assert_no_agent_prompts(delayed)
        delayed.stop(artifacts)

        disabled_home = tempfile.mkdtemp(prefix="relay-real-e2e-disabled-builtin-home-")
        disabled_workspace = tempfile.mkdtemp(prefix="relay-real-e2e-disabled-builtin-workspace-")
        write_relay_config(
            os.path.join(disabled_home, ".config", "relay"),
            os.path.join(ROOT, "test", "real-e2e", "acp-agent.ts"),
            disabled_builtin_slash_commands=["relay.review"],
        )
        disabled = RelayRun(
            "05-disabled-builtin-review",
            disabled_home,
            disabled_workspace,
            command_delay_ms=0,
            advertise_real_skill=False,
            advertise_review_command=True,
        )
        runs.append(disabled)
        wait_connected(disabled)
        disabled.harness.step("disabled built-in /review leaves agent review command visible without Relay conflict alias")
        wait_for_available_commands(disabled, "review", 5)
        disabled.harness.send_text(disabled.master, "/re")
        screen = disabled.harness.wait_for(disabled.master, disabled.proc, "/review", 5)
        if "agent-side review command" not in screen:
            raise AssertionError(f"Expected ACP review command metadata in slash overlay. Screen:\n{screen}")
        if "/relay.review" in screen:
            raise AssertionError(f"Disabled Relay review command still appeared as a conflict alias. Screen:\n{screen}")
        disabled.harness.send(disabled.master, "\x15")

        disabled.harness.step("disabled built-in /review dispatches the agent command as raw slash text")
        disabled.harness.send_text(disabled.master, "/review live main")
        disabled.harness.send(disabled.master, "\x1b")
        disabled.harness.send(disabled.master, "\r")
        main_prompt = wait_for_prompt_text(disabled, "/review live main", 5)
        if '<skill name="review"' in str(main_prompt.get("text", "")):
            raise AssertionError(f"Relay expanded the disabled /review built-in skill. Event:\n{main_prompt}")
        disabled.harness.wait_for(disabled.master, disabled.proc, "ack: /review live main", 5)

        disabled.harness.step("disabled relay-prefixed /relay.review also falls through as raw slash text")
        disabled.harness.send_text(disabled.master, "/relay.review live edge")
        disabled.harness.send(disabled.master, "\x1b")
        disabled.harness.send(disabled.master, "\r")
        edge_prompt = wait_for_prompt_text(disabled, "/relay.review live edge", 5)
        if '<skill name="review"' in str(edge_prompt.get("text", "")):
            raise AssertionError(f"Relay expanded the disabled relay-prefixed review built-in skill. Event:\n{edge_prompt}")
        disabled.stop(artifacts)
        shutil.rmtree(disabled_home, ignore_errors=True)
        shutil.rmtree(disabled_workspace, ignore_errors=True)

        passed = True
        return 0
    finally:
        for run in reversed(runs):
            if run.proc.poll() is None:
                run.stop(artifacts)
        if os.path.exists(cache_path(home)):
            shutil.copyfile(cache_path(home), os.path.join(artifacts, "slash-command-smoke.agent-slash-commands.json"))
        if passed:
            shutil.rmtree(home, ignore_errors=True)
            shutil.rmtree(workspace, ignore_errors=True)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as err:
        print(f"real e2e failed: {err}", file=sys.stderr)
        raise
