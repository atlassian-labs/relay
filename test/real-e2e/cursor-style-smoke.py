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
SCREEN_COLS = 100
TRANSCRIPT = []
STEPS = []
CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
CURSOR_STYLE_RE = re.compile(r"\x1b\[(\d+) q")
OSC_RE = re.compile(r"\x1b\](.*?)(?:\x07|\x1b\\)", re.DOTALL)
DEFAULT_CURSOR_CODES = {"0"}
STEADY_LINE_CURSOR_CODES = {"6"}


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
                bell = data.find("\x07", i + 2)
                st = data.find("\x1b\\", i + 2)
                stops = [pos for pos in (bell, st) if pos != -1]
                if stops:
                    stop = min(stops)
                    i = stop + (2 if stop == st else 1)
                    continue
                self.pending_escape = data[i:]
                break
            i += 2


SCREEN = Screen()


def raw_transcript() -> str:
    return "".join(TRANSCRIPT)


def clean(text: str) -> str:
    return CONTROL_RE.sub("", text.replace("\r", "\n"))


def transcript_text() -> str:
    return clean(raw_transcript())


def step(name: str) -> None:
    STEPS.append(name)
    print(f"[real-e2e] {name}", flush=True)


def process_diagnostics(proc: subprocess.Popen) -> str:
    code = proc.poll()
    return "still running" if code is None else f"exited with code {code}"


def set_pty_size(fd: int) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", SCREEN_ROWS, SCREEN_COLS, 0, 0))


def assert_process_running(proc: subprocess.Popen) -> None:
    if proc.poll() is not None:
        raise AssertionError(f"Relay exited before expected terminal state: {process_diagnostics(proc)}")


def read_available(fd: int, timeout: float = 0.05) -> str:
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
        TRANSCRIPT.append(decoded)
        SCREEN.feed(decoded)
        chunks.append(decoded)
    return "".join(chunks)


def wait_for(fd: int, proc: subprocess.Popen, needle: str, timeout: float = 8.0) -> str:
    deadline = time.time() + timeout
    while time.time() < deadline:
        assert_process_running(proc)
        read_available(fd, 0.1)
        screen = SCREEN.text()
        if needle in screen:
            return screen
    raise AssertionError(f"Timed out waiting for {needle!r}. Screen:\n{SCREEN.text()}\n\nTranscript:\n{transcript_text()[-4000:]}")


def send(fd: int, data: str) -> None:
    os.write(fd, data.encode("utf-8"))
    read_available(fd, 0.1)


def send_text(fd: int, text: str) -> None:
    for ch in text:
        send(fd, ch)


def cursor_style_codes(text: str) -> list[str]:
    return CURSOR_STYLE_RE.findall(text)


def cursor_color_bodies(text: str) -> list[str]:
    return [match.group(1) for match in OSC_RE.finditer(text) if match.group(1).startswith("12;") or match.group(1).startswith("112")]


def assert_cursor_style_since(start: int, expected: set[str], label: str) -> None:
    delta = raw_transcript()[start:]
    found = cursor_style_codes(delta)
    if not any(code in expected for code in found):
        raise AssertionError(
            f"Expected cursor style {sorted(expected)} for {label}, saw {found}.\n"
            f"Transcript tail:\n{repr(delta[-800:])}"
        )


def assert_no_cursor_color_set_since(start: int, label: str) -> None:
    delta = raw_transcript()[start:]
    found = [body for body in cursor_color_bodies(delta) if body.startswith("12;")]
    if found:
        raise AssertionError(f"Unexpected cursor color set during {label}: {found!r}")


def assert_cursor_color_reset_since(start: int, label: str) -> None:
    delta = raw_transcript()[start:]
    found = cursor_color_bodies(delta)
    if not found or not found[-1].startswith("112"):
        raise AssertionError(f"Expected terminal cursor color reset during {label}, saw {found!r}")


def cursor_diagnostics() -> str:
    lines = SCREEN.text().splitlines()
    current_line = lines[SCREEN.row] if 0 <= SCREEN.row < len(lines) else ""
    return f"cursor row={SCREEN.row + 1} col={SCREEN.col + 1} line={current_line!r}"


