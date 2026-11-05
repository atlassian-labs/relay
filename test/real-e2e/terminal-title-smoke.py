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
SCREEN_ROWS = 30
SCREEN_COLS = 120
TRANSCRIPT: list[str] = []
STEPS: list[str] = []
THREAD_TITLE_SNAPSHOTS: list[dict] = []
ANSI_RE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
OSC_TITLE_RE = re.compile(r"\x1b\]0;(.*?)(?:\x07|\x1b\\)", re.S)
SPINNER_TITLE_RE = re.compile(r"^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] ")


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


SCREEN = Screen()


def clean(text: str) -> str:
    text = ANSI_RE.sub("", text)
    text = text.replace("\r", "\n")
    text = CONTROL_RE.sub("", text)
    return text


def transcript_raw() -> str:
    return "".join(TRANSCRIPT)


def transcript_text() -> str:
    return clean(transcript_raw())


def title_writes() -> list[str]:
    return OSC_TITLE_RE.findall(transcript_raw())


def thread_state_payloads(home: str) -> list[dict]:
    threads_dir = os.path.join(home, ".config", "relay", "threads")
    if not os.path.isdir(threads_dir):
        return []
    payloads = []
    for name in sorted(os.listdir(threads_dir)):
        if not name.endswith(".json"):
            continue
        path = os.path.join(threads_dir, name)
        try:
            with open(path, encoding="utf-8") as file:
                payloads.append({"file": path, "content": json.load(file)})
        except (OSError, json.JSONDecodeError) as err:
            payloads.append({"file": path, "error": str(err)})
    return payloads


def active_thread_state(home: str) -> dict | None:
    for payload in thread_state_payloads(home):
        content = payload.get("content")
        if not isinstance(content, dict):
            continue
        active_thread_id = content.get("activeThreadId")
        threads = content.get("threads")
        if not isinstance(active_thread_id, str) or not isinstance(threads, list):
            continue
        for thread in threads:
            if isinstance(thread, dict) and thread.get("id") == active_thread_id:
                return thread
    return None


def wait_for_active_thread_title(home: str, title: str, quality: str, timeout: float = 4.0) -> dict:
    deadline = time.time() + timeout
    last_thread = None
    while time.time() < deadline:
        last_thread = active_thread_state(home)
        if last_thread and last_thread.get("title") == title and last_thread.get("titleQuality") == quality:
            return last_thread
        time.sleep(0.05)
    raise AssertionError(
        f"Timed out waiting for active persisted thread title={title!r} quality={quality!r}. "
        f"Last active thread={last_thread!r}. Payloads={thread_state_payloads(home)!r}"
    )


def record_active_thread_title_snapshot(label: str, thread: dict) -> None:
    THREAD_TITLE_SNAPSHOTS.append({
        "label": label,
        "id": thread.get("id"),
        "title": thread.get("title"),
        "titleQuality": thread.get("titleQuality"),
    })


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


def wait_for_title(
    fd: int,
    proc: subprocess.Popen,
    description: str,
    predicate,
    min_index: int = 0,
    timeout: float = 8.0,
) -> tuple[int, str]:
    deadline = time.time() + timeout
    while time.time() < deadline:
        assert_process_running(proc)
        read_available(fd, 0.1)
        titles = title_writes()
        for index, title in enumerate(titles[min_index:], min_index):
            if predicate(title):
                return index, title
    raise AssertionError(
        f"Timed out waiting for title {description}.\n"
        f"Titles: {title_writes()}\nScreen:\n{SCREEN.text()}\n\nTranscript tail:\n{transcript_text()[-4000:]}"
    )


