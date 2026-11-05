import type {
  LiveSessionControlResponse,
  LiveSessionInfo,
  LiveSessionInspection,
  LiveSessionWaitResult,
  SessionControlCliCommand,
} from "../core/live-sessions";
import { normalizeRelaySessionName } from "../core/threads";
import {
  discoverLiveSessionInstances,
  removeLiveSessionInstance,
  sendLiveSessionControlRequest,
  type LiveSessionInstanceManifest,
} from "./live-session-control";

interface LocatedSession {
  readonly manifest: LiveSessionInstanceManifest;
  readonly session: LiveSessionInfo;
}

export interface SessionControlCliOutput {
  readonly writeLine: (line: string) => void;
}

const consoleOutput: SessionControlCliOutput = {
  writeLine: (line) => console.log(line),
};

function throwResponseError(
  response: LiveSessionControlResponse,
): asserts response is Extract<LiveSessionControlResponse, { ok: true }> {
  if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`); // effect-shape-allow: CLI adapter reports control-plane failures to main.
}

function callerIdentity(): Record<string, unknown> {
  return {
    requesterSessionId: process.env.RELAY_SESSION_ID,
    requesterSessionName: process.env.RELAY_SESSION_NAME,
  };
}

async function sessionsForInstance(manifest: LiveSessionInstanceManifest): Promise<LocatedSession[]> {
  let response: LiveSessionControlResponse;
  try {
    response = await sendLiveSessionControlRequest(manifest, "session.list", callerIdentity());
  } catch {
    removeLiveSessionInstance(manifest);
    return [];
  }
  throwResponseError(response);
  const result = response.result as { sessions?: unknown };
  if (!Array.isArray(result.sessions)) return [];
  return (result.sessions as LiveSessionInfo[]).map((session) => ({ manifest, session }));
}

async function liveSessions(): Promise<LocatedSession[]> {
  const managedInstanceId = process.env.RELAY_SESSION_ID ? process.env.RELAY_INSTANCE_ID : undefined;
  const manifests = discoverLiveSessionInstances()
    .filter((manifest) => !managedInstanceId || manifest.instanceId === managedInstanceId)
    .map((manifest) => {
      if (!managedInstanceId || !process.env.RELAY_SESSION_ID) return manifest;
      const token = process.env.RELAY_CONTROL_TOKEN;
      if (!token) throw new Error("Managed Relay session is missing its scoped control token"); // effect-shape-allow: CLI reports invalid managed-session environment.
      return { ...manifest, token, actorSessionId: process.env.RELAY_SESSION_ID };
    });
  const groups = await Promise.all(manifests.map(sessionsForInstance));
  return groups.flat();
}

function locateTarget(sessions: readonly LocatedSession[], name: string): LocatedSession {
  const named = sessions.filter(({ session }) => session.name === name);
  if (named.length === 1) return named[0];
  if (named.length > 1) throw new Error(`Session name ${name} is active in multiple Relay instances`); // effect-shape-allow: CLI adapter reports ambiguous live names to main.
  throw new Error(`Live session ${name} was not found`); // effect-shape-allow: CLI adapter reports missing live targets to main.
}

export function formatSessionsTable(sessions: readonly LiveSessionInfo[]): string {
  const rows = [
    ["NAME", "STATUS", "ROLE", "RELATION", "TITLE", "CWD"],
    ...sessions.map((session) => [
      session.name,
      session.activity,
      session.role,
      session.relation ?? "-",
      session.title || "New thread",
      session.cwd,
    ]),
  ];
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
  return rows
    .map((row) =>
      row
        .map((value, column) => value.padEnd(widths[column]))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

function printSessions(located: readonly LocatedSession[], json: boolean, output: SessionControlCliOutput): void {
  const sessions = located.map(({ session }) => session);
  if (json) {
    output.writeLine(JSON.stringify({ version: 1, sessions }, null, 2));
    return;
  }
  if (sessions.length === 0) {
    output.writeLine("No live Relay sessions.");
    return;
  }
  output.writeLine(formatSessionsTable(sessions));
}

export function formatSessionInspection(inspection: LiveSessionInspection): string {
  const lines = [
    `Session: ${inspection.session.name}`,
    `Activity: ${inspection.session.activity}`,
    `Task state: ${inspection.session.taskState ?? "n/a"}`,
    `History: ${inspection.history}`,
  ];
  if (inspection.turns.length === 0) return [...lines, "", "No sanitized conversation turns."].join("\n");
  inspection.turns.forEach((turn, index) => {
    lines.push("", `Turn ${index + 1}`, `User: ${turn.user}`);
    for (const update of turn.updates ?? []) lines.push(`Update: ${update}`);
    if (turn.assistant) lines.push(`Assistant: ${turn.assistant}`);
  });
  return lines.join("\n");
}

function printInspection(result: unknown, json: boolean, output: SessionControlCliOutput): void {
  const inspection = result as LiveSessionInspection;
  output.writeLine(json ? JSON.stringify(inspection, null, 2) : formatSessionInspection(inspection));
}

function printWait(result: unknown, json: boolean, output: SessionControlCliOutput): void {
  if (json) {
    output.writeLine(JSON.stringify(result, null, 2));
    return;
  }
  const value = result as LiveSessionWaitResult;
  const name = value.session?.name ?? "child sessions";
  if (value.outcome === "terminal") {
    const terminalStatus =
      value.session?.taskState === "failed" || value.session?.taskState === "interrupted"
        ? value.session.taskState
        : "done";
    output.writeLine(`Completed: ${name} (${terminalStatus})`);
    if (value.delivery === "continuation") {
      if (value.result?.trim()) output.writeLine(value.result.trim());
      return;
    }
    output.writeLine("The child's complete final response follows; do not call relay inspect to retrieve it again.");
    if (value.result?.trim()) output.writeLine(`\n${value.result.trim()}`);
    return;
  }
  if (value.outcome === "message") {
    output.writeLine(`Message from: ${name}`);
    if (value.result?.trim()) output.writeLine(`\n${value.result.trim()}`);
    return;
  }
  if (value.outcome === "idle") {
    output.writeLine("No active or newly completed child sessions to wait for.");
    return;
  }
  output.writeLine(
    `Still running: ${name}. Do not inspect, poll, or redo delegated work. If this result remains blocking, run relay wait${value.session ? ` ${value.session.name}` : ""} again.`,
  );
}

function printSpawn(result: unknown, json: boolean, output: SessionControlCliOutput): void {
  if (json) {
    output.writeLine(JSON.stringify(result, null, 2));
    return;
  }
  const value = result as { session?: LiveSessionInfo };
  const name = value.session?.name ?? "child";
  output.writeLine(`Started child: ${name}`);
  output.writeLine("Do not duplicate its assigned task. Continue only explicitly non-overlapping work.");
  output.writeLine("Relay will deliver the result automatically; continue non-overlapping work or end this turn.");
  output.writeLine(`Only to keep this active turn blocked, run: relay wait ${name}`);
}

function printMutation(result: unknown, json: boolean, output: SessionControlCliOutput, targetName?: string): void {
  if (json) output.writeLine(JSON.stringify(result, null, 2));
  else if (result && typeof result === "object" && "delivery" in result) {
    const value = result as { delivery: string };
    output.writeLine(`${value.delivery}: ${targetName ?? "session"}`);
  } else if (result && typeof result === "object" && "session" in result) {
    const value = result as { session: LiveSessionInfo };
    output.writeLine(`${value.session.name}\t${value.session.title}`);
  } else output.writeLine("ok");
}

async function resolvedMessageText(text: string): Promise<string> {
  if (text !== "-") return text;
  return (await Bun.stdin.text()).trim();
}

export async function runSessionControlCli(
  command: SessionControlCliCommand,
  output: SessionControlCliOutput = consoleOutput,
): Promise<number> {
  const sessions = await liveSessions();
  if (command.kind === "list-sessions") {
    printSessions(sessions, command.json, output);
    return 0;
  }

  if (command.kind === "inspect-session") {
    const target = locateTarget(sessions, command.name);
    const response = await sendLiveSessionControlRequest(target.manifest, "session.inspect", {
      targetSessionId: target.session.id,
      history: command.history,
      ...callerIdentity(),
    });
    throwResponseError(response);
    printInspection(response.result, command.json, output);
    return 0;
  }

  if (command.kind === "wait-session") {
    const target = command.name ? locateTarget(sessions, command.name) : undefined;
    const callerSessionId = process.env.RELAY_SESSION_ID;
    const caller = callerSessionId
      ? sessions.find(({ session }) => session.id === callerSessionId)
      : sessions.length === 1
        ? sessions[0]
        : undefined;
    const manifest = target?.manifest ?? caller?.manifest;
    if (!manifest) throw new Error("relay wait without a child name requires a managed parent session"); // effect-shape-allow: CLI adapter reports ambiguous wait ownership.
    const response = await sendLiveSessionControlRequest(manifest, "session.wait", {
      ...(target ? { targetSessionId: target.session.id } : {}),
      timeoutMs: command.timeoutMs,
      ...callerIdentity(),
    });
    throwResponseError(response);
    printWait(response.result, command.json, output);
    return 0;
  }

  if (command.kind === "cancel-session") {
    const target = locateTarget(sessions, command.name);
    const response = await sendLiveSessionControlRequest(target.manifest, "session.cancel", {
      targetSessionId: target.session.id,
      ...callerIdentity(),
    });
    throwResponseError(response);
    printMutation(response.result, command.json, output, target.session.name);
    return 0;
  }

  if (command.kind === "message") {
    const target = locateTarget(sessions, command.name);
    const senderSessionId = process.env.RELAY_SESSION_ID;
    const senderSessionName = process.env.RELAY_SESSION_NAME;
    if (senderSessionId === target.session.id || senderSessionName === target.session.name) {
      throw new Error(`Session ${target.session.name} cannot message itself`); // effect-shape-allow: CLI adapter prevents self-directed agent loops.
    }
    const text = await resolvedMessageText(command.text);
    if (!text) throw new Error("Message must not be empty"); // effect-shape-allow: CLI adapter reports invalid stdin to main.
    const response = await sendLiveSessionControlRequest(target.manifest, "session.message", {
      targetSessionId: target.session.id,
      text,
      delivery: command.delivery,
      senderSessionId,
      senderSessionName,
    });
    throwResponseError(response);
    printMutation(response.result, command.json, output, target.session.name);
    return 0;
  }

  if (process.env.RELAY_SESSION_ROLE === "child" || process.env.RELAY_PARENT_SESSION_ID) {
    throw new Error("Child sessions cannot create sessions"); // effect-shape-allow: CLI adapter enforces the two-level live-session hierarchy.
  }
  if (!command.name) throw new Error("relay start session requires --name <verb-noun>"); // effect-shape-allow: CLI adapter reports missing agent-selected name.
  const sessionName = normalizeRelaySessionName(command.name);
  if (sessions.some(({ session }) => session.name === sessionName)) {
    throw new Error(`Session name ${sessionName} is already in use`); // effect-shape-allow: CLI adapter reports duplicate live names.
  }
  const parentName = command.parent ?? process.env.RELAY_SESSION_NAME;
  if (!parentName) throw new Error("relay start session requires --parent <name> outside a Relay-managed session"); // effect-shape-allow: CLI adapter reports missing inherited parent name.
  const parent = locateTarget(sessions, parentName);
  const response = await sendLiveSessionControlRequest(parent.manifest, "session.createChild", {
    parentSessionId: parent.session.id,
    ...callerIdentity(),
    task: command.task,
    name: sessionName,
    history: command.history,
    worktree: command.worktree,
    relation: "child",
    taskType: command.taskType,
    agent: command.agent,
    model: command.model,
    thinkingLevel: command.thinkingLevel,
  });
  throwResponseError(response);
  printSpawn(response.result, command.json, output);
  return 0;
}
