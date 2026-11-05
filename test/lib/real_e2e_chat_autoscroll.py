import fcntl
import json
import os
import re
import select
import signal
import struct
import termios
import time
from typing import Any

ANSI_RE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
SCROLL_MARKER_RE = re.compile(r"SCROLL-(?:FIRST|SECOND|THIRD|FOURTH)-\d{2}")


class Screen:
    def __init__(self, rows: int = 30, cols: int = 120):
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
            else:
                i += 2


class ChatAutoscrollPtyHarness:
    def __init__(self, rows: int = 30, cols: int = 120):
        self.default_rows = rows
        self.default_cols = cols
        self.screen = Screen(rows, cols)
        self.transcript: list[str] = []
        self.steps: list[str] = []

    def screen_text(self) -> str:
        return self.screen.text()

    def transcript_text(self) -> str:
        text = ANSI_RE.sub("", "".join(self.transcript))
        text = text.replace("\r", "\n")
        return CONTROL_RE.sub("", text)

    def step(self, name: str) -> None:
        self.steps.append(name)
        print(f"[real-e2e] {name}", flush=True)

    def set_pty_size(self, fd: int, rows: int | None = None, cols: int | None = None) -> None:
        rows = self.default_rows if rows is None else rows
        cols = self.default_cols if cols is None else cols
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        self.screen = Screen(rows, cols)

    def assert_process_running(self, proc: Any) -> None:
        status = proc.poll()
        if status is not None:
            raise AssertionError(f"Relay exited early with status {status}. Transcript:\n{self.transcript_text()}")

    def read_available(self, fd: int, timeout: float = 0.05) -> str:
        chunks: list[str] = []
        end = time.time() + timeout
        while True:
            remaining = max(0.0, end - time.time())
            ready, _, _ = select.select([fd], [], [], remaining)
            if not ready:
                break
            try:
                data = os.read(fd, 4096)
            except OSError:
                break
            if not data:
                break
            text = data.decode("utf-8", errors="replace")
            chunks.append(text)
            self.transcript.append(text)
            self.screen.feed(text)
            end = time.time() + 0.02
        return "".join(chunks)

    def wait_for(self, fd: int, proc: Any, needle: str, timeout: float = 5.0) -> str:
        deadline = time.time() + timeout
        while time.time() < deadline:
            self.assert_process_running(proc)
            self.read_available(fd, 0.1)
            screen = self.screen_text()
            if needle in screen:
                return screen
        raise AssertionError(f"Timed out waiting for {needle!r}. Screen:\n{self.screen_text()}\nTranscript:\n{self.transcript_text()}")

    def wait_for_absent(self, fd: int, proc: Any, needle: str, duration: float = 1.0) -> str:
        deadline = time.time() + duration
        last_screen = self.screen_text()
        while time.time() < deadline:
            self.assert_process_running(proc)
            self.read_available(fd, 0.1)
            last_screen = self.screen_text()
            if needle in last_screen:
                raise AssertionError(f"Expected {needle!r} to remain absent. Screen:\n{last_screen}")
        return last_screen

    def read_agent_events(self, path: str) -> list[dict[str, Any]]:
        if not os.path.exists(path):
            return []
        events = []
        with open(path, "r", encoding="utf-8") as file:
            for line in file:
                line = line.strip()
                if not line:
                    continue
                try:
                    events.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
        return events

    def wait_for_agent_event(self, path: str, event: str, prefix: str, timeout: float = 5.0) -> dict[str, Any]:
        deadline = time.time() + timeout
        while time.time() < deadline:
            for entry in self.read_agent_events(path):
                if entry.get("event") == event and entry.get("prefix") == prefix:
                    return entry
            time.sleep(0.05)
        raise AssertionError(f"Timed out waiting for agent event {event!r} with prefix {prefix!r}: {self.read_agent_events(path)}")

    def resize_terminal(self, fd: int, proc: Any, rows: int, cols: int) -> None:
        self.set_pty_size(fd, rows, cols)
        try:
            os.killpg(proc.pid, signal.SIGWINCH)
        except ProcessLookupError:
            pass
        self.read_available(fd, 0.5)

    def send(self, fd: int, text: str) -> None:
        os.write(fd, text.encode("utf-8"))
        self.read_available(fd, 0.1)

    def mouse_scroll_sequence(self, x: int, y: int, direction: str) -> str:
        buttons = {"up": 64, "down": 65}
        if direction not in buttons:
            raise ValueError(f"Unsupported scroll direction: {direction}")
        return f"\x1b[<{buttons[direction]};{x + 1};{y + 1}M"

    def send_mouse_scroll(self, fd: int, x: int, y: int, direction: str) -> None:
        self.send(fd, self.mouse_scroll_sequence(x, y, direction))

    def send_mouse_scroll_burst(self, fd: int, x: int, y: int, direction: str, count: int) -> None:
        os.write(fd, (self.mouse_scroll_sequence(x, y, direction) * count).encode("utf-8"))
        self.read_available(fd, 0.2)

    def send_text(self, fd: int, text: str) -> None:
        for ch in text:
            self.send(fd, ch)

    def press_home(self, fd: int) -> None:
        self.send(fd, "\x1b[H")

    def send_multiline_draft(self, fd: int, lines: int) -> None:
        chunks = []
        for index in range(lines):
            chunks.append(f"scrollable draft line {index:02d}")
            if index < lines - 1:
                chunks.append("\x1b[13;2u")
        os.write(fd, "".join(chunks).encode("utf-8"))
        self.read_available(fd, 1.0)

    def process_diagnostics(self, proc: Any) -> str:
        status = proc.poll()
        return "\n".join(
            [
                f"pid={proc.pid}",
                f"returncode={status}",
                f"steps={self.steps}",
            ]
        )


