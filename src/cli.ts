import { Command, Option, type OptionValues } from "commander";
import {
  LIVE_SESSION_WAIT_DEFAULT_MS,
  LIVE_SESSION_WAIT_MAX_MS,
  LIVE_SESSION_WAIT_MIN_MS,
  parseChildSessionHistory,
  type SessionControlCliCommand,
} from "./core/live-sessions";

interface RelayCliValues extends OptionValues {
  agent?: string;
  model?: string;
  thinkingLevel?: string;
  prompt?: string[];
  defaultRenderer: boolean;
  yoloo: boolean;
  web: boolean;
  host?: string;
  port?: string;
  open: boolean;
  continue: boolean;
  resume: boolean;
  version: boolean;
  help: boolean;
}

export interface ParsedCliArgs {
  readonly values: {
    readonly agent?: string;
    readonly model?: string;
    readonly "thinking-level"?: string;
    readonly prompt?: string;
    readonly "default-renderer": boolean;
    readonly yoloo: boolean;
    readonly web: boolean;
    readonly host?: string;
    readonly port?: string;
    readonly "no-open": boolean;
    readonly continue: boolean;
    readonly resume: boolean;
    readonly version: boolean;
    readonly help: boolean;
  };
  readonly positionals: string[];
}

export interface AddAgentCliCommand {
  readonly agentName: string;
  readonly commandString: string;
  readonly profile?: string;
}

export type TaskTypeCliCommand =
  | {
      readonly kind: "set";
      readonly name: string;
      readonly description: string;
      readonly keywords: readonly string[];
      readonly agent?: string;
      readonly model?: string;
      readonly thinkingLevel?: string;
    }
  | { readonly kind: "list"; readonly json: boolean }
  | { readonly kind: "remove"; readonly name: string };

export type ParsedCli = {
  args: ParsedCliArgs;
  acpCommand?: string;
  addArgs?: AddAgentCliCommand;
  taskTypeCommand?: TaskTypeCliCommand;
  sessionControl?: SessionControlCliCommand;
  prompt?: string;
  exec: boolean;
  web: boolean;
};

function command(name: string): Command {
  return new Command(name)
    .helpOption(false)
    .helpCommand(false)
    .allowExcessArguments(false)
    .configureOutput({ writeErr: () => undefined })
    .exitOverride();
}

function textFromVariadic(value: readonly string[]): string {
  return value.join(" ").trim();
}

function parseLiveSessionWaitSeconds(value: string): number {
  const seconds = Number(value);
  const timeoutMs = seconds * 1_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < LIVE_SESSION_WAIT_MIN_MS || timeoutMs > LIVE_SESSION_WAIT_MAX_MS) {
    // effect-shape-allow: CLI parser reports invalid wait bounds.
    throw new Error(
      `--timeout must be between ${LIVE_SESSION_WAIT_MIN_MS / 1_000} and ${LIVE_SESSION_WAIT_MAX_MS / 1_000} seconds`,
    ); // effect-shape-allow: CLI parser reports invalid wait bounds.
  }
  return Math.round(timeoutMs);
}

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function explicitOptionValues(command: Command): Partial<RelayCliValues> {
  return Object.fromEntries(
    command.options
      .filter((option) => command.getOptionValueSource(option.attributeName()) === "cli")
      .map((option) => [option.attributeName(), command.getOptionValue(option.attributeName())]),
  );
}

