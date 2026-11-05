#!/usr/bin/env python3
import fcntl
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

from relay_command import relay_command

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCREEN_ROWS = 32
SCREEN_COLS = 120
ANSI_RE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
FORBIDDEN_COMPACT_SKILL_TEXT = ("Use the real skill body.", "location", "SKILL.md", "ctrl+o", "register_cmd")
REAL_SKILL_BODY = "Use the real skill body."
REAL_SKILL_REGISTER_CMD = "register_cmd: true"
LOCAL_SKILL_TRAP_BODY = "This local SKILL.md trap must be ignored."


class Screen:
    def __init__(self, rows: int = SCREEN_ROWS, cols: int = SCREEN_COLS):
        self.rows = rows
        self.cols = cols
        self.row = 0
        self.col = 0
        self.grid = [[" " for _ in range(cols)] for _ in range(rows)]
        self.pending_escape = ""

    def text(self) -> str:
        return "\n".join("".join(row).rstrip() for row in self.grid)

    def clear(self) -> None:
        self.grid = [[" " for _ in range(self.cols)] for _ in range(self.rows)]
        self.row = 0
        self.col = 0

    def put(self, ch: str) -> None:
        if ch == "\n":
            self.row = min(self.rows - 1, self.row + 1)
            return
        if ch == "\r":
            self.col = 0
            return
        if ch == "\b":
            self.col = max(0, self.col - 1)
            return
        if ord(ch) < 32 or ord(ch) == 127:
            return
        if 0 <= self.row < self.rows and 0 <= self.col < self.cols:
            self.grid[self.row][self.col] = ch
        self.col += 1
        if self.col >= self.cols:
            self.col = 0
            self.row = min(self.rows - 1, self.row + 1)

    def csi(self, params: str, final: str) -> None:
        values = [int(part) if part.isdigit() else 0 for part in params.replace("?", "").split(";") if part != ""]
        if final in ("H", "f"):
            self.row = max(0, min(self.rows - 1, (values[0] if len(values) > 0 and values[0] else 1) - 1))
            self.col = max(0, min(self.cols - 1, (values[1] if len(values) > 1 and values[1] else 1) - 1))
        elif final == "J" and (not values or values[0] in (0, 2, 3)):
            self.clear()
        elif final == "K":
            mode = values[0] if values else 0
            start = 0 if mode == 1 else self.col
            end = self.cols if mode in (0, 2) else self.col + 1
            for col in range(max(0, start), min(self.cols, end)):
                self.grid[self.row][col] = " "
        elif final == "A":
            self.row = max(0, self.row - (values[0] if values and values[0] else 1))
        elif final == "B":
            self.row = min(self.rows - 1, self.row + (values[0] if values and values[0] else 1))
        elif final == "C":
            self.col = min(self.cols - 1, self.col + (values[0] if values and values[0] else 1))
        elif final == "D":
            self.col = max(0, self.col - (values[0] if values and values[0] else 1))

    def feed(self, data: str) -> None:
        data = self.pending_escape + data
        self.pending_escape = ""
        i = 0
        while i < len(data):
            ch = data[i]
            if ch != "\x1b":
                self.put(ch)
                i += 1
                continue
            if i + 1 >= len(data):
                self.pending_escape = data[i:]
                break
            kind = data[i + 1]
            if kind == "[":
                j = i + 2
                while j < len(data) and not ("@" <= data[j] <= "~"):
                    j += 1
                if j < len(data):
                    self.csi(data[i + 2 : j], data[j])
                    i = j + 1
                    continue
                self.pending_escape = data[i:]
                break
            if kind == "]":
                j = data.find("\x07", i + 2)
                st = data.find("\x1b\\", i + 2)
                stops = [pos for pos in (j, st) if pos != -1]
                if stops:
                    stop = min(stops)
                    i = stop + (2 if stop == st else 1)
                    continue
                self.pending_escape = data[i:]
                break
            i += 2


