#!/usr/bin/env python3
"""Resume a 40k-update ACP session through the real CLI within a fixed budget."""
import json
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
sys.path.insert(0, os.path.join(ROOT, "test", "lib"))

from real_e2e_chat_autoscroll import ChatAutoscrollPtyHarness

RESUME_BUDGET_SECONDS = float(os.environ.get("RELAY_LARGE_SESSION_RESUME_BUDGET_SECONDS", "45"))


def write_history(path: str, turns: int = 600) -> None:
    def chunk(kind: str, text: str) -> dict:
        return {"sessionUpdate": kind, "content": {"type": "text", "text": text}}

    with open(path, "w", encoding="utf-8") as file:
        for turn in range(turns):
            updates = [chunk("user_message_chunk", f"history prompt {turn}")]
            updates += [chunk("agent_thought_chunk", f"thinking {i} ") for i in range(40)]
            for tool in range(3):
                tool_call_id = f"tool-{turn}-{tool}"
                updates.append({"sessionUpdate": "tool_call", "toolCallId": tool_call_id, "title": "bash",
                                "kind": "execute", "status": "pending", "rawInput": {"command": f"echo {tool}"}})
                updates.append({"sessionUpdate": "tool_call_update", "toolCallId": tool_call_id,
                                "status": "completed", "rawOutput": "\n".join(f"line {i}" for i in range(20))})
            updates += [chunk("agent_message_chunk", f"answer {turn}.{i} ") for i in range(20)]
            file.writelines(json.dumps(update) + "\n" for update in updates)
        file.write(json.dumps(chunk("agent_message_chunk", "LARGE-HISTORY-END")) + "\n")


def main() -> int:
    home = tempfile.mkdtemp(prefix="relay-large-session-home-")
    workspace = tempfile.mkdtemp(prefix="relay-large-session-workspace-")
    history = os.path.join(workspace, "history.ndjson")
    write_history(history)
    relay_dir = os.path.join(home, ".config", "relay")
    os.makedirs(relay_dir)
    agent_path = os.path.join(ROOT, "test", "real-e2e", "acp-agent.ts")
    with open(os.path.join(relay_dir, "config.toml"), "w", encoding="utf-8") as file:
        file.write('[agents]\ndefault = "real-e2e"\n\n[agents.runners.real-e2e]\n'
                   f'command = "bun"\nargs = ["run", "{agent_path}"]\nprofile = "default"\n')
    env = {k: v for k, v in os.environ.items() if k != "XDG_CONFIG_HOME"}
    env.update({"HOME": home, "TERM": "xterm-256color", "NO_COLOR": "1", "RELAY_DISABLE_NOTIFICATIONS": "1",
                "RELAY_REAL_E2E_HISTORY_FILE": history, "RELAY_REAL_E2E_PROMPT_DELAY_MS": "0",
                "RELAY_REAL_E2E_FINAL_QUEUE_DELAY_MS": "0"})

    harness = ChatAutoscrollPtyHarness()
    master, slave = pty.openpty()
    harness.set_pty_size(master)
    harness.set_pty_size(slave)
    proc = subprocess.Popen(relay_command(ROOT, "real-e2e") + ["--resume", "large-session"], cwd=workspace,
                            env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
    os.close(slave)
    try:
        start = time.time()
        harness.wait_for(master, proc, "LARGE-HISTORY-END", RESUME_BUDGET_SECONDS)
        harness.step(f"resumed 40k-update session in {time.time() - start:.1f}s")
        harness.send_text(master, "large session follow up")
        harness.send(master, "\r")
        harness.wait_for(master, proc, "ack: large session follow up", 10)
        harness.step("follow-up prompt round-tripped")
        return 0
    finally:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.wait(timeout=3)
        os.close(master)
        shutil.rmtree(home, ignore_errors=True)
        shutil.rmtree(workspace, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