def assert_prompt_cursor_position(label: str, typed_text: str = "") -> None:
    screen = SCREEN.text()
    lines = screen.splitlines()
    prompt_rows = [index for index, line in enumerate(lines) if line.strip().startswith((">", "!"))]
    if not prompt_rows:
        raise AssertionError(f"Could not find Relay prompt row during {label}.\nScreen:\n{screen}")

    prompt_row = prompt_rows[-1]
    if SCREEN.row != prompt_row:
        raise AssertionError(
            f"Expected cursor on prompt row during {label}, but {cursor_diagnostics()}. "
            f"Prompt row={prompt_row + 1} line={lines[prompt_row]!r}.\n"
            f"Screen:\n{screen}\n\nTranscript tail:\n{repr(raw_transcript()[-1200:])}"
        )
    if SCREEN.row == 0:
        raise AssertionError(
            f"Cursor snapped to the top terminal row during {label}: {cursor_diagnostics()}.\n"
            f"Screen:\n{screen}\n\nTranscript tail:\n{repr(raw_transcript()[-1200:])}"
        )

    if typed_text:
        prompt_line = lines[prompt_row]
        text_col = prompt_line.find(typed_text)
        if text_col == -1:
            raise AssertionError(
                f"Expected typed text {typed_text!r} on prompt row during {label}, but it was missing.\n"
                f"{cursor_diagnostics()}\nScreen:\n{screen}"
            )
        expected_min_col = text_col + len(typed_text)
        if SCREEN.col < expected_min_col:
            raise AssertionError(
                f"Expected cursor after typed text {typed_text!r} during {label}, but {cursor_diagnostics()}. "
                f"Typed text ends at col {expected_min_col + 1}.\nScreen:\n{screen}"
            )


def wait_for_prompt_cursor_position(
    fd: int,
    proc: subprocess.Popen,
    label: str,
    typed_text: str = "",
    timeout: float = 3.0,
) -> None:
    deadline = time.monotonic() + timeout
    last_error: AssertionError | None = None
    while time.monotonic() < deadline:
        assert_process_running(proc)
        read_available(fd, min(0.1, max(0.0, deadline - time.monotonic())))
        try:
            assert_prompt_cursor_position(label, typed_text)
            return
        except AssertionError as error:
            last_error = error

    if last_error is not None:
        raise AssertionError(f"Timed out waiting for the prompt cursor during {label}.\n{last_error}") from last_error
    raise AssertionError(f"Timed out waiting for the prompt cursor during {label}")


def write_cursor_artifact(artifacts: str, name: str) -> None:
    with open(os.path.join(artifacts, name), "w", encoding="utf-8") as file:
        file.write(f"{cursor_diagnostics()}\n")


def write_cursor_plugin(relay_dir: str, *, cursor_color: str | None, status: str, clear_command: bool = False) -> None:
    plugin_dir = os.path.join(relay_dir, "plugins", "cursor-color")
    os.makedirs(plugin_dir, exist_ok=True)
    with open(os.path.join(plugin_dir, "package.json"), "w", encoding="utf-8") as file:
        json.dump(
            {
                "name": "relay-plugin-cursor-color-smoke",
                "type": "module",
                "relay": {"plugin": "index.mjs"},
            },
            file,
        )
    with open(os.path.join(plugin_dir, "index.mjs"), "w", encoding="utf-8") as file:
        file.write("export default function cursorColorSmoke(relay) {\n")
        if cursor_color is not None:
            file.write(f"  relay.editor.setTheme({{ cursorColor: '{cursor_color}' }});\n")
        if clear_command:
            file.write(
                "  relay.commands.register('cursor-clear', {\n"
                "    description: 'clear cursor color smoke override',\n"
                "    run() {\n"
                "      relay.editor.setTheme({ cursorColor: undefined });\n"
                "      relay.ui.setEditorStatus('cursor-color-smoke', 'cursor-plugin-cleared');\n"
                "    },\n"
                "  });\n"
            )
        file.write(f"  relay.ui.setEditorStatus('cursor-color-smoke', '{status}');\n")
        file.write("}\n")