class RelayRun:
    def __init__(self, label: str, transcript: list[str], steps: list[str]):
        self.label = label
        self.transcript = transcript
        self.steps = steps
        self.screen = Screen()

    def clean(self, text: str) -> str:
        text = ANSI_RE.sub("", text)
        text = text.replace("\r", "\n")
        return CONTROL_RE.sub("", text)

    def transcript_text(self) -> str:
        return self.clean("".join(self.transcript))

    def step(self, name: str) -> None:
        self.steps.append(f"{self.label}: {name}")
        print(f"[real-e2e] {self.label}: {name}", flush=True)

    def read_available(self, fd: int, timeout: float = 0.05) -> str:
        chunks = []
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
            self.transcript.append(decoded)
            self.screen.feed(decoded)
            chunks.append(decoded)
        return "".join(chunks)

    def assert_process_running(self, proc: subprocess.Popen) -> None:
        if proc.poll() is not None:
            raise AssertionError(f"Relay exited before expected UI state: exited with code {proc.poll()}")

    def wait_for(self, fd: int, proc: subprocess.Popen, needle: str, timeout: float = 8.0) -> str:
        deadline = time.time() + timeout
        while time.time() < deadline:
            self.assert_process_running(proc)
            self.read_available(fd, 0.1)
            screen = self.screen.text()
            if needle in screen:
                return screen
        raise AssertionError(
            f"Timed out waiting for {needle!r}. Screen:\n{self.screen.text()}\n\nTranscript:\n{self.transcript_text()[-4000:]}"
        )

    def wait_for_absent(self, fd: int, proc: subprocess.Popen, needle: str, timeout: float = 1.5) -> str:
        deadline = time.time() + timeout
        last_screen = self.screen.text()
        while time.time() < deadline:
            self.assert_process_running(proc)
            self.read_available(fd, 0.1)
            last_screen = self.screen.text()
            if needle in last_screen:
                raise AssertionError(f"Unexpected {needle!r} on current terminal screen:\n{last_screen}")
        return last_screen

    def send(self, fd: int, data: str) -> None:
        os.write(fd, data.encode("utf-8"))
        self.read_available(fd, 0.1)

    def send_text(self, fd: int, text: str) -> None:
        for ch in text:
            self.send(fd, ch)

    def press_shift_enter(self, fd: int) -> None:
        self.send(fd, "\x1b[13;2u")


def set_pty_size(fd: int) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", SCREEN_ROWS, SCREEN_COLS, 0, 0))


def process_diagnostics(proc: subprocess.Popen) -> str:
    code = proc.poll()
    return "still running" if code is None else f"exited with code {code}"


def read_agent_prompt_texts(path: str) -> list[str]:
    if not os.path.exists(path):
        return []
    prompts = []
    with open(path, "r", encoding="utf-8") as file:
        for line in file:
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            if entry.get("event") == "prompt" and isinstance(entry.get("text"), str):
                prompts.append(entry["text"])
    return prompts


def write_ignored_local_skill_trap(workspace: str) -> str:
    os.makedirs(os.path.join(workspace, ".git"), exist_ok=True)
    skill_dir = os.path.join(workspace, ".agents", "skills", "real-skill")
    os.makedirs(skill_dir, exist_ok=True)
    skill_file = os.path.join(skill_dir, "SKILL.md")
    with open(skill_file, "w", encoding="utf-8") as file:
        file.write(f"not valid skill frontmatter\n{LOCAL_SKILL_TRAP_BODY}\n")
    return skill_file


def write_config(relay_dir: str, agent_path: str, plugin_paths: list[str]) -> str:
    config_path = os.path.join(relay_dir, "config.toml")
    paths = ", ".join(json.dumps(path) for path in plugin_paths)
    with open(config_path, "w", encoding="utf-8") as file:
        file.write(
            "[plugins]\n"
            "enabled = true\n"
            "allow_project_plugins = false\n"
            f"paths = [{paths}]\n"
            "trusted_workspaces = []\n"
            "disabled = []\n\n"
            "[agents]\n"
            'default = "real-e2e"\n\n'
            "[agents.runners.real-e2e]\n"
            'command = "bun"\n'
            f'args = ["run", "{agent_path}"]\n'
            'profile = "default"\n'
        )
    return config_path


def submit_prompt(run: RelayRun, fd: int, prompt: str) -> None:
    lines = prompt.split("\n")
    run.send_text(fd, lines[0])
    for line in lines[1:]:
        run.press_shift_enter(fd)
        run.send_text(fd, line)
    run.send(fd, "\r")


def assert_compact_skill_screen(screen: str, header: str, args: str, label: str) -> None:
    if header not in screen:
        raise AssertionError(f"Expected compact skill header {header!r} for {label}. Screen:\n{screen}")
    for arg_line in args.split("\n"):
        if arg_line and arg_line.strip() not in screen:
            raise AssertionError(f"Expected skill args line {arg_line!r} for {label}. Screen:\n{screen}")
    if not args and f"{header} —" in screen:
        raise AssertionError(f"Expected no compact args suffix for argless {label}. Screen:\n{screen}")
    for forbidden in FORBIDDEN_COMPACT_SKILL_TEXT:
        if forbidden in screen:
            raise AssertionError(f"Expected compact skill preview for {label}, found {forbidden!r}. Screen:\n{screen}")


