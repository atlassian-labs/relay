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

from real_e2e_chat_autoscroll import ChatAutoscrollPtyHarness, run_chat_autoscroll_probe

SCREEN_ROWS = 30
SCREEN_COLS = 120
HARNESS = ChatAutoscrollPtyHarness(SCREEN_ROWS, SCREEN_COLS)


def transcript_text() -> str:
    return HARNESS.transcript_text()


def step(name: str) -> None:
    HARNESS.step(name)


def process_diagnostics(proc: subprocess.Popen) -> str:
    return HARNESS.process_diagnostics(proc)


def set_pty_size(fd: int, rows: int = SCREEN_ROWS, cols: int = SCREEN_COLS) -> None:
    HARNESS.set_pty_size(fd, rows, cols)


def read_available(fd: int, timeout: float = 0.05) -> str:
    return HARNESS.read_available(fd, timeout)


def wait_for(fd: int, proc: subprocess.Popen, needle: str, timeout: float = 8.0) -> str:
    return HARNESS.wait_for(fd, proc, needle, timeout)


def wait_for_absent(fd: int, proc: subprocess.Popen, needle: str, timeout: float = 1.5) -> str:
    return HARNESS.wait_for_absent(fd, proc, needle, timeout)


def prompt_events(path: str) -> list[str]:
    return [str(entry.get("text")) for entry in HARNESS.read_agent_events(path) if entry.get("event") == "prompt"]


def prompt_containing(path: str, marker: str) -> str:
    for text in prompt_events(path):
        if marker in text:
            return text
    raise AssertionError(f"Could not find prompt containing {marker!r}: {prompt_events(path)}")


