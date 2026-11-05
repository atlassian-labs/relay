#!/usr/bin/env bun
/**
 * relay - ACP-first terminal UI
 *
 * Entry point: parses CLI arguments and launches the TUI.
 */

import {
  addAgentRunner,
  getCacheDir,
  getChildSessionReminderTemplatePath,
  getConfigDir,
  getConfigLoadResult,
  listAvailableAgentNames,
  removeChildSessionTaskType,
  setChildSessionTaskType,
  setConfigValue,
} from "./config";
import { parseCli, type ParsedCli } from "./cli";
import { normalizeChildSessionTaskTypeName } from "./core/child-session-task-types";
import { initializeRelayLogger, relayLogLevelFromEnv } from "./logging/logger";
import { launchTUI } from "./ui/app";
import { launchWeb } from "./web/server";
import {
  checkRelayVersionUpdate,
  clearRelayVersionUpdateCache,
  compareVersions,
  getInstalledRelayVersion,
  postponeRelayVersionUpdate,
  runRelayVersionUpdate,
  type VersionUpdateInfo,
} from "./platform/version-check";
import { renderVersionUpdateCompleteMessage, runVersionUpdatePrompt } from "./platform/version-update-prompt";
import { runTelemetryConsentPrompt } from "./platform/telemetry-consent-prompt";
import { startupPromptSupported } from "./platform/startup-prompt";
import { IS_ATLAS_PLUGIN_INSTALL, VERSION, VERSION_LABEL } from "./version";
import { initializeTelemetry, TELEMETRY_CONSENT_REQUIRED, telemetryEnvDisabled } from "./telemetry";
import { readTelemetryConsent, telemetryConsentExists, writeTelemetryConsent } from "./telemetry-storage";
import { ExecInterruptedError, runExec } from "./exec";
import { runEffect } from "./effect/runtime";
import { runSessionControlCli } from "./platform/live-session-cli";

function printVersion() {
  console.log(VERSION_LABEL);
}