def run_agent_command_collision_case(artifacts: str, all_steps: list[str]) -> None:
    label = "agent-command-collision"
    home = tempfile.mkdtemp(prefix="relay-skill-compact-collision-home-")
    workspace = tempfile.mkdtemp(prefix="relay-skill-compact-collision-workspace-")
    transcript: list[str] = []
    run = RelayRun(label, transcript, all_steps)
    agent_prompt_log = os.path.join(workspace, "agent-prompts.ndjson")
    relay_dir = os.path.join(home, ".config", "relay")
    os.makedirs(relay_dir, exist_ok=True)
    write_ignored_local_skill_trap(workspace)
    agent_path = os.path.join(ROOT, "test", "real-e2e", "acp-agent.ts")
    config_path = write_config(relay_dir, agent_path, [])

    env = os.environ.copy()
    env.pop("XDG_CONFIG_HOME", None)
    env.update(
        {
            "HOME": home,
            "TERM": "xterm-256color",
            "NO_COLOR": "1",
            "RELAY_DISABLE_NOTIFICATIONS": "1",
            "RELAY_REAL_E2E_ADVERTISE_REAL_SKILL_COMMAND": "1",
            "RELAY_REAL_E2E_PROMPT_LOG": agent_prompt_log,
        }
    )

    command = relay_command(ROOT, "real-e2e")
    master, slave = pty.openpty()
    set_pty_size(master)
    set_pty_size(slave)
    passed = False
    proc = subprocess.Popen(command, cwd=workspace, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
    os.close(slave)

    try:
        run.step("wait for Relay to connect through real CLI")
        run.wait_for(master, proc, "Connected to", 10)

        run.step("verify slash autocomplete shows ACP metadata and ignores local skill trap")
        args = "collision args"
        run.send_text(master, "/real-")
        run.wait_for(master, proc, "agent-side real skill command", 5)
        run.wait_for_absent(master, proc, LOCAL_SKILL_TRAP_BODY, 2)

        run.step("submit ACP slash command whose name also has an invalid local SKILL.md trap")
        run.send_text(master, f"skill {args}")
        run.send(master, "\r")
        screen = run.wait_for(master, proc, f"ack: /real-skill {args}", 8)
        assert_compact_skill_screen(screen, "[skill] real-skill", args, label)
        if "Failed to load skill" in screen or LOCAL_SKILL_TRAP_BODY in screen:
            raise AssertionError(f"Expected local SKILL.md trap to be ignored for {label}. Screen:\n{screen}")

        run.step("verify ACP received the literal slash command, not expanded local skill content")
        prompts = read_agent_prompt_texts(agent_prompt_log)
        expected_prompt = f"/real-skill {args}"
        if prompts != [expected_prompt]:
            raise AssertionError(f"Expected literal ACP slash command for {label}, got {prompts}")
        if any(
            '<skill name="real-skill"' in prompt or REAL_SKILL_BODY in prompt or LOCAL_SKILL_TRAP_BODY in prompt
            for prompt in prompts
        ):
            raise AssertionError(f"Expected no local skill expansion for {label}, got {prompts}")
        passed = True
    finally:
        with open(os.path.join(artifacts, f"skill-compact-smoke.{label}.steps.txt"), "w", encoding="utf-8") as file:
            file.write("\n".join(step for step in all_steps if step.startswith(f"{label}:")))
        with open(os.path.join(artifacts, f"skill-compact-smoke.{label}.transcript.txt"), "w", encoding="utf-8") as file:
            file.write(run.transcript_text())
        with open(os.path.join(artifacts, f"skill-compact-smoke.{label}.screen.txt"), "w", encoding="utf-8") as file:
            file.write(run.screen.text())
        if os.path.exists(config_path):
            shutil.copyfile(config_path, os.path.join(artifacts, f"skill-compact-smoke.{label}.config.toml"))
        if os.path.exists(agent_prompt_log):
            shutil.copyfile(agent_prompt_log, os.path.join(artifacts, f"skill-compact-smoke.{label}.agent-prompts.ndjson"))
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
        with open(os.path.join(artifacts, f"skill-compact-smoke.{label}.process.txt"), "w", encoding="utf-8") as file:
            file.write(process_diagnostics(proc))
        os.close(master)
        if passed:
            shutil.rmtree(home, ignore_errors=True)
            shutil.rmtree(workspace, ignore_errors=True)


def run_acp_raw_echo_case(
    label: str,
    header: str,
    plugin_paths: list[str],
    artifacts: str,
    all_steps: list[str],
    args: str,
) -> None:
    home = tempfile.mkdtemp(prefix=f"relay-skill-compact-{label}-home-")
    workspace = tempfile.mkdtemp(prefix=f"relay-skill-compact-{label}-workspace-")
    transcript: list[str] = []
    run = RelayRun(label, transcript, all_steps)
    agent_prompt_log = os.path.join(workspace, "agent-prompts.ndjson")
    relay_dir = os.path.join(home, ".config", "relay")
    os.makedirs(relay_dir, exist_ok=True)
    agent_path = os.path.join(ROOT, "test", "real-e2e", "acp-agent.ts")
    config_path = write_config(relay_dir, agent_path, plugin_paths)

    env = os.environ.copy()
    env.pop("XDG_CONFIG_HOME", None)
    env.update(
        {
            "HOME": home,
            "TERM": "xterm-256color",
            "NO_COLOR": "1",
            "RELAY_DISABLE_NOTIFICATIONS": "1",
            "RELAY_REAL_E2E_ADVERTISE_REAL_SKILL_COMMAND": "1",
            "RELAY_REAL_E2E_RAW_SKILL_ECHO": "1",
            "RELAY_REAL_E2E_PROMPT_LOG": agent_prompt_log,
        }
    )

    command = relay_command(ROOT, "real-e2e")
    master, slave = pty.openpty()
    set_pty_size(master)
    set_pty_size(slave)
    passed = False
    proc = subprocess.Popen(command, cwd=workspace, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
    os.close(slave)

    try:
        run.step("wait for Relay to connect through real CLI without local skills")
        run.wait_for(master, proc, "Connected to", 10)

        run.step("submit ACP-advertised skill command and compact the raw skill echo")
        literal_prompt = f"/real-skill {args}" if args else "/real-skill"
        submit_prompt(run, master, literal_prompt)
        screen = run.wait_for(master, proc, "ack: raw real-skill prompt received", 8)
        assert_compact_skill_screen(screen, header, args, label)
        run.step("verify ACP received the literal command, not Relay-expanded local skill content")
        prompts = read_agent_prompt_texts(agent_prompt_log)
        if prompts != [literal_prompt]:
            raise AssertionError(f"Expected literal ACP slash command for {label}, got {prompts}")
        if any('<skill name="real-skill"' in prompt or REAL_SKILL_BODY in prompt for prompt in prompts):
            raise AssertionError(f"Expected no Relay-local skill expansion for {label}, got {prompts}")
        passed = True
    finally:
        with open(os.path.join(artifacts, f"skill-compact-smoke.{label}.steps.txt"), "w", encoding="utf-8") as file:
            file.write("\n".join(step for step in all_steps if step.startswith(f"{label}:")))
        with open(os.path.join(artifacts, f"skill-compact-smoke.{label}.transcript.txt"), "w", encoding="utf-8") as file:
            file.write(run.transcript_text())
        with open(os.path.join(artifacts, f"skill-compact-smoke.{label}.screen.txt"), "w", encoding="utf-8") as file:
            file.write(run.screen.text())
        if os.path.exists(config_path):
            shutil.copyfile(config_path, os.path.join(artifacts, f"skill-compact-smoke.{label}.config.toml"))
        if os.path.exists(agent_prompt_log):
            shutil.copyfile(agent_prompt_log, os.path.join(artifacts, f"skill-compact-smoke.{label}.agent-prompts.ndjson"))
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
        with open(os.path.join(artifacts, f"skill-compact-smoke.{label}.process.txt"), "w", encoding="utf-8") as file:
            file.write(process_diagnostics(proc))
        os.close(master)
        if passed:
            shutil.rmtree(home, ignore_errors=True)
            shutil.rmtree(workspace, ignore_errors=True)


def run_malformed_raw_echo_case(artifacts: str, all_steps: list[str]) -> None:
    label = "malformed-raw-echo"
    home = tempfile.mkdtemp(prefix="relay-skill-compact-malformed-home-")
    workspace = tempfile.mkdtemp(prefix="relay-skill-compact-malformed-workspace-")
    transcript: list[str] = []
    run = RelayRun(label, transcript, all_steps)
    agent_prompt_log = os.path.join(workspace, "agent-prompts.ndjson")
    relay_dir = os.path.join(home, ".config", "relay")
    os.makedirs(relay_dir, exist_ok=True)
    agent_path = os.path.join(ROOT, "test", "real-e2e", "acp-agent.ts")
    config_path = write_config(relay_dir, agent_path, [])

    env = os.environ.copy()
    env.pop("XDG_CONFIG_HOME", None)
    env.update(
        {
            "HOME": home,
            "TERM": "xterm-256color",
            "NO_COLOR": "1",
            "RELAY_DISABLE_NOTIFICATIONS": "1",
            "RELAY_REAL_E2E_ADVERTISE_REAL_SKILL_COMMAND": "1",
            "RELAY_REAL_E2E_RAW_SKILL_ECHO": "malformed",
            "RELAY_REAL_E2E_PROMPT_LOG": agent_prompt_log,
        }
    )

    command = relay_command(ROOT, "real-e2e")
    master, slave = pty.openpty()
    set_pty_size(master)
    set_pty_size(slave)
    passed = False
    proc = subprocess.Popen(command, cwd=workspace, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
    os.close(slave)

    try:
        run.step("wait for Relay to connect through real CLI for malformed raw echo")
        run.wait_for(master, proc, "Connected to", 10)

        run.step("submit ACP slash command and compact mismatched raw skill echo defensively")
        literal_prompt = "/real-skill malformed args"
        run.send_text(master, literal_prompt)
        run.send(master, "\r")
        screen = run.wait_for(master, proc, "ack: malformed raw real-skill prompt received", 8)
        assert_compact_skill_screen(screen, "[skill] real-skill", "malformed args", label)
        for hidden in ("name: other-skill", REAL_SKILL_REGISTER_CMD, REAL_SKILL_BODY):
            if hidden in screen:
                raise AssertionError(f"Expected malformed raw echo text {hidden!r} to stay hidden. Screen:\n{screen}")

        prompts = read_agent_prompt_texts(agent_prompt_log)
        if prompts != [literal_prompt]:
            raise AssertionError(f"Expected literal ACP slash command for {label}, got {prompts}")
        passed = True
    finally:
        with open(os.path.join(artifacts, f"skill-compact-smoke.{label}.steps.txt"), "w", encoding="utf-8") as file:
            file.write("\n".join(step for step in all_steps if step.startswith(f"{label}:")))
        with open(os.path.join(artifacts, f"skill-compact-smoke.{label}.transcript.txt"), "w", encoding="utf-8") as file:
            file.write(run.transcript_text())
        with open(os.path.join(artifacts, f"skill-compact-smoke.{label}.screen.txt"), "w", encoding="utf-8") as file:
            file.write(run.screen.text())
        if os.path.exists(config_path):
            shutil.copyfile(config_path, os.path.join(artifacts, f"skill-compact-smoke.{label}.config.toml"))
        if os.path.exists(agent_prompt_log):
            shutil.copyfile(agent_prompt_log, os.path.join(artifacts, f"skill-compact-smoke.{label}.agent-prompts.ndjson"))
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
        with open(os.path.join(artifacts, f"skill-compact-smoke.{label}.process.txt"), "w", encoding="utf-8") as file:
            file.write(process_diagnostics(proc))
        os.close(master)
        if passed:
            shutil.rmtree(home, ignore_errors=True)
            shutil.rmtree(workspace, ignore_errors=True)


def main() -> int:
    artifacts = os.path.join(ROOT, "test-results", "real-e2e")
    os.makedirs(artifacts, exist_ok=True)
    all_steps: list[str] = []
    run_acp_raw_echo_case("panel", "[skill] real-skill", [], artifacts, all_steps, "panel args")
    run_acp_raw_echo_case("no-args", "[skill] real-skill", [], artifacts, all_steps, "")
    run_acp_raw_echo_case("multiline", "[skill] real-skill", [], artifacts, all_steps, "first line\n  second line")
    run_agent_command_collision_case(artifacts, all_steps)
    run_malformed_raw_echo_case(artifacts, all_steps)
    with open(os.path.join(artifacts, "skill-compact-smoke.steps.txt"), "w", encoding="utf-8") as file:
        file.write("\n".join(all_steps))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as err:
        print(f"real e2e failed: {err}", file=sys.stderr)
        raise
