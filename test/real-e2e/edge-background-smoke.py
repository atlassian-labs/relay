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
ARTIFACTS = os.path.join(ROOT, "test-results", "real-e2e")
SCREEN_ROWS = 34
SCREEN_COLS = 100
EDGE_SAMPLE_COLUMNS = (0, -1)
CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


class Cell:
    def __init__(self) -> None:
        self.char = " "
        self.bg: tuple[int, int, int] | None = None


class Screen:
    def __init__(self, rows: int = SCREEN_ROWS, cols: int = SCREEN_COLS) -> None:
        self.rows = rows
        self.cols = cols
        self.row = 0
        self.col = 0
        self.bg: tuple[int, int, int] | None = None
        self.grid = [[Cell() for _ in range(cols)] for _ in range(rows)]
        self.pending_escape = ""

    def resize(self, rows: int, cols: int) -> None:
        self.rows = rows
        self.cols = cols
        self.row = 0
        self.col = 0
        self.bg = None
        self.grid = [[Cell() for _ in range(cols)] for _ in range(rows)]
        self.pending_escape = ""

    def text(self) -> str:
        return "\n".join("".join(cell.char for cell in row).rstrip() for row in self.grid)

    def clear(self) -> None:
        self.grid = [[Cell() for _ in range(self.cols)] for _ in range(self.rows)]
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
            cell = self.grid[self.row][self.col]
            cell.char = ch
            cell.bg = self.bg
        self.col += 1
        if self.col >= self.cols:
            self.col = 0
            self.row = min(self.rows - 1, self.row + 1)

    def erase_row(self, start: int, end: int) -> None:
        for col in range(max(0, start), min(self.cols, end)):
            cell = self.grid[self.row][col]
            cell.char = " "
            cell.bg = self.bg

    def sgr(self, params: str) -> None:
        values = [int(part) if part.isdigit() else 0 for part in params.split(";") if part != ""]
        if not values:
            values = [0]
        index = 0
        while index < len(values):
            value = values[index]
            if value == 0:
                self.bg = None
                index += 1
            elif value == 49:
                self.bg = None
                index += 1
            elif value == 48 and index + 4 < len(values) and values[index + 1] == 2:
                self.bg = (values[index + 2], values[index + 3], values[index + 4])
                index += 5
            elif value in (38, 58) and index + 4 < len(values) and values[index + 1] == 2:
                index += 5
            else:
                index += 1

    def csi(self, params: str, final: str) -> None:
        clean_params = params.replace("?", "").replace(">", "")
        values = [int(part) if part.isdigit() else 0 for part in clean_params.split(";") if part != ""]
        if final in ("H", "f"):
            self.row = max(0, min(self.rows - 1, (values[0] if len(values) > 0 and values[0] else 1) - 1))
            self.col = max(0, min(self.cols - 1, (values[1] if len(values) > 1 and values[1] else 1) - 1))
        elif final == "J" and (not values or values[0] in (0, 2, 3)):
            self.clear()
        elif final == "K":
            mode = values[0] if values else 0
            start = 0 if mode == 1 else self.col
            end = self.cols if mode in (0, 2) else self.col + 1
            self.erase_row(start, end)
        elif final == "A":
            self.row = max(0, self.row - (values[0] if values and values[0] else 1))
        elif final == "B":
            self.row = min(self.rows - 1, self.row + (values[0] if values and values[0] else 1))
        elif final == "C":
            self.col = min(self.cols - 1, self.col + (values[0] if values and values[0] else 1))
        elif final == "D":
            self.col = max(0, self.col - (values[0] if values and values[0] else 1))
        elif final == "m":
            self.sgr(params)

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
                else:
                    self.pending_escape = data[i:]
                    break
            elif kind == "]":
                bel = data.find("\x07", i + 2)
                st = data.find("\x1b\\", i + 2)
                stops = [pos for pos in (bel, st) if pos != -1]
                if stops:
                    stop = min(stops)
                    i = stop + (2 if stop == st else 1)
                else:
                    self.pending_escape = data[i:]
                    break
            elif kind == "P":
                st = data.find("\x1b\\", i + 2)
                if st >= 0:
                    i = st + 2
                else:
                    self.pending_escape = data[i:]
                    break
            else:
                i += 2

    def sampled_cell_failures(self) -> list[dict[str, object]]:
        failures: list[dict[str, object]] = []
        for row_index, row in enumerate(self.grid):
            for raw_col in EDGE_SAMPLE_COLUMNS:
                col = self.cols + raw_col if raw_col < 0 else raw_col
                cell = row[col]
                if cell.char != " ":
                    failures.append({"row": row_index, "col": col, "char": cell.char, "bg": cell.bg})
        return failures