def wait_for_agent_event(path: str, event: str, marker: str, timeout: float = 5.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        for entry in HARNESS.read_agent_events(path):
            if entry.get("event") == event and entry.get("marker") == marker:
                return entry
        time.sleep(0.05)
    raise AssertionError(
        f"Timed out waiting for agent event {event!r} with marker {marker!r}: {HARNESS.read_agent_events(path)}"
    )


def resize_terminal(fd: int, proc: subprocess.Popen, rows: int, cols: int) -> None:
    HARNESS.resize_terminal(fd, proc, rows, cols)


def send(fd: int, data: str) -> None:
    HARNESS.send(fd, data)


def send_text(fd: int, text: str) -> None:
    HARNESS.send_text(fd, text)


def send_mouse_scroll(fd: int, x: int, y: int, direction: str) -> None:
    HARNESS.send_mouse_scroll(fd, x, y, direction)


def run_interaction_panel_probe(master: int, proc: subprocess.Popen, agent_log: str) -> None:
    step("resize narrow and verify compact single-choice elicitation")
    resize_terminal(master, proc, 20, 60)
    send_text(master, "single choice elicitation e2e submit")
    send(master, "\r")
    screen = wait_for(master, proc, "› ○ Staging", 8)
    if "○ Production" not in screen or "↑/↓ navigate · enter review · esc cancel" not in screen:
        raise AssertionError(f"Expected compact radio choices and focused controls. Screen:\n{screen}")
    if "Submit" in screen or "□" in screen or "←/→ questions" in screen:
        raise AssertionError(f"Expected single-choice chrome without tabs or checkbox markers. Screen:\n{screen}")

    step("move focus, review the answer, and verify compact spacing")
    send(master, "\x1b[B")
    wait_for(master, proc, "› ○ Production", 5)
    send(master, "\r")
    screen = wait_for(master, proc, "← edit answer · enter submit · esc cancel", 5)
    lines = screen.splitlines()
    review_row = next((index for index, line in enumerate(lines) if "Review answers" in line), -1)
    if review_row < 0 or "← edit answer · enter submit · esc cancel" not in screen:
        raise AssertionError(f"Expected compact review content and shortcuts. Screen:\n{screen}")
    if "━" in screen:
        raise AssertionError(f"Expected a borderless compact review surface. Screen:\n{screen}")
    if "Which environment should receive the release?" not in screen or "Production" not in screen:
        raise AssertionError(f"Expected selected answer in review summary. Screen:\n{screen}")

    step("return to edit, preserve radio state, and submit exact ACP content")
    send(master, "\x1b[D")
    wait_for(master, proc, "› ● Production", 5)
    send(master, "\x1b[C")
    wait_for(master, proc, "Review answers", 5)
    send(master, "\r")
    wait_for(master, proc, "elicitation submit accept", 8)
    submit_event = wait_for_agent_event(agent_log, "elicitation-response", "submit")
    if submit_event.get("response") != {"action": "accept", "content": {"environment": "production"}}:
        raise AssertionError(f"Expected exact accepted elicitation response, got: {submit_event}")

    step("cancel a second elicitation and verify the ACP cancellation response")
    send_text(master, "single choice elicitation e2e cancel")
    send(master, "\r")
    screen = wait_for(master, proc, "› ○ Keep", 8)
    if "○ Cancel" not in screen:
        raise AssertionError(f"Expected cancel probe choices. Screen:\n{screen}")
    send(master, "\x1b")
    wait_for(master, proc, "elicitation cancel cancel", 8)
    cancel_event = wait_for_agent_event(agent_log, "elicitation-response", "cancel")
    if cancel_event.get("response") != {"action": "cancel"}:
        raise AssertionError(f"Expected exact cancelled elicitation response, got: {cancel_event}")

    step("verify permission actions do not inherit radio or checkbox markers")
    send_text(master, "terminal title smoke e2e")
    send(master, "\r")
    screen = wait_for(master, proc, "Permission Required", 8)
    if "○" in screen or "●" in screen or "□" in screen:
        raise AssertionError(f"Expected plain permission actions without selection markers. Screen:\n{screen}")
    if "› Allow once" not in screen or "Reject once" not in screen:
        raise AssertionError(f"Expected focused permission actions. Screen:\n{screen}")
    send(master, "\x1b[B")
    wait_for(master, proc, "› Reject once", 5)
    send(master, "\r")
    wait_for(master, proc, "terminal title smoke complete", 8)


def main() -> int:
    artifacts = os.path.join(ROOT, "test-results", "real-e2e")
    os.makedirs(artifacts, exist_ok=True)
    home = tempfile.mkdtemp(prefix="relay-ui-polish-home-")
    workspace = tempfile.mkdtemp(prefix="relay-ui-polish-workspace-")
    agent_log = os.path.join(workspace, "agent-events.ndjson")
    env = os.environ.copy()
    env.pop("XDG_CONFIG_HOME", None)
    env.update({
        "HOME": home,
        "TERM": "xterm-256color",
        "NO_COLOR": "1",
        "RELAY_DISABLE_NOTIFICATIONS": "1",
        "RELAY_REAL_E2E_ADVERTISE_REAL_SKILL_COMMAND": "1",
        "RELAY_REAL_E2E_RAW_SKILL_ECHO": "1",
        "RELAY_REAL_E2E_PROMPT_LOG": agent_log,
    })

    relay_dir = os.path.join(home, ".config", "relay")
    os.makedirs(relay_dir, exist_ok=True)
    agent_path = os.path.join(ROOT, "test", "real-e2e", "acp-agent.ts")
    config_path = os.path.join(relay_dir, "config.toml")
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

    command = relay_command(ROOT, "real-e2e")
    master, slave = pty.openpty()
    set_pty_size(master)
    set_pty_size(slave)
    passed = False
    proc = subprocess.Popen(command, cwd=workspace, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
    os.close(slave)

    try:
        step("wait for Relay to connect through real CLI")
        wait_for(master, proc, "Connected to", 10)

        step("verify compact composer does not show persistent shortcut footer")
        screen = wait_for(master, proc, "\n >", 5)
        wait_for_absent(master, proc, "Enter send · Shift+Enter newline")
        wait_for_absent(master, proc, "/ commands · @ files · ! bash")
        if "\n >" not in screen:
            raise AssertionError(f"Expected frameless prompt marker on its own row. Screen:\n{screen}")

        step("resize to medium terminal and verify shortcut footer stays absent")
        resize_terminal(master, proc, SCREEN_ROWS, 70)
        screen = wait_for(master, proc, "\n >", 5)
        if "\n >" not in screen:
            raise AssertionError(f"Expected frameless prompt marker after resize. Screen:\n{screen}")
        wait_for_absent(master, proc, "context • tokens")
        wait_for_absent(master, proc, "Enter send · Shift+Enter newline")
        wait_for_absent(master, proc, "/ commands · @ files · ! bash")

        run_interaction_panel_probe(master, proc, agent_log)

        step("restore wide terminal, open slash overlay, and verify keyboard guidance through terminal output")
        resize_terminal(master, proc, SCREEN_ROWS, SCREEN_COLS)
        send_text(master, "/thr")
        wait_for(master, proc, "/threads", 5)
        wait_for(master, proc, "open thread sidebar", 5)
        wait_for(master, proc, "↑/↓ navigate · enter select · esc close", 5)
        send(master, "\x1b")
        wait_for_absent(master, proc, "open thread sidebar", 2)
        send(master, "\x15")

        step("submit a prompt and verify transcript bodies render outside the input")
        send_text(master, "real transcript header prompt")
        send(master, "\r")
        screen = wait_for(master, proc, "ack: real transcript header prompt", 8)
        if "> real transcript header prompt" in screen:
            raise AssertionError(f"Expected submitted user text in transcript, not inline with the prompt marker. Screen:\n{screen}")
        if "real transcript header prompt" not in screen or "ack: real transcript header prompt" not in screen:
            raise AssertionError(f"Expected submitted user text and agent response in transcript. Screen:\n{screen}")

        step("submit an ACP slash skill and verify raw skill echo renders compactly")
        send_text(master, "/real-skill with args")
        send(master, "\r")
        screen = wait_for(master, proc, "ack: raw real-skill prompt received", 8)
        if "[skill] real-skill" not in screen or "with args" not in screen:
            raise AssertionError(f"Expected compact ACP skill preview with user arguments. Screen:\n{screen}")
        if "register_cmd" in screen or "Use the real skill body." in screen:
            raise AssertionError(f"Expected compact skill preview to hide raw skill payload. Screen:\n{screen}")

        step("run local bash and verify label and prompt isolation")
        send_text(master, "!printf real-local-bash")
        send(master, "\r")
        screen = wait_for(master, proc, "[bash] local", 8)
        if "[local]" in screen or "[llm-request]" in screen:
            raise AssertionError(f"Expected polished local bash label without legacy labels. Screen:\n{screen}")
        wait_for(master, proc, "$ printf real-local-bash", 5)
        wait_for(master, proc, "real-local-bash", 5)
        send_text(master, "after local bash check")
        send(master, "\r")
        wait_for(master, proc, "ack: after local bash check", 8)
        local_prompt = prompt_containing(agent_log, "after local bash check")
        if "real-local-bash" in local_prompt:
            raise AssertionError(f"Expected ! bash output to stay out of ACP prompt context. Prompt:\n{local_prompt}")

        step("run context bash and verify label and prompt context")
        send_text(master, "!!printf real-context-bash")
        send(master, "\r")
        screen = wait_for(master, proc, "[bash] context", 8)
        if "[local]" in screen or "[llm-request]" in screen:
            raise AssertionError(f"Expected polished context bash label without legacy labels. Screen:\n{screen}")
        wait_for(master, proc, "$ printf real-context-bash", 5)
        wait_for(master, proc, "real-context-bash", 5)
        send_text(master, "after context bash check")
        send(master, "\r")
        wait_for(master, proc, "ack: after context bash check", 8)
        context_prompt = prompt_containing(agent_log, "after context bash check")
        if "real-context-bash" not in context_prompt or "The user ran the following commands" not in context_prompt:
            raise AssertionError(f"Expected !! bash output in ACP prompt context. Prompt:\n{context_prompt}")

        step("submit a tool-first prompt and verify tool output follows the prompt")
        send_text(master, "normalized diff e2e")
        send(master, "\r")
        screen = wait_for(master, proc, "custom_diff_tool", 8)
        tool_index = screen.find("custom_diff_tool")
        prompt_index = screen.rfind("normalized diff e2e", 0, tool_index)
        if prompt_index < 0 or tool_index < 0 or not (prompt_index < tool_index):
            raise AssertionError(f"Expected current turn tool output after the prompt. Screen:\n{screen}")

        run_chat_autoscroll_probe(HARNESS, master, proc, agent_log)

        passed = True
        return 0
    finally:
        with open(os.path.join(artifacts, "ui-polish-smoke.steps.txt"), "w", encoding="utf-8") as file:
            file.write("\n".join(HARNESS.steps))
        with open(os.path.join(artifacts, "ui-polish-smoke.transcript.txt"), "w", encoding="utf-8") as file:
            file.write(HARNESS.transcript_text())
        with open(os.path.join(artifacts, "ui-polish-smoke.screen.txt"), "w", encoding="utf-8") as file:
            file.write(HARNESS.screen_text())
        if os.path.exists(config_path):
            shutil.copyfile(config_path, os.path.join(artifacts, "ui-polish-smoke.config.toml"))
        if os.path.exists(agent_log):
            shutil.copyfile(agent_log, os.path.join(artifacts, "ui-polish-smoke.agent-events.ndjson"))
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
        with open(os.path.join(artifacts, "ui-polish-smoke.process.txt"), "w", encoding="utf-8") as file:
            file.write(process_diagnostics(proc))
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
