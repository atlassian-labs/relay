import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const tmpRoots: string[] = [];

function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-real-e2e-"));
  tmpRoots.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpRoots.length > 0) fs.rmSync(tmpRoots.pop()!, { recursive: true, force: true });
});

describe("Relay CLI real E2E", () => {
  test("drives session capability warm-up, model persistence, and hot reload through the real CLI", () => {
    const root = tmpRoot();
    const home = path.join(root, "home");
    const workspace = path.join(root, "workspace");
    const relayDir = path.join(home, ".config", "relay");
    const configPath = path.join(relayDir, "config.toml");
    const transcriptPath = path.join(root, "acp-transcript.ndjson");
    const expectPath = path.join(root, "relay-real-e2e.expect");
    const projectRoot = process.cwd();
    const relayEntry = path.resolve("src/index.ts");
    const acpAgent = path.resolve("test/real-e2e/acp-real-agent.ts");

    fs.mkdirSync(relayDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(
      configPath,
      `[notifications]\nsound_enabled = false\n\n[agents]\ndefault = "acp"\n\n[agents.runners.acp]\ncommand = "bun"\nargs = ["${tomlEscape(acpAgent)}", "${tomlEscape(transcriptPath)}"]\nprofile = "default"\n`,
      "utf-8",
    );

    fs.writeFileSync(
      expectPath,
      expectScript({ relayEntry, configPath, projectRoot, acpAgent, transcriptPath }),
      "utf-8",
    );

    const { XDG_CONFIG_HOME: _xdg, ...cleanEnv } = process.env;
    const result = spawnSync("expect", [expectPath], {
      cwd: workspace,
      env: {
        ...cleanEnv,
        HOME: home,
        TERM: "xterm-256color",
        RELAY_REAL_E2E_CONFIG: configPath,
      },
      encoding: "utf-8",
      timeout: 40_000,
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const config = fs.readFileSync(configPath, "utf-8");
    expect(config).toContain('preferred_model = "model-b"');
    expect(config).toContain("sound_enabled = true");

    const transcript = readTranscript(transcriptPath);
    expect(transcript.some((entry) => entry.method === "initialize")).toBe(true);
    expect(transcript.filter((entry) => entry.method === "session/new")).toHaveLength(2);
    const modelSets = transcript.filter((entry) => entry.method === "session/set_config_option");
    expect(modelSets.map((entry) => getModelId(entry))).toEqual(["model-b", "model-b"]);
  }, 45_000);

  test("restores rich ACP history through the real CLI resume boundary", () => {
    const root = tmpRoot();
    const home = path.join(root, "home");
    const workspace = path.join(root, "workspace");
    const relayDir = path.join(home, ".config", "relay");
    const configPath = path.join(relayDir, "config.toml");
    const transcriptPath = path.join(root, "acp-transcript.ndjson");
    const expectPath = path.join(root, "relay-restore-rich-history.expect");
    const projectRoot = process.cwd();
    const relayEntry = path.resolve("src/index.ts");
    const acpAgent = path.resolve("test/real-e2e/acp-real-agent.ts");

    fs.mkdirSync(relayDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(
      configPath,
      `[notifications]\nsound_enabled = false\n\n[agents]\ndefault = "acp"\n\n[agents.runners.acp]\ncommand = "bun"\nargs = ["${tomlEscape(acpAgent)}", "${tomlEscape(transcriptPath)}", "restore-rich-history"]\nprofile = "default"\n`,
      "utf-8",
    );
    fs.writeFileSync(expectPath, richRestoreExpectScript({ relayEntry, projectRoot }), "utf-8");

    const { XDG_CONFIG_HOME: _xdgRestore, ...cleanEnv } = process.env;
    const result = spawnSync("expect", [expectPath], {
      cwd: workspace,
      env: {
        ...cleanEnv,
        HOME: home,
        TERM: "xterm-256color",
        RELAY_REAL_E2E_CONFIG: configPath,
      },
      encoding: "utf-8",
      timeout: 20_000,
    });

    expect(result.status, `${result.stdout}\n${result.stderr}\nTranscript:\n${readFileIfExists(transcriptPath)}`).toBe(
      0,
    );
    const transcript = readTranscript(transcriptPath);
    expect(transcript.some((entry) => entry.method === "initialize")).toBe(true);
    expect(transcript.some((entry) => entry.method === "session/load")).toBe(true);
    expect(transcript.some((entry) => entry.method === "session/new")).toBe(false);
    expect(transcript.some((entry) => transcriptEntryContains(entry, "restored line one"))).toBe(true);
    expect(transcript.some((entry) => transcriptEntryContains(entry, "restored indent"))).toBe(true);
    expect(transcript.some((entry) => transcriptEntryContains(entry, "tool restored output"))).toBe(true);
  }, 25_000);

  test("filters internal-title sessions through real CLI resume surfaces", () => {
    const root = tmpRoot();
    const home = path.join(root, "home");
    const workspace = path.join(root, "workspace");
    const relayDir = path.join(home, ".config", "relay");
    const configPath = path.join(relayDir, "config.toml");
    const blankTranscriptPath = path.join(root, "blank-startup-transcript.ndjson");
    const onlyJunkTranscriptPath = path.join(root, "only-junk-transcript.ndjson");
    const mixedTranscriptPath = path.join(root, "mixed-transcript.ndjson");
    const expectPath = path.join(root, "relay-cache-session-history.expect");
    const projectRoot = process.cwd();
    const relayEntry = path.resolve("src/index.ts");
    const acpAgent = path.resolve("test/real-e2e/acp-real-agent.ts");

    fs.mkdirSync(relayDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(
      configPath,
      `[notifications]
sound_enabled = false

[plugins]
enabled = false
allow_project_plugins = false

[agents]
default = "blank"

[agents.runners.blank]
command = "bun"
args = ["${tomlEscape(acpAgent)}", "${tomlEscape(blankTranscriptPath)}"]
profile = "default"

[agents.runners.onlyjunk]
command = "bun"
args = ["${tomlEscape(acpAgent)}", "${tomlEscape(onlyJunkTranscriptPath)}", "cache-history-only-junk", "@atlassian/alta-agent-axiom-asumer"]
profile = "alta"

[agents.runners.mixed]
command = "bun"
args = ["${tomlEscape(acpAgent)}", "${tomlEscape(mixedTranscriptPath)}", "cache-history-with-real", "@atlassian/alta-agent-axiom-asumer"]
profile = "alta"
`,
      "utf-8",
    );
    fs.writeFileSync(
      expectPath,
      cacheSessionHistoryExpectScript({ relayEntry, projectRoot, onlyJunkTranscriptPath, mixedTranscriptPath }),
      "utf-8",
    );

    const { XDG_CONFIG_HOME: _xdgCacheSessions, ...cleanEnv } = process.env;
    const result = spawnSync("expect", [expectPath], {
      cwd: workspace,
      env: {
        ...cleanEnv,
        HOME: home,
        TERM: "xterm-256color",
        RELAY_REAL_E2E_CONFIG: configPath,
      },
      encoding: "utf-8",
      timeout: 30_000,
    });

    expect(
      result.status,
      `${result.stdout}
${result.stderr}
Blank transcript:
${readFileIfExists(blankTranscriptPath)}
Only-junk transcript:
${readFileIfExists(onlyJunkTranscriptPath)}
Mixed transcript:
${readFileIfExists(mixedTranscriptPath)}`,
    ).toBe(0);

    const blankTranscript = readTranscript(blankTranscriptPath);
    expect(blankTranscript.some((entry) => entry.method === "initialize")).toBe(true);
    expect(blankTranscript.some((entry) => entry.method === "session/new")).toBe(true);

    const onlyJunkTranscript = readTranscript(onlyJunkTranscriptPath);
    expect(onlyJunkTranscript.some((entry) => entry.method === "session/list")).toBe(true);
    expect(
      onlyJunkTranscript.some(
        (entry) => entry.method === "session/load" && transcriptEntryContains(entry, "junk-cache-session"),
      ),
      readFileIfExists(onlyJunkTranscriptPath),
    ).toBe(false);
    expect(
      onlyJunkTranscript.some(
        (entry) => entry.method === "session/load" && transcriptEntryContains(entry, "junk-package-name-session"),
      ),
      readFileIfExists(onlyJunkTranscriptPath),
    ).toBe(false);
    expect(onlyJunkTranscript.some((entry) => entry.method === "session/new")).toBe(false);

    const mixedTranscript = readTranscript(mixedTranscriptPath);
    expect(mixedTranscript.some((entry) => entry.method === "session/list")).toBe(true);
    expect(mixedTranscript.some((entry) => entry.method === "session/new")).toBe(false);
    expect(
      mixedTranscript.some(
        (entry) => entry.method === "session/load" && transcriptEntryContains(entry, "junk-cache-session"),
      ),
    ).toBe(false);
    expect(
      mixedTranscript.some(
        (entry) => entry.method === "session/load" && transcriptEntryContains(entry, "junk-package-name-session"),
      ),
    ).toBe(false);
    expect(
      mixedTranscript.some(
        (entry) => entry.method === "session/load" && transcriptEntryContains(entry, "real-history-session"),
      ),
    ).toBe(true);
  }, 35_000);

  test("suppresses config reload toast while a real ACP turn is active", () => {
    const root = tmpRoot();
    const home = path.join(root, "home");
    const workspace = path.join(root, "workspace");
    const relayDir = path.join(home, ".config", "relay");
    const configPath = path.join(relayDir, "config.toml");
    const transcriptPath = path.join(root, "acp-transcript.ndjson");
    const expectPath = path.join(root, "relay-active-reload.expect");
    const projectRoot = process.cwd();
    const relayEntry = path.resolve("src/index.ts");
    const acpAgent = path.resolve("test/real-e2e/acp-real-agent.ts");

    fs.mkdirSync(relayDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(
      configPath,
      `[notifications]\nsound_enabled = false\n\n[agents]\ndefault = "acp"\n\n[agents.runners.acp]\ncommand = "bun"\nargs = ["${tomlEscape(acpAgent)}", "${tomlEscape(transcriptPath)}"]\nprofile = "default"\n`,
      "utf-8",
    );
    fs.writeFileSync(
      expectPath,
      activeReloadExpectScript({ relayEntry, configPath, projectRoot, acpAgent, transcriptPath }),
      "utf-8",
    );

    const { XDG_CONFIG_HOME: _xdg2, ...cleanEnv2 } = process.env;
    const result = spawnSync("expect", [expectPath], {
      cwd: workspace,
      env: {
        ...cleanEnv2,
        HOME: home,
        TERM: "xterm-256color",
        RELAY_REAL_E2E_CONFIG: configPath,
      },
      encoding: "utf-8",
      timeout: 20_000,
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const transcript = readTranscript(transcriptPath);
    expect(transcript.some((entry) => entry.event === "prompt" && entry.text === "reload while running")).toBe(true);
  }, 25_000);
});

function expectScript({
  relayEntry,
  configPath,
  projectRoot,
  acpAgent,
  transcriptPath,
}: {
  relayEntry: string;
  configPath: string;
  projectRoot: string;
  acpAgent: string;
  transcriptPath: string;
}): string {
  const hotReloadConfig = `[notifications]
sound_enabled = true

[agents]
default = "acp"

[agents.runners.acp]
command = "bun"
args = ["${tomlEscape(acpAgent)}", "${tomlEscape(transcriptPath)}"]
profile = "default"
preferred_model = "model-b"
`;
  return `
set timeout 10
log_user 1
proc stop_relay {} {
  set relay_pid [exp_pid]
  send "\\003"
  after 50
  send "\\003"
  after 200
  catch { exec kill -TERM -$relay_pid }
  after 100
  catch { close }
  after 100
  catch { exec kill -KILL -$relay_pid }
}
cd ${tclQuote(projectRoot)}
spawn -noecho bun run --conditions=browser ${tclQuote(relayEntry)}
set first_pid [exp_pid]
expect "Connected to acp agent"
send "/models model-b\\r"
expect "Switched to model: model-b"
send "/new\\r"
expect "New thread"
set fp [open ${tclQuote(configPath)} w]
puts -nonewline $fp ${tclQuote(hotReloadConfig)}
close $fp
expect "Config reloaded"
stop_relay
exit 0
`;
}

function richRestoreExpectScript({ relayEntry, projectRoot }: { relayEntry: string; projectRoot: string }): string {
  return `
set timeout 10
log_user 1
proc stop_relay {} {
  set relay_pid [exp_pid]
  send "\\003"
  after 50
  send "\\003"
  after 200
  catch { exec kill -TERM -$relay_pid }
  after 100
  catch { close }
  after 100
  catch { exec kill -KILL -$relay_pid }
}
cd ${tclQuote(projectRoot)}
spawn -noecho bun run --conditions=browser ${tclQuote(relayEntry)} restored-rich-session
set saw_marker 0
set saw_line 0
set saw_indent 0
set deadline [expr {[clock seconds] + 10}]
while { !($saw_marker && $saw_line && $saw_indent) } {
  set remaining [expr {$deadline - [clock seconds]}]
  if { $remaining <= 0 } { stop_relay; exit 4 }
  set timeout $remaining
  expect {
    "Resumed ACP session: restored-rich-session" { set saw_marker 1 }
    "restored line one" { set saw_line 1 }
    "restored indent" { set saw_indent 1 }
    timeout { stop_relay; exit 4 }
  }
}
stop_relay
exit 0
`;
}

function cacheSessionHistoryExpectScript({
  relayEntry,
  projectRoot,
  onlyJunkTranscriptPath,
  mixedTranscriptPath,
}: {
  relayEntry: string;
  projectRoot: string;
  onlyJunkTranscriptPath: string;
  mixedTranscriptPath: string;
}): string {
  return `
set timeout 10
match_max 100000
log_user 1
proc stop_relay {} {
  set relay_pid [exp_pid]
  send "\\003"
  after 50
  send "\\003"
  after 200
  catch { exec kill -TERM -$relay_pid }
  after 100
  catch { close }
  after 100
  catch { exec kill -KILL -$relay_pid }
}
proc wait_for_file_text {path needle exit_code} {
  for {set i 0} {$i < 100} {incr i} {
    if {[file exists $path]} {
      set fp [open $path r]
      set data [read $fp]
      close $fp
      if {[string first $needle $data] >= 0} { return }
    }
    after 100
  }
  stop_relay
  exit $exit_code
}
cd ${tclQuote(projectRoot)}
spawn -noecho bun run --conditions=browser ${tclQuote(relayEntry)} --agent blank
expect -re "Connected to .* agent"
stop_relay
spawn -noecho bun run --conditions=browser ${tclQuote(relayEntry)} --agent onlyjunk --resume
set timeout 3
expect {
  "No ACP sessions available to resume." { after 200 }
  "junk-cache-session" { stop_relay; exit 2 }
  "junk-package-name-session" { stop_relay; exit 6 }
  "axiom-asumer" { stop_relay; exit 7 }
  timeout { wait_for_file_text ${tclQuote(onlyJunkTranscriptPath)} {"method":"session/list"} 3; after 200 }
}
stop_relay
spawn -noecho bun run --conditions=browser ${tclQuote(relayEntry)} --agent mixed --continue
expect {
  "Resumed ACP session: real-history-session" { after 200 }
  timeout { wait_for_file_text ${tclQuote(mixedTranscriptPath)} {"method":"session/load"} 5; after 200 }
}
stop_relay
exit 0
`;
}

function activeReloadExpectScript({
  relayEntry,
  configPath,
  projectRoot,
  acpAgent,
  transcriptPath,
}: {
  relayEntry: string;
  configPath: string;
  projectRoot: string;
  acpAgent: string;
  transcriptPath: string;
}): string {
  const hotReloadConfig = `[notifications]
sound_enabled = true

[agents]
default = "acp"

[agents.runners.acp]
command = "bun"
args = ["${tomlEscape(acpAgent)}", "${tomlEscape(transcriptPath)}"]
profile = "default"
`;
  return `
set timeout 10
log_user 1
proc stop_relay {} {
  set relay_pid [exp_pid]
  send "\\003"
  after 50
  send "\\003"
  after 200
  catch { exec kill -TERM -$relay_pid }
  after 100
  catch { close }
  after 100
  catch { exec kill -KILL -$relay_pid }
}
cd ${tclQuote(projectRoot)}
spawn -noecho bun run --conditions=browser ${tclQuote(relayEntry)}
set first_pid [exp_pid]
expect "Connected to acp agent"
send "reload while running\\r"
expect "Working"
set fp [open ${tclQuote(configPath)} w]
puts -nonewline $fp ${tclQuote(hotReloadConfig)}
close $fp
expect {
  -re "Config reloaded" { stop_relay; exit 2 }
  "done after reload" { stop_relay; exit 0 }
  timeout { stop_relay; exit 3 }
}
`;
}

function tomlEscape(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function tclQuote(value: string): string {
  return `{${value.replaceAll("\\", "\\\\").replaceAll("}", "\\}")}}`;
}

function getModelId(entry: Record<string, unknown>): unknown {
  const params = entry.params;
  if (!params || typeof params !== "object" || !("value" in params)) return undefined;
  return params.value;
}

function transcriptEntryContains(entry: Record<string, unknown>, text: string): boolean {
  return JSON.stringify(entry).includes(text);
}

function readFileIfExists(filePath: string): string {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : "<missing>";
}

function readTranscript(filePath: string): Array<Record<string, unknown>> {
  return fs
    .readFileSync(filePath, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