SCREEN = Screen()
TRANSCRIPT: list[str] = []
STEPS: list[str] = []


def transcript_text() -> str:
    text = "".join(TRANSCRIPT).replace("\r", "\n")
    return CONTROL_RE.sub("", text)


def step(name: str) -> None:
    STEPS.append(name)
    print(f"[real-e2e] {name}", flush=True)


def process_diagnostics(proc: subprocess.Popen) -> str:
    code = proc.poll()
    return "still running" if code is None else f"exited with code {code}"


def set_pty_size(fd: int, rows: int = SCREEN_ROWS, cols: int = SCREEN_COLS) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def resize_terminal(fd: int, proc: subprocess.Popen, rows: int, cols: int) -> None:
    set_pty_size(fd, rows, cols)
    SCREEN.resize(rows, cols)
    try:
        os.killpg(proc.pid, signal.SIGWINCH)
    except ProcessLookupError:
        pass
    read_available(fd, 0.5)


def assert_process_running(proc: subprocess.Popen) -> None:
    if proc.poll() is not None:
        raise AssertionError(f"Relay exited before the expected terminal state: {process_diagnostics(proc)}")


def read_available(fd: int, timeout: float = 0.05) -> str:
    chunks: list[str] = []
    deadline = time.time() + timeout
    while time.time() < deadline:
        ready, _, _ = select.select([fd], [], [], max(0, deadline - time.time()))
        if not ready:
            break
        try:
            data = os.read(fd, 16384)
        except OSError:
            break
        if not data:
            break
        decoded = data.decode("utf-8", "replace")
        TRANSCRIPT.append(decoded)
        SCREEN.feed(decoded)
        chunks.append(decoded)
        deadline = time.time() + 0.02
    return "".join(chunks)


def wait_for(fd: int, proc: subprocess.Popen, needle: str, timeout: float = 8.0) -> str:
    deadline = time.time() + timeout
    while time.time() < deadline:
        assert_process_running(proc)
        read_available(fd, 0.1)
        screen = SCREEN.text()
        if needle in screen:
            return screen
    raise AssertionError(f"Timed out waiting for {needle!r}. Screen:\n{SCREEN.text()}\n\nTranscript:\n{transcript_text()[-6000:]}")


def wait_for_absent(fd: int, proc: subprocess.Popen, needle: str, timeout: float = 1.0) -> str:
    deadline = time.time() + timeout
    last_screen = SCREEN.text()
    while time.time() < deadline:
        assert_process_running(proc)
        read_available(fd, 0.1)
        last_screen = SCREEN.text()
        if needle in last_screen:
            raise AssertionError(f"Unexpected {needle!r} on current terminal screen:\n{last_screen}")
    return last_screen


def send(fd: int, data: str) -> None:
    os.write(fd, data.encode("utf-8"))
    read_available(fd, 0.1)


def send_text(fd: int, text: str) -> None:
    for ch in text:
        send(fd, ch)


def sampled_cell_failures() -> list[dict[str, object]]:
    return SCREEN.sampled_cell_failures()


def assert_sampled_cells_blank(label: str) -> None:
    failures = sampled_cell_failures()
    if failures:
        raise AssertionError(
            f"Expected blank sampled terminal cells after {label}; found stale cells: "
            f"{failures[:12]}\nScreen:\n{SCREEN.text()}"
        )