def write_config(home: str, workspace: str, *, vim: bool, plugins: bool) -> str:
    relay_dir = os.path.join(home, ".config", "relay")
    os.makedirs(relay_dir, exist_ok=True)
    agent_path = os.path.join(ROOT, "test", "real-e2e", "acp-agent.ts")
    config_path = os.path.join(relay_dir, "config.toml")
    with open(config_path, "w", encoding="utf-8") as file:
        file.write(
            "[ui]\n"
            f"vim_keybindings = {str(vim).lower()}\n"
            "show_tips = false\n\n"
            "[plugins]\n"
            f"enabled = {str(plugins).lower()}\n"
            "allow_project_plugins = false\n\n"
            "[agents]\n"
            'default = "real-e2e"\n\n'
            "[agents.runners.real-e2e]\n"
            'command = "bun"\n'
            f'args = ["run", "{agent_path}"]\n'
            'profile = "default"\n'
        )
    if plugins:
        write_cursor_plugin(relay_dir, cursor_color="#40c4ff", status="cursor-plugin-loaded")
    return config_path


def start_relay(home: str, workspace: str) -> tuple[int, subprocess.Popen]:
    env = os.environ.copy()
    env.pop("XDG_CONFIG_HOME", None)
    env.update({
        "HOME": home,
        "TERM": "xterm-256color",
        "RELAY_DISABLE_NOTIFICATIONS": "1",
    })
    master, slave = pty.openpty()
    set_pty_size(master)
    set_pty_size(slave)
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
    return master, proc


def stop_relay(master: int, proc: subprocess.Popen) -> None:
    try:
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
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                pass
    finally:
        try:
            os.close(master)
        except OSError:
            pass


def reset_terminal_capture() -> None:
    TRANSCRIPT.clear()
    SCREEN.clear()
    SCREEN.pending_escape = ""


def run_default_cursor_session(artifacts: str) -> None:
    reset_terminal_capture()
    home = tempfile.mkdtemp(prefix="relay-cursor-default-home-")
    workspace = tempfile.mkdtemp(prefix="relay-cursor-default-workspace-")
    config_path = write_config(home, workspace, vim=True, plugins=False)
    master, proc = start_relay(home, workspace)
    passed = False
    try:
        step("default session: wait for Relay and Vim insert prompt")
        wait_for(master, proc, "Connected to", 10)
        wait_for(master, proc, "-- INSERT --", 5)
        wait_for_prompt_cursor_position(master, proc, "default startup")
        assert_cursor_style_since(0, STEADY_LINE_CURSOR_CODES, "Vim insert prompt")
        assert_cursor_color_reset_since(0, "default startup")

        step("default session: Escape switches Vim insert cursor back to terminal default")
        before = len(raw_transcript())
        send(master, "\x1b")
        wait_for(master, proc, "-- NORMAL --", 3)
        wait_for_prompt_cursor_position(master, proc, "Vim normal prompt")
        assert_cursor_style_since(before, DEFAULT_CURSOR_CODES, "Vim normal prompt")
        assert_no_cursor_color_set_since(before, "Vim normal prompt")

        step("default session: i switches back to steady line insert cursor")
        before = len(raw_transcript())
        send(master, "i")
        wait_for(master, proc, "-- INSERT --", 3)
        wait_for_prompt_cursor_position(master, proc, "return to Vim insert prompt")
        assert_cursor_style_since(before, STEADY_LINE_CURSOR_CODES, "return to Vim insert prompt")
        assert_no_cursor_color_set_since(before, "return to Vim insert prompt")

        step("default session: user-bash mode keeps cursor on typed prompt and does not set terminal cursor color")
        before = len(raw_transcript())
        send_text(master, "!!")
        wait_for(master, proc, "!!", 3)
        wait_for_prompt_cursor_position(master, proc, "user bash prompt styling", "!!")
        assert_no_cursor_color_set_since(before, "user bash prompt styling")
        passed = True
    finally:
        with open(os.path.join(artifacts, "cursor-style-default.transcript.raw.txt"), "w", encoding="utf-8") as file:
            file.write(raw_transcript())
        with open(os.path.join(artifacts, "cursor-style-default.screen.txt"), "w", encoding="utf-8") as file:
            file.write(SCREEN.text())
        write_cursor_artifact(artifacts, "cursor-style-default.cursor.txt")
        shutil.copyfile(config_path, os.path.join(artifacts, "cursor-style-default-config.toml"))
        stop_relay(master, proc)
        with open(os.path.join(artifacts, "cursor-style-default.process.txt"), "w", encoding="utf-8") as file:
            file.write(process_diagnostics(proc))
        if passed:
            shutil.rmtree(home, ignore_errors=True)
            shutil.rmtree(workspace, ignore_errors=True)


