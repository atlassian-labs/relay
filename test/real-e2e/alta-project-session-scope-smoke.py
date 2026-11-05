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

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCREEN_ROWS = 40
SCREEN_COLS = 150
TRANSCRIPT: list[str] = []
ANSI_RE = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x1b]*(?:\x07|\x1b\\)|[@-_])")
CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def clean(text: str) -> str:
    return CONTROL_RE.sub("", ANSI_RE.sub("", text).replace("\r", "\n"))


def transcript_text() -> str:
    return clean("".join(TRANSCRIPT))


def set_pty_size(fd: int) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", SCREEN_ROWS, SCREEN_COLS, 0, 0))


def read_available(fd: int, timeout: float = 0.1) -> str:
    chunks: list[str] = []
    deadline = time.time() + timeout
    while time.time() < deadline:
        ready, _, _ = select.select([fd], [], [], max(0, deadline - time.time()))
        if not ready:
            break
        try:
            data = os.read(fd, 65536)
        except OSError:
            break
        if not data:
            break
        decoded = data.decode("utf-8", "replace")
        TRANSCRIPT.append(decoded)
        chunks.append(decoded)
    return "".join(chunks)


def assert_process_running(proc: subprocess.Popen) -> None:
    code = proc.poll()
    if code is not None:
        raise AssertionError(f"Relay exited with {code}. Transcript:\n{transcript_text()[-12000:]}")


def wait_for(fd: int, proc: subprocess.Popen, needle: str, timeout: float = 60.0) -> str:
    deadline = time.time() + timeout
    while time.time() < deadline:
        assert_process_running(proc)
        read_available(fd, 0.2)
        text = transcript_text()
        if needle in text:
            return text
    raise AssertionError(f"Timed out waiting for {needle!r}. Transcript:\n{transcript_text()[-16000:]}")


def send(fd: int, data: str) -> None:
    os.write(fd, data.encode("utf-8"))
    read_available(fd, 0.2)


