import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import { Duration, Effect, Fiber } from "effect";
import { getConfigDir } from "../platform/paths";
import { AcpLaunchCommandMissingError, RelayError, errorMessage } from "../effect/errors";
import { createWriteStream, mkdirSync, type WriteStream } from "../platform/fs";
import { currentEnv } from "../platform/env";
import { spawn, type RelayChildProcess } from "../platform/process";
import { isoNow, nowMs } from "../platform/time";
import { getRelayLogger } from "../logging/logger";
import * as acp from "./sdk";
import {
  awaitProcessTermination,
  forceKillChildProcess,
  shouldDetachFromControllingTerminal,
  terminateChildProcess,
} from "./process-termination";
import type {
  AcpLaunchOptions,
  AcpTransport,
  AcpTransportCallbacks,
  AcpTransportConnection,
  AcpTransportError,
} from "./transport";

function createAcpLogPath(): string {
  const dir = path.join(getConfigDir(), "logs");
  mkdirSync(dir, { recursive: true });
  // effect-shape-allow: existing log timestamp until clock service migration.
  const stamp = isoNow().replace(/[:.]/g, "-");
  return path.join(dir, `acp-${stamp}.log`);
}

export class StdioAcpTransport implements AcpTransport {
  readonly kind = "stdio" as const;
  private process: RelayChildProcess | null = null;
  private stderrLog: WriteStream | null = null;
  private exitFiber: Fiber.Fiber<void, never> | null = null;
  private disposing = false;
  private exitNotified = false;

  constructor(
    private readonly opts: AcpLaunchOptions,
    private readonly callbacks: AcpTransportCallbacks,
  ) {}

  connect = Effect.fn("StdioAcpTransport.connect")(() =>
    Effect.gen({ self: this }, function* () {
      const command = String(this.opts.command ?? "").trim();
      if (!command)
        return yield* Effect.fail(new AcpLaunchCommandMissingError({ message: "ACP launch command is required" }));

      const args = this.opts.args ?? [];
      const cwd = this.opts.cwd;
      const shell = this.opts.shell ?? false;
      // Keep stdio ACP agents (and their descendants) from opening Relay's
      // controlling TTY for interactive auth prompts that would corrupt the TUI.
      const detachedFromTerminal = shouldDetachFromControllingTerminal();

      getRelayLogger().info("acp.spawn.start", { command: path.basename(command), cwd, detachedFromTerminal });
      const logPath = createAcpLogPath();
      yield* this.closeStderrLog;
      this.stderrLog = createWriteStream(logPath, { flags: "a" });
      getRelayLogger().info("acp.stderr.log.ready", { path: logPath });

      const proc = yield* Effect.try({
        try: () =>
          spawn(command, [...args], {
            cwd,
            stdio: ["pipe", "pipe", "pipe"],
            // effect-shape-allow: existing ACP launch environment inheritance until platform service migration.
            env: { ...currentEnv(), ...this.opts.env },
            shell,
            detached: detachedFromTerminal,
          }),
        catch: (cause) => {
          getRelayLogger().error("acp.spawn.error", { error: errorMessage(cause) });
          return new RelayError({ message: "Failed to spawn ACP agent process", cause });
        },
      });
      this.process = proc;
      this.disposing = false;
      this.exitNotified = false;

      let stderrBuffer = "";
      proc.stderr?.on("data", (chunk: Buffer) => {
        stderrBuffer += chunk.toString();
      });
      proc.stderr?.pipe(this.stderrLog);

      // Resolves when the agent's stderr stream ends, or after 500 ms.
      const waitForStartupOutput = proc.stderr
        ? () =>
            Effect.callback<void, never>((resume) => {
              const done = () => resume(Effect.void);
              proc.stderr!.once("end", done);
              proc.stderr!.once("error", done);
              return Effect.sync(() => {
                proc.stderr!.removeListener("end", done);
                proc.stderr!.removeListener("error", done);
              });
            }).pipe(Effect.race(Effect.sleep(Duration.millis(500))))
        : () => Effect.void;

      this.exitFiber = yield* Effect.forkDetach(
        // effect-shape-allow: Node child-process exit event bridge; scoped by dispose joining this fiber.
        Effect.callback<void, never>((resume) => {
          const notifyOnce = (event: Parameters<NonNullable<AcpTransportCallbacks["onProcessExit"]>>[0]) => {
            if (this.exitNotified) return;
            this.exitNotified = true;
            this.callbacks.onProcessExit?.(event);
            resume(Effect.void);
          };
          const completeExit = (code: number | null, signal: string | null) => {
            const expected = this.disposing;
            getRelayLogger().info("acp.process.exit", {
              code: code === null ? null : code,
              signal: signal === null ? null : signal,
              expected,
            });
            notifyOnce({
              code: code === null ? undefined : code,
              signal: signal === null ? undefined : signal,
              expected,
              reason: expected ? "dispose" : "exit",
              transport: "stdio",
            });
          };
          const completeError = (error: Error) => {
            const expected = this.disposing;
            getRelayLogger().error("acp.process.error", { error: error.message, expected });
            notifyOnce({
              expected,
              reason: expected ? "dispose" : "error",
              transport: "stdio",
              message: error.message,
            });
          };
          proc.once("exit", completeExit);
          proc.once("error", completeError);
          return Effect.sync(() => {
            proc.off("exit", completeExit);
            proc.off("error", completeError);
          });
        }),
      );

      const stream = acp.ndJsonStream(
        Writable.toWeb(proc.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(proc.stdout) as unknown as ReadableStream<Uint8Array>,
      );

      return {
        stream,
        diagnosticLogPath: logPath,
        waitForStartupOutput,
        startupOutput: () => stderrBuffer,
      } satisfies AcpTransportConnection;
    }),
  ) satisfies () => Effect.Effect<AcpTransportConnection, AcpTransportError>;

  private closeStderrLog = Effect.sync(() => {
    if (!this.stderrLog) return;
    this.process?.stderr?.unpipe(this.stderrLog);
    this.stderrLog.end();
    this.stderrLog = null;
  }).pipe(Effect.catch(() => Effect.void));

  /**
   * Immediately kills the ACP process, including its POSIX process group, as a shutdown fallback.
   */
  forceDispose = (): void => {
    const proc = this.process;
    this.disposing = true;
    if (!proc) return;

    forceKillChildProcess(proc);

    if (this.stderrLog) {
      try {
        proc.stderr.unpipe(this.stderrLog);
        this.stderrLog.end();
      } catch {}
      this.stderrLog = null;
    }
  };

  /**
   * Gracefully terminates the ACP process, escalating to a forced kill of its POSIX process group when needed.
   */
  dispose = Effect.fn("StdioAcpTransport.dispose")(() =>
    Effect.gen({ self: this }, function* () {
      const proc = this.process;
      const exitFiber = this.exitFiber;
      const terminationStartedAt = nowMs();
      this.disposing = true;

      yield* terminateChildProcess(proc);
      yield* this.closeStderrLog;
      // connect() sets process and exitFiber together, so both are present or neither is.
      if (proc && exitFiber) {
        yield* awaitProcessTermination(proc, exitFiber, terminationStartedAt);
      }

      this.process = null;
      this.exitFiber = null;
      this.disposing = false;
    }),
  );
}