def run_plugin_cursor_session(artifacts: str) -> None:
    reset_terminal_capture()
    home = tempfile.mkdtemp(prefix="relay-cursor-plugin-home-")
    workspace = tempfile.mkdtemp(prefix="relay-cursor-plugin-workspace-")
    config_path = write_config(home, workspace, vim=False, plugins=True)
    master, proc = start_relay(home, workspace)
    passed = False
    try:
        step("plugin session: wait for user-installed plugin status")
        wait_for(master, proc, "Connected to", 10)
        wait_for(master, proc, "cursor-plugin-loaded", 8)
        found = cursor_color_bodies(raw_transcript())
        if "12;#40c4ff" not in [body.lower() for body in found]:
            raise AssertionError(
                f"Expected plugin cursor color escape for #40c4ff, saw {found!r}. "
                f"Transcript tail:\n{repr(raw_transcript()[-1200:])}"
            )
        passed = True
    finally:
        with open(os.path.join(artifacts, "cursor-style-plugin.transcript.raw.txt"), "w", encoding="utf-8") as file:
            file.write(raw_transcript())
        with open(os.path.join(artifacts, "cursor-style-plugin.screen.txt"), "w", encoding="utf-8") as file:
            file.write(SCREEN.text())
        shutil.copyfile(config_path, os.path.join(artifacts, "cursor-style-plugin-config.toml"))
        stop_relay(master, proc)
        with open(os.path.join(artifacts, "cursor-style-plugin.process.txt"), "w", encoding="utf-8") as file:
            file.write(process_diagnostics(proc))
        if passed:
            shutil.rmtree(home, ignore_errors=True)
            shutil.rmtree(workspace, ignore_errors=True)


def run_plugin_cursor_reload_session(artifacts: str) -> None:
    reset_terminal_capture()
    home = tempfile.mkdtemp(prefix="relay-cursor-plugin-reload-home-")
    workspace = tempfile.mkdtemp(prefix="relay-cursor-plugin-reload-workspace-")
    config_path = write_config(home, workspace, vim=False, plugins=True)
    relay_dir = os.path.join(home, ".config", "relay")
    master, proc = start_relay(home, workspace)
    passed = False
    try:
        step("plugin reload session: wait for user-installed plugin cursor color")
        wait_for(master, proc, "Connected to", 10)
        wait_for(master, proc, "cursor-plugin-loaded", 8)
        found = cursor_color_bodies(raw_transcript())
        if "12;#40c4ff" not in [body.lower() for body in found]:
            raise AssertionError(
                f"Expected plugin cursor color escape for #40c4ff before reload, saw {found!r}. "
                f"Transcript tail:\n{repr(raw_transcript()[-1200:])}"
            )

        step("plugin reload session: /reload removes deleted cursor color plugin")
        shutil.rmtree(os.path.join(relay_dir, "plugins", "cursor-color"))
        before_reload = len(raw_transcript())
        send_text(master, "/reload")
        send(master, "\r")
        wait_for(master, proc, "Reloaded Relay plugins", 8)
        assert_cursor_color_reset_since(before_reload, "plugin reload after deleting cursor color plugin")
        assert_no_cursor_color_set_since(before_reload, "plugin reload after deleting cursor color plugin")

        step("plugin reload session: user-bash styling stays terminal-owned after reload")
        before_user_bash = len(raw_transcript())
        send_text(master, "!!")
        wait_for(master, proc, "!!", 3)
        assert_no_cursor_color_set_since(before_user_bash, "user bash after plugin cursor removal")
        passed = True
    finally:
        with open(os.path.join(artifacts, "cursor-style-plugin-reload.transcript.raw.txt"), "w", encoding="utf-8") as file:
            file.write(raw_transcript())
        with open(os.path.join(artifacts, "cursor-style-plugin-reload.screen.txt"), "w", encoding="utf-8") as file:
            file.write(SCREEN.text())
        shutil.copyfile(config_path, os.path.join(artifacts, "cursor-style-plugin-reload-config.toml"))
        stop_relay(master, proc)
        with open(os.path.join(artifacts, "cursor-style-plugin-reload.process.txt"), "w", encoding="utf-8") as file:
            file.write(process_diagnostics(proc))
        if passed:
            shutil.rmtree(home, ignore_errors=True)
            shutil.rmtree(workspace, ignore_errors=True)