def env_path(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise AssertionError(f"{name} is required for real Alta session-scope E2E")
    return os.path.abspath(os.path.expanduser(value))


def toml_string(value: str) -> str:
    return json.dumps(value)


def stop_process(proc: subprocess.Popen | None) -> None:
    if proc is None or proc.poll() is not None:
        return
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        proc.wait(timeout=8)
        return
    except subprocess.TimeoutExpired:
        pass
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError:
        return
    try:
        proc.wait(timeout=8)
    except subprocess.TimeoutExpired:
        pass


def acp_request(proc: subprocess.Popen, method: str, params: dict | None = None) -> dict:
    acp_request.next_id += 1
    request = {"jsonrpc": "2.0", "id": acp_request.next_id, "method": method}
    if params is not None:
        request["params"] = params
    assert proc.stdin is not None
    proc.stdin.write(json.dumps(request) + "\n")
    proc.stdin.flush()
    deadline = time.time() + 60
    assert proc.stdout is not None
    while time.time() < deadline:
        ready, _, _ = select.select([proc.stdout], [], [], 0.2)
        if not ready:
            continue
        line = proc.stdout.readline()
        if not line:
            stderr = proc.stderr.read() if proc.stderr is not None else ""
            raise AssertionError(f"ACP process exited while waiting for {method}. stderr:\n{stderr[-4000:]}")
        message = json.loads(line)
        if message.get("id") != acp_request.next_id:
            continue
        if "error" in message:
            raise AssertionError(f"ACP {method} failed: {message}")
        return message.get("result", {})
    raise AssertionError(f"Timed out waiting for ACP {method}")


acp_request.next_id = 0


def start_alta(tsx: str, alta_bin: str, agent_source: str, workspace: str, env: dict[str, str]) -> subprocess.Popen:
    return subprocess.Popen(
        [tsx, alta_bin, "agent", "run", agent_source, "--workspace", workspace],
        cwd=workspace,
        env=env,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )


def seed_session(tsx: str, alta_bin: str, agent_source: str, workspace: str, env: dict[str, str]) -> str:
    proc = start_alta(tsx, alta_bin, agent_source, workspace, env)
    try:
        init = acp_request(proc, "initialize", {"protocolVersion": 1, "clientCapabilities": {}})
        capabilities = init.get("agentCapabilities", {})
        if "list" not in capabilities.get("sessionCapabilities", {}):
            raise AssertionError(f"Alta bridge did not advertise session/list: {init}")
        result = acp_request(proc, "session/new", {"cwd": workspace, "mcpServers": []})
        session_id = result.get("sessionId")
        if not isinstance(session_id, str) or not session_id:
            raise AssertionError(f"session/new returned no sessionId: {result}")
        return session_id
    finally:
        stop_process(proc)


def list_sessions(
    tsx: str,
    alta_bin: str,
    agent_source: str,
    workspace: str,
    env: dict[str, str],
    scope: str | None,
) -> list[dict]:
    proc = start_alta(tsx, alta_bin, agent_source, workspace, env)
    try:
        acp_request(proc, "initialize", {"protocolVersion": 1, "clientCapabilities": {}})
        params = {"cwd": workspace}
        if scope is not None:
            params["_meta"] = {"alta/session-list": {"scope": scope}}
        result = acp_request(proc, "session/list", params)
        sessions = result.get("sessions")
        if not isinstance(sessions, list):
            raise AssertionError(f"session/list returned malformed result: {result}")
        return sessions
    finally:
        stop_process(proc)


def make_git_repo(path: str, remote: str) -> None:
    subprocess.run(["git", "init", path], check=True, stdout=subprocess.DEVNULL)
    subprocess.run(["git", "-C", path, "remote", "add", "origin", remote], check=True)
    with open(os.path.join(path, "README.md"), "w", encoding="utf-8") as file:
        file.write(f"# {os.path.basename(path)}\n")
    subprocess.run(["git", "-C", path, "add", "README.md"], check=True, stdout=subprocess.DEVNULL)
    subprocess.run(
        [
            "git",
            "-C",
            path,
            "-c",
            "user.name=Relay E2E",
            "-c",
            "user.email=relay-e2e@example.com",
            "commit",
            "-m",
            "seed repo",
        ],
        check=True,
        stdout=subprocess.DEVNULL,
    )


def make_linked_worktree(repo: str, path: str) -> None:
    subprocess.run(["git", "-C", repo, "worktree", "add", "-b", os.path.basename(path), path], check=True, stdout=subprocess.DEVNULL)


def write_agent(path: str) -> None:
    with open(path, "w", encoding="utf-8") as file:
        file.write(
            "name: live-session-scope-agent\n"
            "system: You are a live session scope probe agent.\n"
            "models:\n"
            "  default: Claude Sonnet\n"
            "  available:\n"
            "    Claude Sonnet:\n"
            "      name: Claude Sonnet\n"
            "      model: vertex-anthropic:claude-sonnet-4-6\n"
        )


def main() -> int:
    alta_root = env_path("RELAY_REAL_ALTA_ROOT")
    relay_command = os.environ.get("RELAY_REAL_ALTA_RELAY_COMMAND", os.path.join(ROOT, "dist", "index.js"))
    tsx = os.environ.get("RELAY_REAL_ALTA_TSX", os.path.join(alta_root, "node_modules", ".bin", "tsx"))
    alta_bin = os.environ.get(
        "RELAY_REAL_ALTA_BIN", os.path.join(alta_root, "services", "alta-cli", "bin", "alta.ts")
    )
    real_config_home = os.path.abspath(os.path.expanduser(os.environ.get("RELAY_REAL_ALTA_CONFIG_HOME", "~/.config")))

    for required_path in [alta_root, relay_command, tsx, alta_bin, real_config_home]:
        if not os.path.exists(required_path):
            raise AssertionError(f"Required real E2E path does not exist: {required_path}")

    artifacts = os.path.join(ROOT, "test-results", "real-e2e")
    os.makedirs(artifacts, exist_ok=True)
    root = tempfile.mkdtemp(prefix="relay-real-alta-session-scope-")
    runtime_data = os.path.join(root, "data")
    runtime_cache = os.path.join(root, "cache")
    relay_config_home = os.path.join(root, "relay-config")
    master, slave = pty.openpty()
    proc: subprocess.Popen | None = None
    passed = False

    repo_a = os.path.join(root, "repo-a-independent")
    repo_b = os.path.join(root, "repo-b-current")
    repo_b_linked = os.path.join(root, "repo-b-linked")
    agent_source = os.path.join(root, "agent.yml")
    summary: dict[str, object] = {}

    try:
        os.makedirs(runtime_data, exist_ok=True)
        os.makedirs(runtime_cache, exist_ok=True)
        os.makedirs(os.path.join(relay_config_home, "relay"), exist_ok=True)
        write_agent(agent_source)
        make_git_repo(repo_a, "git@example.com:acme/sample-project.git")
        make_git_repo(repo_b, "https://example.com/acme/sample-project.git")
        make_linked_worktree(repo_b, repo_b_linked)

        alta_env = os.environ.copy()
        alta_env.update(
            {
                "XDG_DATA_HOME": runtime_data,
                "XDG_CACHE_HOME": runtime_cache,
                "XDG_CONFIG_HOME": real_config_home,
                "NO_BROWSER": "1",
            }
        )
        # Seed the current checkout first and linked worktree second so the wrong project-scoped
        # Relay behavior would select the linked worktree. The independent clone is seeded last to
        # prove Alta project scope no longer groups unrelated clones by same remote URL.
        session_b = seed_session(tsx, alta_bin, agent_source, repo_b, alta_env)
        session_linked = seed_session(tsx, alta_bin, agent_source, repo_b_linked, alta_env)
        session_a = seed_session(tsx, alta_bin, agent_source, repo_a, alta_env)

        default_sessions = list_sessions(tsx, alta_bin, agent_source, repo_b, alta_env, None)
        cwd_sessions = list_sessions(tsx, alta_bin, agent_source, repo_b, alta_env, "cwd")
        project_sessions = list_sessions(tsx, alta_bin, agent_source, repo_b, alta_env, "project")
        default_ids = [session["sessionId"] for session in default_sessions]
        cwd_ids = [session["sessionId"] for session in cwd_sessions]
        project_ids = [session["sessionId"] for session in project_sessions]
        project_scopes = {
            session["sessionId"]: session.get("_meta", {}).get("alta/session-list", {}).get("workspaceScope")
            for session in project_sessions
        }
        if default_ids != [session_b]:
            raise AssertionError(
                f"default scope should only return repo B session. got={default_ids}, session_b={session_b}"
            )
        if cwd_ids != [session_b]:
            raise AssertionError(f"cwd scope should only return repo B session. got={cwd_ids}, session_b={session_b}")
        if project_ids != [session_linked, session_b]:
            raise AssertionError(f"project scope should return linked worktree then current sessions. got={project_ids}")
        if (
            project_scopes.get(session_linked) != "same-project"
            or project_scopes.get(session_b) != "current-cwd"
            or session_a in project_scopes
        ):
            raise AssertionError(f"unexpected project workspace scopes: {project_scopes}")

        relay_dir = os.path.join(relay_config_home, "relay")
        with open(os.path.join(relay_dir, "config.toml"), "w", encoding="utf-8") as file:
            file.write(
                "[notifications]\n"
                "sound_enabled = false\n\n"
                "[agents]\n"
                "default = \"local-alta\"\n\n"
                "[agents.runners.local-alta]\n"
                f"command = {toml_string(tsx)}\n"
                f"args = [{', '.join(toml_string(value) for value in [alta_bin, 'agent', 'run', agent_source, '--workspace', repo_b])}]\n"
                "profile = \"alta\"\n"
                "env = { "
                f"XDG_DATA_HOME = {toml_string(runtime_data)}, "
                f"XDG_CACHE_HOME = {toml_string(runtime_cache)}, "
                f"XDG_CONFIG_HOME = {toml_string(real_config_home)}, "
                "NO_BROWSER = \"1\" }\n"
            )

        env = os.environ.copy()
        env.update(
            {
                "XDG_CONFIG_HOME": relay_config_home,
                "TERM": "xterm-256color",
                "NO_COLOR": "1",
                "RELAY_DISABLE_NOTIFICATIONS": "1",
            }
        )
        command = ["bun", "run", relay_command, "--agent", "local-alta", "--resume"]
        set_pty_size(master)
        set_pty_size(slave)
        proc = subprocess.Popen(
            command,
            cwd=repo_b,
            env=env,
            stdin=slave,
            stdout=slave,
            stderr=slave,
            start_new_session=True,
        )
        os.close(slave)

        wait_for(master, proc, "Loading sessions", 180)
        screen = wait_for(master, proc, "repo-b-current", 180)
        if "repo-b-linked" in screen or "repo-a-independent" in screen or "same project" in screen:
            raise AssertionError(f"Relay picker leaked non-current Alta sessions. Screen:\n{screen[-16000:]}")
        send(master, "\r")
        wait_for(master, proc, f"Resumed ACP session: {session_b}", 180)

        summary = {
            "session_a": session_a,
            "session_b": session_b,
            "session_linked": session_linked,
            "default_ids": default_ids,
            "cwd_ids": cwd_ids,
            "project_ids": project_ids,
            "project_scopes": project_scopes,
        }
        print("REAL_ALTA_PROJECT_SESSION_SCOPE_E2E_PASS")
        print(json.dumps(summary, sort_keys=True))
        passed = True
        return 0
    finally:
        stop_process(proc)
        try:
            os.close(master)
        except OSError:
            pass
        transcript_path = os.path.join(artifacts, "alta-project-session-scope-smoke.transcript.txt")
        summary_path = os.path.join(artifacts, "alta-project-session-scope-smoke.summary.json")
        config_artifact_path = os.path.join(artifacts, "alta-project-session-scope-smoke.config.toml")
        with open(transcript_path, "w", encoding="utf-8") as file:
            file.write(transcript_text())
        with open(summary_path, "w", encoding="utf-8") as file:
            json.dump({**summary, "passed": passed}, file, indent=2, sort_keys=True)
        config_path = os.path.join(relay_config_home, "relay", "config.toml")
        if os.path.exists(config_path):
            shutil.copyfile(config_path, config_artifact_path)
        if not passed:
            print("REAL_ALTA_PROJECT_SESSION_SCOPE_E2E_FAILED", file=sys.stderr)
            print(f"root={root}", file=sys.stderr)
            print(f"relay_config_home={relay_config_home}", file=sys.stderr)
            print(f"runtime_data={runtime_data}", file=sys.stderr)
            print(f"runtime_cache={runtime_cache}", file=sys.stderr)
            print(f"artifacts={artifacts}", file=sys.stderr)
            print(transcript_text()[-16000:], file=sys.stderr)
        else:
            shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
