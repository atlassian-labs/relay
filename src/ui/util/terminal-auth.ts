import type { RelayAuthTerminalCommand } from "../../acp/capabilities";
import { errorMessage } from "../../effect/errors";
import { currentEnv } from "../../platform/env";
import { spawn } from "../../platform/process";

export interface TerminalAuthCommandOptions {
  readonly cwd: string;
}

export interface TerminalAuthCommandResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

function displayCommand(command: RelayAuthTerminalCommand): string {
  return [command.command, ...command.args].join(" ");
}

export function runTerminalAuthCommand(
  command: RelayAuthTerminalCommand,
  options: TerminalAuthCommandOptions,
): Promise<TerminalAuthCommandResult> {
  // effect-shape-allow: terminal auth bridges child process events into a Promise for UI suspend/resume.
  return new Promise<TerminalAuthCommandResult>((resolve, reject) => {
    const proc = spawn(command.command, command.args, {
      cwd: options.cwd,
      env: { ...currentEnv(), ...command.env },
      stdio: "inherit",
    });

    proc.on("error", (cause) => {
      reject(new Error(`Failed to start auth command ${displayCommand(command)}: ${errorMessage(cause)}`));
    });

    proc.on("close", (exitCode, signal) => {
      if (exitCode === 0) {
        resolve({ exitCode, signal });
        return;
      }
      if (signal) {
        reject(new Error(`Auth command ${displayCommand(command)} exited from signal ${signal}`));
        return;
      }
      reject(new Error(`Auth command ${displayCommand(command)} exited with code ${exitCode ?? "unknown"}`));
    });
  });
}