def write_config(config_path: str, agent_path: str) -> None:
    with open(config_path, "w", encoding="utf-8") as file:
        file.write(
            '[ui]\n'
            'theme = "github-dark"\n'
            'show_tips = false\n\n'
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


def main() -> int:
    os.makedirs(ARTIFACTS, exist_ok=True)
    home = tempfile.mkdtemp(prefix="relay-edge-background-home-")
    workspace = tempfile.mkdtemp(prefix="relay-edge-background-workspace-")
    agent_events = os.path.join(workspace, "agent-events.ndjson")

    env = os.environ.copy()
    env.pop("XDG_CONFIG_HOME", None)
    env.update({
        "HOME": home,
        "TERM": "xterm-256color",
        "NO_COLOR": "1",
        "RELAY_DISABLE_NOTIFICATIONS": "1",
        "RELAY_REAL_E2E_PROMPT_LOG": agent_events,
    })

    relay_dir = os.path.join(home, ".config", "relay")
    os.makedirs(relay_dir, exist_ok=True)
    agent_path = os.path.join(ROOT, "test", "real-e2e", "acp-agent.ts")
    config_path = os.path.join(relay_dir, "config.toml")
    write_config(config_path, agent_path)

    command = relay_command(ROOT, "real-e2e")
    master, slave = pty.openpty()
    set_pty_size(master)
    set_pty_size(slave)
    passed = False
    proc = subprocess.Popen(command, cwd=workspace, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
    os.close(slave)

    evidence: dict[str, object] = {}
    try:
        step("wait for Relay to connect through the real PTY boundary")
        wait_for(master, proc, "Connected to", 10)
        assert_sampled_cells_blank("initial connected frame")

        step("open and close the expanded thread sidebar to remove edge-adjacent chrome")
        send(master, "\x07")
        wait_for(master, proc, "Agents", 5)
        send(master, "\x03")
        wait_for(master, proc, "Threads", 5)
        send(master, "\x02")
        wait_for_absent(master, proc, "Threads", 2)
        assert_sampled_cells_blank("sidebar close")

        step("stream an ACP burst while resizing the real terminal")
        send_text(master, "real tui stress burst e2e")
        send(master, "\r")
        wait_for(master, proc, "STRESS-FIRST-START", 8)
        resize_terminal(master, proc, 28, 84)
        resize_terminal(master, proc, SCREEN_ROWS, SCREEN_COLS)
        wait_for(master, proc, "STRESS-FIRST-END", 20)
        read_available(master, 0.5)
        assert_sampled_cells_blank("streaming resize completion")

        evidence = {
            "rows": SCREEN.rows,
            "cols": SCREEN.cols,
            "sampleColumns": [0, SCREEN.cols - 1],
            "sampledCellFailures": [],
            "rawBytes": sum(len(chunk.encode("utf-8")) for chunk in TRANSCRIPT),
            "steps": STEPS,
        }
        passed = True
        print("[edge-background-smoke] sampled terminal cells stayed blank", flush=True)
        return 0
    finally:
        with open(os.path.join(ARTIFACTS, "edge-background-smoke.steps.txt"), "w", encoding="utf-8") as file:
            file.write("\n".join(STEPS))
        with open(os.path.join(ARTIFACTS, "edge-background-smoke.raw.ansi"), "w", encoding="utf-8") as file:
            file.write("".join(TRANSCRIPT))
        with open(os.path.join(ARTIFACTS, "edge-background-smoke.screen.txt"), "w", encoding="utf-8") as file:
            file.write(SCREEN.text())
        if not evidence:
            evidence = {
                "rows": SCREEN.rows,
                "cols": SCREEN.cols,
                "sampleColumns": [0, SCREEN.cols - 1],
                "sampledCellFailures": sampled_cell_failures(),
                "rawBytes": sum(len(chunk.encode("utf-8")) for chunk in TRANSCRIPT),
                "steps": STEPS,
            }
        with open(os.path.join(ARTIFACTS, "edge-background-smoke.evidence.json"), "w", encoding="utf-8") as file:
            json.dump(evidence, file, indent=2)
        if os.path.exists(config_path):
            shutil.copyfile(config_path, os.path.join(ARTIFACTS, "edge-background-smoke.config.toml"))
        if os.path.exists(agent_events):
            shutil.copyfile(agent_events, os.path.join(ARTIFACTS, "edge-background-smoke.agent-events.ndjson"))
        cleanup_notes: list[str] = []
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
        with open(os.path.join(ARTIFACTS, "edge-background-smoke.process.txt"), "w", encoding="utf-8") as file:
            file.write(process_diagnostics(proc))
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
        with open(os.path.join(ARTIFACTS, "edge-background-smoke.cleanup.txt"), "w", encoding="utf-8") as file:
            file.write("\n".join(cleanup_notes) + "\n")


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as err:
        print(f"edge background real e2e failed: {err}", file=sys.stderr)
        raise