def wait_for_exit_and_title(fd: int, proc: subprocess.Popen, expected_title: str, timeout: float = 8.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        read_available(fd, 0.1)
        if proc.poll() is not None:
            read_available(fd, 0.2)
            titles = title_writes()
            if titles and titles[-1] == expected_title:
                return
        time.sleep(0.02)
    raise AssertionError(
        f"Timed out waiting for Relay exit with final title {expected_title!r}. "
        f"Process: {process_diagnostics(proc)}. Titles: {title_writes()}"
    )


def send(fd: int, data: str) -> None:
    os.write(fd, data.encode("utf-8"))
    read_available(fd, 0.1)


def send_text(fd: int, text: str) -> None:
    for ch in text:
        send(fd, ch)


def paste_text(fd: int, text: str) -> None:
    send(fd, "\x1b[200~")
    send_text(fd, text)
    send(fd, "\x1b[201~")


def main() -> int:
    artifacts = os.path.join(ROOT, "test-results", "real-e2e")
    os.makedirs(artifacts, exist_ok=True)
    home = tempfile.mkdtemp(prefix="relay-terminal-title-home-")
    workspace_parent = tempfile.mkdtemp(prefix="relay-terminal-title-parent-")
    workspace = os.path.join(workspace_parent, "terminal-title-workspace")
    os.makedirs(workspace, exist_ok=True)
    workspace_label = os.path.basename(workspace)
    idle_workspace_title = workspace_label
    prompt_title = f"terminal title smoke e2e · {workspace_label}"
    idle_prompt_title = prompt_title
    late_prompt_title = f"terminal title late activity e2e · {workspace_label}"

    env = os.environ.copy()
    env.pop("XDG_CONFIG_HOME", None)
    env.update({
        "HOME": home,
        "TERM": "xterm-256color",
        "NO_COLOR": "1",
        "RELAY_DISABLE_NOTIFICATIONS": "1",
        "RELAY_REAL_E2E_ADVERTISE_REAL_SKILL_COMMAND": "1",
    })

    relay_dir = os.path.join(home, ".config", "relay")
    os.makedirs(relay_dir, exist_ok=True)
    agent_path = os.path.join(ROOT, "test", "real-e2e", "acp-agent.ts")
    config_path = os.path.join(relay_dir, "config.toml")
    with open(config_path, "w", encoding="utf-8") as file:
        file.write(
            '[notifications]\n'
            'sound_enabled = false\n\n'
            '[agents]\n'
            'default = "real-e2e"\n\n'
            '[agents.runners.real-e2e]\n'
            'command = "bun"\n'
            f'args = ["run", "{agent_path}"]\n'
            'profile = "default"\n'
        )

    command = relay_command(ROOT, "real-e2e")
    master, slave = pty.openpty()
    set_pty_size(master)
    set_pty_size(slave)
    passed = False
    proc = subprocess.Popen(command, cwd=workspace, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
    os.close(slave)

    try:
        step("observe startup workspace title")
        wait_for_title(master, proc, "startup workspace", lambda title: title == idle_workspace_title, timeout=10)

        step("wait for Relay to connect through real CLI")
        wait_for(master, proc, "Connected to", 10)
        wait_for_title(master, proc, "idle workspace after connect", lambda title: title == idle_workspace_title, timeout=10)
        idle_title_count = len(title_writes())
        read_available(master, 0.7)
        if len(title_writes()) != idle_title_count:
            raise AssertionError(
                "Idle terminal title was rewritten without a state change. "
                f"Before={idle_title_count}, after={len(title_writes())}, titles={title_writes()}"
            )

        step("submit long-running prompt and observe spinner title")
        send_text(master, "terminal title smoke e2e")
        send(master, "\r")
        wait_for(master, proc, "terminal title smoke started", 10)
        spinner_index, _ = wait_for_title(
            master,
            proc,
            "running spinner",
            lambda title: bool(SPINNER_TITLE_RE.match(title)) and title.endswith(f" {prompt_title}"),
            timeout=10,
        )

        step("observe action-required title while permission approval waits")
        action_index, action_title = wait_for_title(
            master,
            proc,
            "action required",
            lambda title: title == f"Needs input · {prompt_title}",
            min_index=spinner_index + 1,
            timeout=10,
        )
        if action_title in SCREEN.text():
            raise AssertionError(f"Title payload leaked onto terminal screen: {action_title!r}\n{SCREEN.text()}")

        step("approve permission and observe spinner title restored before turn finishes")
        send(master, "\r")
        wait_for_title(
            master,
            proc,
            "post-approval spinner",
            lambda title: bool(SPINNER_TITLE_RE.match(title)) and title.endswith(f" {prompt_title}"),
            min_index=action_index + 1,
            timeout=10,
        )

        step("observe idle workspace title after turn completion")
        wait_for(master, proc, "terminal title smoke complete", 10)
        wait_for_title(
            master,
            proc,
            "idle workspace",
            lambda title: title == idle_prompt_title,
            min_index=action_index + 1,
            timeout=10,
        )

        step("submit prompt that resolves before delayed ACP activity")
        late_start_index = len(title_writes())
        send_text(master, "terminal title late activity e2e")
        send(master, "\r")
        wait_for(master, proc, "terminal title late activity started", 10)
        late_spinner_index, _ = wait_for_title(
            master,
            proc,
            "late-activity running spinner",
            lambda title: bool(SPINNER_TITLE_RE.match(title)) and title.endswith(f" {late_prompt_title}"),
            min_index=late_start_index,
            timeout=10,
        )
        late_action_index, _ = wait_for_title(
            master,
            proc,
            "late-activity action required",
            lambda title: title == f"Needs input · {late_prompt_title}",
            min_index=late_spinner_index + 1,
            timeout=10,
        )

        step("approve delayed-activity permission and keep title busy before late update")
        send(master, "\r")
        wait_for_title(
            master,
            proc,
            "late-activity post-approval spinner",
            lambda title: bool(SPINNER_TITLE_RE.match(title)) and title.endswith(f" {late_prompt_title}"),
            min_index=late_action_index + 1,
            timeout=10,
        )
        time.sleep(0.45)
        read_available(master, 0.2)
        titles_before_late_update = title_writes()[late_action_index + 1 :]
        if late_prompt_title in titles_before_late_update:
            raise AssertionError(
                "Terminal title returned to idle prompt before delayed ACP activity arrived. "
                f"Titles after approval: {titles_before_late_update}"
            )

        step("observe delayed ACP activity then idle workspace title")
        wait_for(master, proc, "terminal title late activity complete", 10)
        wait_for_title(
            master,
            proc,
            "late-activity idle workspace",
            lambda title: title == late_prompt_title,
            min_index=late_action_index + 1,
            timeout=10,
        )

        step("prove default smart title source ignores low-signal latest input")
        smart_prompt = "terminal title smart source e2e"
        smart_prompt_title = f"{smart_prompt} · {workspace_label}"
        smart_start_index = len(title_writes())
        send_text(master, smart_prompt)
        send(master, "\r")
        wait_for(master, proc, f"ack: {smart_prompt}", 10)
        wait_for_title(
            master,
            proc,
            "smart prompt idle title",
            lambda title: title == smart_prompt_title,
            min_index=smart_start_index,
            timeout=10,
        )

        low_signal_start_index = len(title_writes())
        send_text(master, "yes")
        send(master, "\r")
        wait_for(master, proc, "ack: yes", 10)
        wait_for_title(
            master,
            proc,
            "smart title remains on latest meaningful prompt after yes",
            lambda title: title == smart_prompt_title,
            min_index=low_signal_start_index,
            timeout=10,
        )
        low_signal_title = f"yes · {workspace_label}"
        low_signal_titles = [
            title
            for title in title_writes()[low_signal_start_index:]
            if title == low_signal_title or title.endswith(f" {low_signal_title}")
        ]
        if low_signal_titles:
            raise AssertionError(
                f"Default smart terminal title used low-signal prompt: {low_signal_titles}"
            )

        step("create a fresh thread for skill title coverage")
        send_text(master, "/new")
        send(master, "\r")
        wait_for(master, proc, "New thread", 10)
        wait_for_title(
            master,
            proc,
            "fresh-thread workspace",
            lambda title: title == idle_workspace_title,
            timeout=10,
        )

        step("submit bare advertised skill and observe fallback title")
        bare_skill_title = f"Real skill session · {workspace_label}"
        bare_skill_start_index = len(title_writes())
        paste_text(master, "/real-skill")
        send(master, "\r")
        wait_for(master, proc, "ack: /real-skill", 10)
        wait_for_title(
            master,
            proc,
            "bare skill fallback idle title",
            lambda title: title == bare_skill_title,
            min_index=bare_skill_start_index,
            timeout=10,
        )
        record_active_thread_title_snapshot(
            "bare-skill-fallback",
            wait_for_active_thread_title(home, "Real skill session", "fallback"),
        )

        step("submit meaningful prompt and observe it replaces bare skill fallback")
        replacement_title = f"focus on regressions · {workspace_label}"
        replacement_start_index = len(title_writes())
        send_text(master, "focus on regressions")
        send(master, "\r")
        wait_for(master, proc, "ack: focus on regressions", 10)
        wait_for_title(
            master,
            proc,
            "meaningful prompt replaces bare skill fallback title",
            lambda title: title == replacement_title,
            min_index=replacement_start_index,
            timeout=10,
        )
        record_active_thread_title_snapshot(
            "fallback-replaced",
            wait_for_active_thread_title(home, "focus on regressions", "strong"),
        )

        step("submit first advertised skill through slash autocomplete and observe compact title")
        first_skill_title = f"real-skill — first title words · {workspace_label}"
        skill_start_index = len(title_writes())
        send_text(master, "/real-s")
        send(master, "\t")
        read_available(master, 0.2)
        send_text(master, "first title words")
        send(master, "\r")
        wait_for(master, proc, "ack: /real-skill first title words", 10)
        wait_for_title(
            master,
            proc,
            "first skill compact idle title",
            lambda title: title == first_skill_title,
            min_index=skill_start_index,
            timeout=10,
        )

        step("submit second advertised skill and observe title follows latest skill")
        second_skill_title = f"real-skill — second title words · {workspace_label}"
        paste_text(master, "/real-skill second title words")
        send(master, "\r")
        wait_for(master, proc, "ack: /real-skill second title words", 10)
        second_skill_ack_index = len(title_writes())
        wait_for_title(
            master,
            proc,
            "second skill compact idle title",
            lambda title: title == second_skill_title,
            min_index=second_skill_ack_index,
            timeout=10,
        )
        stale_skill_titles = [
            title
            for title in title_writes()[second_skill_ack_index:]
            if title == first_skill_title
            or title.endswith(f" {first_skill_title}")
            or title == f"Needs input · {first_skill_title}"
        ]
        if stale_skill_titles:
            raise AssertionError(
                f"Terminal title stayed on first skill after second skill: {stale_skill_titles}"
            )
        leaked_skill_titles = [
            title
            for title in title_writes()[skill_start_index:]
            if "[skill]" in title or "---" in title or "ARGUMENTS:" in title
        ]
        if leaked_skill_titles:
            raise AssertionError(
                f"Skill title leaked transcript/frontmatter syntax: {leaked_skill_titles}"
            )

        step("exit normally and observe managed title clear")
        send_text(master, "/quit")
        send(master, "\r")
        wait_for_exit_and_title(master, proc, "", 10)
        if proc.returncode != 0:
            raise AssertionError(f"Relay exited with non-zero code: {process_diagnostics(proc)}")

        passed = True
        return 0
    finally:
        with open(os.path.join(artifacts, "terminal-title-smoke.steps.txt"), "w", encoding="utf-8") as file:
            file.write("\n".join(STEPS))
        with open(os.path.join(artifacts, "terminal-title-smoke.transcript.txt"), "w", encoding="utf-8") as file:
            file.write(transcript_text())
        with open(os.path.join(artifacts, "terminal-title-smoke.titles.txt"), "w", encoding="utf-8") as file:
            file.write("\n".join(title_writes()))
        with open(os.path.join(artifacts, "terminal-title-smoke.threads.json"), "w", encoding="utf-8") as file:
            json.dump({"snapshots": THREAD_TITLE_SNAPSHOTS, "payloads": thread_state_payloads(home)}, file, indent=2)
        with open(os.path.join(artifacts, "terminal-title-smoke.screen.txt"), "w", encoding="utf-8") as file:
            file.write(SCREEN.text())
        if os.path.exists(config_path):
            shutil.copyfile(config_path, os.path.join(artifacts, "terminal-title-smoke.config.toml"))
        if proc.poll() is None:
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
        with open(os.path.join(artifacts, "terminal-title-smoke.process.txt"), "w", encoding="utf-8") as file:
            file.write(process_diagnostics(proc))
        os.close(master)
        if passed:
            shutil.rmtree(home, ignore_errors=True)
            shutil.rmtree(workspace_parent, ignore_errors=True)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as err:
        print(f"real e2e failed: {err}", file=sys.stderr)
        raise