def run_plugin_cursor_clear_command_session(artifacts: str) -> None:
    reset_terminal_capture()
    home = tempfile.mkdtemp(prefix="relay-cursor-plugin-clear-home-")
    workspace = tempfile.mkdtemp(prefix="relay-cursor-plugin-clear-workspace-")
    relay_dir = os.path.join(home, ".config", "relay")
    config_path = write_config(home, workspace, vim=False, plugins=True)
    write_cursor_plugin(relay_dir, cursor_color="#40c4ff", status="cursor-plugin-loaded", clear_command=True)
    master, proc = start_relay(home, workspace)
    passed = False
    try:
        step("plugin clear command session: wait for user-installed plugin cursor color")
        wait_for(master, proc, "Connected to", 10)
        wait_for(master, proc, "cursor-plugin-loaded", 8)
        found = cursor_color_bodies(raw_transcript())
        if "12;#40c4ff" not in [body.lower() for body in found]:
            raise AssertionError(
                f"Expected plugin cursor color escape for #40c4ff before clear command, saw {found!r}. "
                f"Transcript tail:\n{repr(raw_transcript()[-1200:])}"
            )

        step("plugin clear command session: plugin command returns cursor color to terminal")
        before_clear = len(raw_transcript())
        send_text(master, "/cursor-clear")
        send(master, "\r")
        wait_for(master, proc, "cursor-plugin-cleared", 8)
        assert_cursor_color_reset_since(before_clear, "plugin cursor clear command")
        assert_no_cursor_color_set_since(before_clear, "plugin cursor clear command")

        step("plugin clear command session: user-bash styling stays terminal-owned after clear")
        before_user_bash = len(raw_transcript())
        send_text(master, "!!")
        wait_for(master, proc, "!!", 3)
        assert_no_cursor_color_set_since(before_user_bash, "user bash after plugin cursor clear")
        passed = True
    finally:
        with open(os.path.join(artifacts, "cursor-style-plugin-clear.transcript.raw.txt"), "w", encoding="utf-8") as file:
            file.write(raw_transcript())
        with open(os.path.join(artifacts, "cursor-style-plugin-clear.screen.txt"), "w", encoding="utf-8") as file:
            file.write(SCREEN.text())
        shutil.copyfile(config_path, os.path.join(artifacts, "cursor-style-plugin-clear-config.toml"))
        stop_relay(master, proc)
        with open(os.path.join(artifacts, "cursor-style-plugin-clear.process.txt"), "w", encoding="utf-8") as file:
            file.write(process_diagnostics(proc))
        if passed:
            shutil.rmtree(home, ignore_errors=True)
            shutil.rmtree(workspace, ignore_errors=True)


def main() -> int:
    artifacts = os.path.join(ROOT, "test-results", "real-e2e")
    os.makedirs(artifacts, exist_ok=True)
    try:
        run_default_cursor_session(artifacts)
        run_plugin_cursor_session(artifacts)
        run_plugin_cursor_reload_session(artifacts)
        run_plugin_cursor_clear_command_session(artifacts)
        return 0
    finally:
        with open(os.path.join(artifacts, "cursor-style-smoke.steps.txt"), "w", encoding="utf-8") as file:
            file.write("\n".join(STEPS))


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as err:
        print(f"real e2e failed: {err}", file=sys.stderr)
        raise