def visible_scroll_marker(screen: str) -> str:
    matches = SCROLL_MARKER_RE.findall(screen)
    if not matches:
        raise AssertionError(f"Expected a visible scroll marker before prompt-owned wheel probe. Screen:\n{screen}")
    return matches[-1]


def screen_position_containing(screen: str, needle: str) -> tuple[int, int]:
    for row, line in enumerate(screen.splitlines()):
        col = line.find(needle)
        if col >= 0:
            return col, row
    raise AssertionError(f"Could not find {needle!r} on screen. Screen:\n{screen}")


def prompt_marker_row(screen: str) -> int:
    lines = screen.splitlines()
    for index, line in enumerate(lines):
        if "│  >" in line or line.strip().startswith((">", "!")):
            return index
    raise AssertionError(f"Could not find prompt marker row. Screen:\n{screen}")


def run_chat_autoscroll_probe(harness: ChatAutoscrollPtyHarness, master: int, proc: Any, agent_log: str) -> None:
    harness.step("resize to a compact terminal for scroll ownership probes")
    harness.resize_terminal(master, proc, 20, 80)

    harness.step("submit long ACP output and verify the chat log reaches the bottom")
    harness.send_text(master, "real scroll first")
    harness.send(master, "\r")
    harness.wait_for(master, proc, "SCROLL-FIRST-69", 8)

    harness.step("wheel down at the bottom and verify the next ACP output still auto-scrolls")
    harness.send_mouse_scroll(master, 20, 5, "down")
    harness.read_available(master, 0.3)
    harness.send_text(master, "real scroll second")
    harness.send(master, "\r")
    screen = harness.wait_for(master, proc, "SCROLL-SECOND-69", 8)
    if "SCROLL-FIRST-69" in screen:
        raise AssertionError(f"Expected second long output to replace the previous bottom marker. Screen:\n{screen}")

    harness.step("wheel up away from the bottom and verify later ACP output does not snap down")
    harness.send_mouse_scroll_burst(master, 20, 5, "up", 8)
    screen = harness.wait_for(master, proc, "SCROLL-SECOND-", 3)
    if "SCROLL-SECOND-69" in screen:
        raise AssertionError(f"Expected wheel-up to move away from the bottom marker. Screen:\n{screen}")
    harness.send_text(master, "real scroll third")
    harness.send(master, "\r")
    harness.wait_for_agent_event(agent_log, "long-scroll-response", "SCROLL-THIRD", 5)
    screen = harness.wait_for_absent(master, proc, "SCROLL-THIRD-69", 1.5)
    if "SCROLL-SECOND-" not in screen:
        raise AssertionError(f"Expected manual scroll position to stay on prior output. Screen:\n{screen}")

    harness.step("partial wheel down over the prompt row does not re-engage auto-scroll")
    row = prompt_marker_row(harness.screen_text())
    harness.send_mouse_scroll_burst(master, 20, row, "down", 4)
    screen = harness.wait_for_absent(master, proc, "SCROLL-THIRD-69", 1.5)
    if "SCROLL-SECOND-" not in screen:
        raise AssertionError(f"Expected partial prompt-row scroll to keep the manual viewport on prior output. Screen:\n{screen}")

    harness.step("multiline prompt wheel gestures are consumed before chat scrolls")
    harness.send_multiline_draft(master, 40)
    harness.press_home(master)
    harness.read_available(master, 0.5)
    screen = harness.wait_for_absent(master, proc, "SCROLL-THIRD-69", 1.0)
    prompt_owned_marker = visible_scroll_marker(screen)
    prompt_x, row = screen_position_containing(screen, "scrollable draft line")
    harness.send_mouse_scroll_burst(master, prompt_x, row, "down", 20)
    screen = harness.wait_for_absent(master, proc, "SCROLL-THIRD-69", 1.5)
    if prompt_owned_marker not in screen:
        raise AssertionError(
            "Expected prompt-owned wheel gestures to leave the visible chat marker stationary. "
            f"Marker={prompt_owned_marker}\nScreen:\n{screen}"
        )
    if "scrollable draft line 00" in screen or "scrollable draft line 20" not in screen:
        raise AssertionError(f"Expected prompt-owned wheel gestures to scroll the draft viewport. Screen:\n{screen}")

    harness.step("wheel inside the prompt past its boundary and verify chat auto-scroll re-engages")
    for _ in range(8):
        screen = harness.screen_text()
        try:
            prompt_x, row = screen_position_containing(screen, "scrollable draft line")
        except AssertionError:
            prompt_x = 20
            row = prompt_marker_row(screen)
        harness.send_mouse_scroll_burst(master, prompt_x, row, "down", 20)
        if "SCROLL-THIRD-69" in harness.screen_text():
            break
    screen = harness.wait_for(master, proc, "SCROLL-THIRD-69", 5)
    if "SCROLL-SECOND-69" in screen:
        raise AssertionError(f"Expected prompt boundary fallthrough to reach the newest bottom marker. Screen:\n{screen}")
    row = prompt_marker_row(harness.screen_text())
    harness.send_mouse_scroll_burst(master, 20, row, "down", 3)
    harness.send_text(master, "real scroll fourth")
    harness.send(master, "\r")
    screen = harness.wait_for(master, proc, "SCROLL-FOURTH-69", 8)
    if "SCROLL-THIRD-69" in screen:
        raise AssertionError(
            f"Expected fourth long output to replace the previous bottom marker after prompt-boundary reengagement. Screen:\n{screen}"
        )