function exitWithError(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function printHelp() {
  const availableAgents = listAvailableAgentNames();
  const configuredHint =
    availableAgents.length > 0
      ? `Available agents: ${availableAgents.join(", ")}`
      : 'No agents configured yet. Run: relay add <name> "<command>" to add one.';

  console.log(`${VERSION_LABEL} - ACP-first terminal UI

Usage:
  relay [options]
  relay exec [options] [prompt]
  relay web [options]
  relay acp <command> [options]
  relay add <name> "<command>" [--profile <profile>]
  relay task-type set <name> --description <text> --keyword <keyword>... [--agent <agent>] [--model <model>] [--thinking-level <value>]
  relay task-type list [--json]
  relay task-type remove <name>
  relay list sessions [--json]
  relay inspect session <name> [--history <none|all|recent:N>] [--json]
  relay message <name> <message...> [--steer|--turn]
  relay wait [child-name] [--timeout <seconds>] [--json]
  relay cancel <child-name> [--json]
  relay start session <task...> --name <verb-noun> [--parent <name>] [--task-type <name>] [--agent <agent>] [--model <model>] [--thinking-level <value>] [--history <none|all|recent:N>]

Options:
  --agent, -a <agent>          Configured agent runner to use
  --model, -m <model>          Model override for non-interactive exec mode
  --thinking-level, -t <value> Thinking/reasoning level value for this launch
  --prompt, -p <text...>       Submit an initial prompt on launch; words are joined until the next option
  --continue, -c               Continue the most recent session
  --resume, -r [session-id]    Resume a session by ID, or open the picker
  --default-renderer           Force the generic tool renderer for this run
  --yoloo                      Client-side auto-approval for all requests, including unsafe commands
  --web                        Launch the browser dashboard instead of the TUI
  --host <host>                Web dashboard host (default: 127.0.0.1)
  --port <port>                Web dashboard port (default: random available port)
  --no-open                    Do not open the browser automatically for web mode
  --version, -v                Show version
  --help, -h                   Show this help

Subcommands:
  add <name> "<command>"     Add an agent runner to ~/.config/relay/config.toml
      --profile <profile>    Optional profile: alta, codex, claude, rovodev, default
                             Defaults to the agent name, falling back to default if unknown
                             Example: relay add alta "atlas alta agent run" --profile alta
  exec [prompt]              Run one ACP prompt without starting a UI; use - to read stdin
                             Supports --agent, --model, and --thinking-level
  web                        Start Relay as a local web server and open the dashboard
  acp <command>              Launch an inline ACP server command instead of a configured runner
                             Example: relay acp "atlas alta agent run"
  list sessions              List live sessions across running Relay instances
  inspect session <name>     Read sanitized recent turns from a live session
  message <name> <text...>   Steer a running session or submit/queue a turn
  task-type set/list/remove  Manage child-session task types in ~/.config/relay/config.toml
  start session <task...>    Start a named child; supports --task-type, --agent, --model, and --thinking-level
  prompt overrides           Optional files under ~/.config/relay/prompts/:
                             child-session-collaboration.md, handoff.md, review.md,
                             relay-plugins.md, and relay-themes.md

${configuredHint}

In the TUI:
  /new       Start a new thread
  /threads   Open the thread sidebar
  /resume    Resume a previous session
  /diff      Show working tree diff
  /models    List or switch models
  /effort    Set reasoning effort
  /mode      Switch session mode
  /settings  Open interactive settings
  /plugins   Discover, enable, disable, and reload plugins
  /yoloo     Client-side auto-approval for all requests, including unsafe commands
  /reload    Reload Relay plugins
  /copy      Copy the last response to clipboard
  /quit      Quit

Triggers and shortcuts:
  /          Slash command autocomplete
  @path      Attach file or directory context with autocomplete
  paste      Paste text, file paths, and images into the prompt
  ctrl/opt+v Paste an image from the OS clipboard
  !cmd       Run a local shell command
  !!cmd      Run a local shell command and attach the output to the next prompt
  ?          Show keyboard shortcuts
`);
}

function installedVersionSatisfiesUpdate(installedVersion: string | null, update: VersionUpdateInfo): boolean {
  if (!installedVersion) return false;
  const comparison = compareVersions(installedVersion, update.version);
  return comparison !== null && comparison >= 0;
}

async function postponeFailedRelayUpdate(
  update: VersionUpdateInfo,
  cacheDir: string,
  installedVersion: string | null = null,
): Promise<void> {
  await postponeRelayVersionUpdate(
    { ...update, currentVersion: installedVersion ?? update.currentVersion },
    { cacheDir },
  );
  console.error("Relay update did not complete. The update prompt will be postponed for 6 hours.");
}

async function main() {
  let parsed: ParsedCli;

  try {
    parsed = parseCli(process.argv.slice(2));
  } catch (e) {
    console.error(`Error: ${e}`);
    process.exit(1);
  }

  const configLoad = getConfigLoadResult();
  const configDir = getConfigDir();
  const cacheDir = getCacheDir();
  process.env.RELAY_CONFIG_DIR = configDir;
  process.env.RELAY_CACHE_DIR = cacheDir;

  const envLogLevel = relayLogLevelFromEnv();
  const logger = initializeRelayLogger({
    configDir,
    level: envLogLevel ?? configLoad.config.logging.level,
  });
  if (configLoad.parseError) {
    logger.error("config.load.error", {
      filePath: configLoad.filePath,
      error: configLoad.parseError.message,
      warnings: configLoad.warnings,
    });
  }

  // A hand-edited `[telemetry] analytics_enabled` in config.toml wins over the
  // consent file that the telemetry policy reads. Reconciling before telemetry
  // starts makes such an edit take effect on this run.
  if (TELEMETRY_CONSENT_REQUIRED && telemetryConsentExists(configDir)) {
    const configEnabled = configLoad.config.telemetry.analytics_enabled;
    if (configEnabled !== (readTelemetryConsent(configDir) === true)) {
      writeTelemetryConsent(configDir, configEnabled);
      logger.info("telemetry.consent.sync", { enabled: configEnabled, source: "config" });
    }
  }

  initializeTelemetry(configDir);

  logger.info("relay.start", {
    version: VERSION,
    cwd: process.cwd(),
    configDir,
    cacheDir,
    configFile: configLoad.filePath,
    configParseError: configLoad.parseError?.message ?? null,
    configWarningCount: configLoad.warnings.length,
    mode: parsed.exec ? "exec" : parsed.web ? "web" : "tui",
    agent: parsed.args.values.agent ?? null,
    model: parsed.args.values.model ?? null,
    thinkingLevel: parsed.args.values["thinking-level"] ?? null,
    yoloo: Boolean(parsed.args.values.yoloo),
    hasInlineAcpCommand: parsed.acpCommand !== undefined,
    hasInitialPrompt: parsed.prompt !== undefined,
    resume: Boolean(parsed.args.values.resume),
    continueSession: Boolean(parsed.args.values.continue),
  });

  const args = parsed.args;

  if (args.values.version) {
    printVersion();
    process.exit(0);
  }

  if (args.values.help) {
    printHelp();
    process.exit(0);
  }

  if (parsed.taskTypeCommand) {
    try {
      if (parsed.taskTypeCommand.kind === "set") {
        setChildSessionTaskType(parsed.taskTypeCommand);
        console.log(`Task type "${parsed.taskTypeCommand.name.trim().toLowerCase()}" saved.`);
        console.log(`Reminder template: ${getChildSessionReminderTemplatePath()}`);
      } else if (parsed.taskTypeCommand.kind === "remove") {
        removeChildSessionTaskType(parsed.taskTypeCommand.name);
        console.log(`Task type "${parsed.taskTypeCommand.name.trim().toLowerCase()}" removed.`);
      } else {
        const taskTypes = Object.values(configLoad.config.task_types);
        if (parsed.taskTypeCommand.json) {
          console.log(JSON.stringify({ version: 1, taskTypes }, null, 2));
        } else if (taskTypes.length === 0) {
          console.log("No child-session task types configured.");
        } else {
          for (const taskType of taskTypes) {
            const settings = [
              taskType.agent ? `agent=${taskType.agent}` : "",
              taskType.model ? `model=${taskType.model}` : "",
              taskType.thinkingLevel ? `thinking=${taskType.thinkingLevel}` : "",
            ]
              .filter(Boolean)
              .join(" ");
            console.log(`${taskType.name}\t${settings}\t${taskType.keywords.join(", ")}\t${taskType.description}`);
          }
        }
      }
    } catch (error) {
      exitWithError(error instanceof Error ? error.message : String(error));
    }
    process.exit(0);
  }

  if (parsed.sessionControl) {
    let sessionControl = parsed.sessionControl;
    if (sessionControl.kind === "start-session" && sessionControl.taskType) {
      const taskTypeName = normalizeChildSessionTaskTypeName(sessionControl.taskType);
      const taskType = configLoad.config.task_types[taskTypeName];
      if (!taskType) {
        const available = Object.keys(configLoad.config.task_types);
        exitWithError(
          `Unknown task type ${taskTypeName}.${available.length > 0 ? ` Available task types: ${available.join(", ")}` : " No task types are configured."}`,
        );
      }
      sessionControl = {
        ...sessionControl,
        taskType: taskTypeName,
        agent: sessionControl.agent?.trim() || taskType.agent,
        model: sessionControl.model?.trim() || taskType.model,
        thinkingLevel: sessionControl.thinkingLevel?.trim() || taskType.thinkingLevel,
      };
    }
    const exitCode = await runSessionControlCli(sessionControl);
    process.exit(exitCode);
  }

  if (parsed.addArgs !== undefined) {
    const { agentName, commandString, profile } = parsed.addArgs;
    if (!agentName || !commandString || !commandString.trim()) {
      console.error(
        'Error: add requires a name and a quoted command, for example: relay add my-agent "atlas alta agent run my-pkg" --profile alta',
      );
      process.exit(1);
    }
    const [command, ...cmdTokens] = commandString.trim().split(/\s+/);
    if (!command) {
      console.error("Error: command must not be empty");
      process.exit(1);
    }
    const selectedProfile = profile?.trim() || agentName;
    try {
      addAgentRunner(agentName, command, cmdTokens, selectedProfile);
      console.log(`Agent "${agentName}" added with profile "${selectedProfile}". Run: relay --agent ${agentName}`);
    } catch (e) {
      console.error(`Error: ${e instanceof Error ? e.message : e}`);
      process.exit(1);
    }
    process.exit(0);
  }

  if (parsed.acpCommand !== undefined && parsed.acpCommand.length === 0) {
    console.error('Error: acp requires a command, for example: relay acp "atlas alta agent run"');
    process.exit(1);
  }

  const cwd = process.cwd();

  if (parsed.exec) {
    if (parsed.web) exitWithError("exec and web modes cannot be combined");
    if (args.values.yoloo) exitWithError("--yoloo is currently supported only in TUI mode");
    if (args.values.resume || args.values.continue) exitWithError("exec does not yet support --resume or --continue");
    if (parsed.prompt !== undefined && args.positionals.length > 0) {
      exitWithError("Provide the exec prompt either positionally or with --prompt, not both");
    }

    let execPrompt = parsed.prompt ?? args.positionals.join(" ");
    if (execPrompt === "-" || (!execPrompt && !process.stdin.isTTY)) execPrompt = await Bun.stdin.text();
    if (!execPrompt.trim()) exitWithError("exec requires a prompt argument or piped stdin");

    await runEffect(
      runExec({
        cwd,
        prompt: execPrompt,
        agent: args.values.agent as string | undefined,
        acpCommand: parsed.acpCommand,
        model: args.values.model as string | undefined,
        thinkingLevel: args.values["thinking-level"] as string | undefined,
      }),
    );
    process.exit(0);
  }

  if (args.values.model) exitWithError("--model is currently supported only in exec mode");

  const positionalResumeSessionId = args.positionals[0];
  const wantsResumeSessionId = typeof positionalResumeSessionId === "string" && positionalResumeSessionId.length > 0;
  const rawPort = args.values.port as string | undefined;
  let port: number | undefined;
  if (rawPort !== undefined) {
    const parsedPort = Number(rawPort);
    if (!Number.isInteger(parsedPort) || parsedPort < 0 || parsedPort > 65535) {
      console.error(`Error: --port must be a number from 0 to 65535`);
      process.exit(1);
    }
    port = parsedPort;
  }

  if (parsed.web) {
    if (args.values.yoloo) exitWithError("--yoloo is currently supported only in TUI mode");
    await launchWeb({
      cwd,
      agent: args.values.agent as string | undefined,
      acpCommand: parsed.acpCommand,
      defaultRenderer: args.values["default-renderer"] as boolean,
      resume: (args.values.resume as boolean) || wantsResumeSessionId,
      resumeSessionId: wantsResumeSessionId ? positionalResumeSessionId : undefined,
      continueSession: args.values.continue as boolean,
      initialPrompt: parsed.prompt,
      thinkingLevel: args.values["thinking-level"] as string | undefined,
      host: args.values.host as string | undefined,
      port,
      open: !(args.values["no-open"] as boolean),
    });
    return;
  }

  // First-run telemetry consent. Only builds that require consent ask, and only
  // on an interactive start: a non-TTY or CI run records no answer, so the
  // question is asked on the first interactive run instead. Users who already
  // opted out with DO_NOT_TRACK or RELAY_TELEMETRY_DISABLED are never asked.
  // The answer takes effect on the next start, like the /settings toggle.
  if (
    TELEMETRY_CONSENT_REQUIRED &&
    !telemetryConsentExists(configDir) &&
    !telemetryEnvDisabled() &&
    startupPromptSupported()
  ) {
    const enabled = (await runTelemetryConsentPrompt()) === "yes";
    writeTelemetryConsent(configDir, enabled);
    try {
      setConfigValue("telemetry.analytics_enabled", enabled);
    } catch (err) {
      // The consent file is the source of truth; a failed config write must not
      // block startup. effect-shape-allow: startup wiring, not an Effect.
      logger.warn("telemetry.consent.config_sync_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    logger.info("telemetry.consent", { enabled });
  }

  const skipUpdatePrompt = parsed.prompt !== undefined && parsed.prompt.trim().length > 0;
  if (IS_ATLAS_PLUGIN_INSTALL && !skipUpdatePrompt) {
    const update = await checkRelayVersionUpdate({ cacheDir });
    if (update) {
      const selection = await runVersionUpdatePrompt(update);
      if (selection === "update") {
        const exitCode = await runRelayVersionUpdate();
        if (exitCode !== 0) {
          await postponeFailedRelayUpdate(update, cacheDir);
        } else {
          const installedVersion = await getInstalledRelayVersion();
          if (!installedVersionSatisfiesUpdate(installedVersion, update)) {
            await postponeFailedRelayUpdate(update, cacheDir, installedVersion);
          } else {
            await clearRelayVersionUpdateCache(cacheDir);
            console.log(renderVersionUpdateCompleteMessage(installedVersion ?? update.version));
            process.exit(0);
          }
        }
      }
    }
  }

  await launchTUI({
    cwd,
    agent: args.values.agent as string | undefined,
    acpCommand: parsed.acpCommand,
    defaultRenderer: args.values["default-renderer"] as boolean,
    yolo: args.values.yoloo as boolean,
    resume: (args.values.resume as boolean) || wantsResumeSessionId,
    resumeSessionId: wantsResumeSessionId ? positionalResumeSessionId : undefined,
    continueSession: args.values.continue as boolean,
    initialPrompt: parsed.prompt,
    thinkingLevel: args.values["thinking-level"] as string | undefined,
  });
}

main().catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(err instanceof ExecInterruptedError ? 130 : 1);
});