export function parseCli(rawArgs: string[]): ParsedCli {
  let acpCommand: string | undefined;
  let addArgs: AddAgentCliCommand | undefined;
  let taskTypeCommand: TaskTypeCliCommand | undefined;
  let sessionControl: SessionControlCliCommand | undefined;
  let positionals: string[] = [];
  let exec = false;
  let webSubcommand = false;
  let subcommandOptions: Partial<RelayCliValues> = {};

  const program = command("relay")
    .enablePositionalOptions()
    .argument("[positionals...]")
    .option("-a, --agent <agent>")
    .option("-m, --model <model>")
    .option("-t, --thinking-level <value>")
    .option("-p, --prompt <text...>")
    .option("--default-renderer", "", false)
    .option("--yoloo", "", false)
    .option("--web", "", false)
    .option("--host <host>")
    .option("--port <port>")
    .option("--no-open", "")
    .option("-c, --continue", "", false)
    .option("-r, --resume", "", false)
    .option("-v, --version", "", false)
    .option("-h, --help", "", false)
    .action((values: string[]) => {
      positionals = values;
    });

  program
    .addCommand(
      command("exec")
        .argument("[prompt...]")
        .option("-a, --agent <agent>")
        .option("-m, --model <model>")
        .option("-t, --thinking-level <value>")
        .option("-p, --prompt <text...>")
        .option("--default-renderer")
        .option("--yoloo")
        .option("-c, --continue")
        .option("-r, --resume")
        .action((prompt: string[], _options: OptionValues, actionCommand: Command) => {
          exec = true;
          positionals = prompt;
          subcommandOptions = explicitOptionValues(actionCommand);
        }),
    )
    .addCommand(
      command("web")
        .option("-a, --agent <agent>")
        .option("-t, --thinking-level <value>")
        .option("-p, --prompt <text...>")
        .option("--default-renderer")
        .option("--yoloo")
        .option("--host <host>")
        .option("--port <port>")
        .option("--no-open")
        .option("-c, --continue")
        .option("-r, --resume")
        .action((_options: OptionValues, actionCommand: Command) => {
          webSubcommand = true;
          subcommandOptions = explicitOptionValues(actionCommand);
        }),
    )
    .addCommand(
      command("acp")
        .allowUnknownOption(true)
        .allowExcessArguments(true)
        .passThroughOptions()
        .argument("<command...>")
        .action((parts: string[]) => {
          acpCommand = textFromVariadic(parts);
        }),
    )
    .addCommand(
      command("add")
        .argument("<name>")
        .argument("<command>")
        .option("--profile <profile>")
        .option("--renderer <profile>")
        .action((name: string, commandString: string, options: { profile?: string; renderer?: string }) => {
          const profile = options.profile ?? options.renderer;
          addArgs = { agentName: name, commandString, ...(profile ? { profile } : {}) };
        }),
    );

  const taskType = command("task-type");
  taskType
    .addCommand(
      command("set")
        .argument("<name>")
        .requiredOption("--description <description>")
        .option("--keyword <keyword>", "", collectOption, [])
        .option("--agent <agent>")
        .option("--model <model>")
        .option("--thinking-level <value>")
        .action(
          (
            name: string,
            options: {
              description: string;
              keyword: string[];
              agent?: string;
              model?: string;
              thinkingLevel?: string;
            },
          ) => {
            taskTypeCommand = {
              kind: "set",
              name,
              description: options.description,
              keywords: options.keyword,
              agent: options.agent,
              model: options.model,
              thinkingLevel: options.thinkingLevel,
            };
          },
        ),
    )
    .addCommand(
      command("list")
        .option("--json", "", false)
        .action((options: { json: boolean }) => {
          taskTypeCommand = { kind: "list", json: options.json };
        }),
    )
    .addCommand(
      command("remove")
        .argument("<name>")
        .action((name: string) => {
          taskTypeCommand = { kind: "remove", name };
        }),
    )
    .action(() => {
      throw new Error("Usage: relay task-type <set|list|remove>"); // effect-shape-allow: CLI parser reports usage errors through main.
    });
  program.addCommand(taskType);

  const list = command("list");
  list
    .addCommand(
      command("sessions")
        .option("--json", "", false)
        .action((options: { json: boolean }) => {
          sessionControl = { kind: "list-sessions", json: options.json };
        }),
    )
    .action(() => {
      throw new Error("Usage: relay list sessions [--json]"); // effect-shape-allow: CLI parser reports usage errors through main.
    });
  program.addCommand(list);

  const inspect = command("inspect");
  inspect
    .addCommand(
      command("session")
        .argument("<name>")
        .option("--history <none|all|recent:N>", "", "recent:3")
        .option("--json", "", false)
        .action((name: string, options: { history: string; json: boolean }) => {
          sessionControl = {
            kind: "inspect-session",
            name,
            history: parseChildSessionHistory(options.history),
            json: options.json,
          };
        }),
    )
    .action(() => {
      throw new Error("Usage: relay inspect session <name> [--history <none|all|recent:N>] [--json]"); // effect-shape-allow: CLI parser reports usage errors through main.
    });
  program.addCommand(inspect);

  program.addCommand(
    command("message")
      .argument("<name>")
      .argument("<text...>")
      .addOption(new Option("--steer").conflicts(["turn", "next"]))
      .addOption(new Option("--turn").conflicts(["steer", "next"]))
      .addOption(new Option("--next").conflicts(["steer", "turn"]).hideHelp())
      .option("--json", "", false)
      .action(
        (name: string, text: string[], options: { steer?: boolean; turn?: boolean; next?: boolean; json: boolean }) => {
          sessionControl = {
            kind: "message",
            name,
            text: textFromVariadic(text),
            delivery: options.steer ? "steer" : options.turn || options.next ? "turn" : "mailbox",
            json: options.json,
          };
        },
      ),
  );

  program.addCommand(
    command("wait")
      .argument("[name]")
      .option("--timeout <seconds>", "", String(LIVE_SESSION_WAIT_DEFAULT_MS / 1_000))
      .option("--json", "", false)
      .action((name: string | undefined, options: { timeout: string; json: boolean }) => {
        sessionControl = {
          kind: "wait-session",
          ...(name ? { name } : {}),
          timeoutMs: parseLiveSessionWaitSeconds(options.timeout),
          json: options.json,
        };
      }),
  );

  program.addCommand(
    command("cancel")
      .argument("<name>")
      .option("--json", "", false)
      .action((name: string, options: { json: boolean }) => {
        sessionControl = { kind: "cancel-session", name, json: options.json };
      }),
  );

  const start = command("start");
  start
    .addCommand(
      command("session")
        .argument("<task...>")
        .option("--parent <name>")
        .requiredOption("--name <verb-noun>")
        .option("--history <none|all|recent:N>", "", "none")
        .option("--worktree", "", false)
        .option("--task-type <task-type>")
        .option("--agent <agent>")
        .option("--model <model>")
        .option("--thinking-level <value>")
        .option("--json", "", false)
        .action(
          (
            task: string[],
            options: {
              parent?: string;
              name?: string;
              history: string;
              worktree: boolean;
              taskType?: string;
              agent?: string;
              model?: string;
              thinkingLevel?: string;
              json: boolean;
            },
          ) => {
            sessionControl = {
              kind: "start-session",
              task: textFromVariadic(task),
              parent: options.parent,
              name: options.name,
              history: parseChildSessionHistory(options.history),
              worktree: options.worktree,
              taskType: options.taskType,
              agent: options.agent,
              model: options.model,
              thinkingLevel: options.thinkingLevel,
              json: options.json,
            };
          },
        ),
    )
    .action(() => {
      throw new Error( // effect-shape-allow: CLI parser reports usage errors through main.
        "Usage: relay start session <task...> --name <verb-noun> [--parent <name>] [--task-type <name>] [--agent <agent>] [--model <model>] [--thinking-level <value>] [--history <none|all|recent:N>]",
      );
    });
  program.addCommand(start);

  program.parse(rawArgs, { from: "user" });
  const options = { ...program.opts<RelayCliValues>(), ...subcommandOptions };
  const prompt = options.prompt ? textFromVariadic(options.prompt) : undefined;
  const args: ParsedCliArgs = {
    values: {
      agent: options.agent,
      model: options.model,
      "thinking-level": options.thinkingLevel,
      prompt,
      "default-renderer": options.defaultRenderer,
      yoloo: options.yoloo,
      web: options.web,
      host: options.host,
      port: options.port,
      "no-open": !options.open,
      continue: options.continue,
      resume: options.resume,
      version: options.version,
      help: options.help,
    },
    positionals,
  };

  return {
    args,
    acpCommand,
    addArgs,
    taskTypeCommand,
    sessionControl,
    prompt,
    exec,
    web: webSubcommand || options.web,
  };
}
