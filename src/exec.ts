import { Effect, Option } from "effect";
import { AcpClient, type AcpClientCallbacks, type AcpClientOptions, type AcpSessionResult } from "./acp/client";
import {
  acpClientOptionsForAgent,
  AGENT_CONNECT_TIMEOUT_MS,
  missingAcpLaunchAgentErrorMessage,
  resolveAcpLaunchAgent,
  resolveAgentBehaviorProfileForLaunchAgent,
} from "./application/acp-orchestration";
import {
  availableModelIdsFromSessionResult,
  availableThinkingLevelsFromSessionResult,
  currentModelIdFromSessionResult,
  currentThinkingLevelFromSessionResult,
  modelConfigIdFromSessionResult,
  thinkingConfigIdFromSessionResult,
} from "./acp/session-config";
import { acpThreadEventFromSessionUpdate, textFromAcpThreadContent } from "./acp/thread-events";
import { getAgentPreferredModel, getAgentPreferredThinkingLevel } from "./config";
import { ApprovalResponse } from "./core/events";
import { parseThinkingLevel } from "./core/thinking";
import { RelayError } from "./effect/errors";
import { flushTelemetry } from "./telemetry";
import { flushTelemetryBeforeExit } from "./telemetry-shutdown";

export interface ExecOptions {
  readonly cwd: string;
  readonly prompt: string;
  readonly agent?: string;
  readonly acpCommand?: string;
  readonly model?: string;
  readonly thinkingLevel?: string;
}

export interface ExecDependencies {
  readonly createClient?: (callbacks: AcpClientCallbacks, options: AcpClientOptions) => AcpClient;
  readonly writeStdout?: (text: string) => void;
  readonly writeStderr?: (text: string) => void;
  readonly flushTelemetry?: () => Promise<void>;
  readonly installSignalHandlers?: boolean;
}

export class ExecInterruptedError extends Error {
  readonly signal: NodeJS.Signals;

  constructor(signal: NodeJS.Signals) {
    super(`Interrupted by ${signal}`);
    this.name = "ExecInterruptedError";
    this.signal = signal;
  }
}

function requestedValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function execError(message: string, cause?: unknown): RelayError {
  return new RelayError({ message, cause });
}

function unavailableValueError(kind: string, value: string, available: readonly string[]): RelayError {
  const suffix = available.length > 0 ? ` Available values: ${available.join(", ")}` : "";
  return execError(`${kind} "${value}" is not available.${suffix}`);
}

function mergeSessionResult(previous: AcpSessionResult, next: AcpSessionResult): AcpSessionResult {
  return {
    ...previous,
    ...next,
    configOptions: next.configOptions ?? previous.configOptions,
    models: next.models ?? previous.models,
  };
}

const applyModel = Effect.fn("Exec.applyModel")(function* (
  client: AcpClient,
  sessionResult: AcpSessionResult,
  model: string,
) {
  const configId = modelConfigIdFromSessionResult(sessionResult);
  if (!configId) return yield* Effect.fail(execError("This agent does not advertise model selection."));
  const available = availableModelIdsFromSessionResult(sessionResult);
  if (available.length > 0 && !available.includes(model)) {
    return yield* Effect.fail(unavailableValueError("Model", model, available));
  }
  if (currentModelIdFromSessionResult(sessionResult) === model) return sessionResult;
  const next = yield* client.setSessionModelEffect(model, configId, sessionResult.sessionId);
  return mergeSessionResult(sessionResult, next);
});

const applyThinkingLevel = Effect.fn("Exec.applyThinkingLevel")(function* (
  client: AcpClient,
  sessionResult: AcpSessionResult,
  thinkingLevel: string,
) {
  const configId = thinkingConfigIdFromSessionResult(sessionResult);
  if (!configId) {
    return yield* Effect.fail(execError("This agent does not advertise thinking/reasoning level selection."));
  }
  const available = availableThinkingLevelsFromSessionResult(sessionResult);
  if (available.length > 0 && !available.includes(thinkingLevel)) {
    return yield* Effect.fail(unavailableValueError("Thinking level", thinkingLevel, available));
  }
  if (currentThinkingLevelFromSessionResult(sessionResult) === thinkingLevel) return sessionResult;
  const next = yield* client.setSessionThinkingLevelEffect(thinkingLevel, configId, sessionResult.sessionId);
  return mergeSessionResult(sessionResult, next);
});

const applyRequestedSessionConfiguration = Effect.fn("Exec.applyRequestedSessionConfiguration")(function* (
  client: AcpClient,
  sessionResult: AcpSessionResult,
  agentName: string,
  options: Pick<ExecOptions, "model" | "thinkingLevel">,
  writeStderr: (text: string) => void,
) {
  let configured = sessionResult;
  const explicitModel = requestedValue(options.model);
  const model = explicitModel ?? getAgentPreferredModel(agentName);
  if (model) {
    configured = yield* applyModel(client, configured, model).pipe(
      Effect.catch((error) =>
        explicitModel
          ? Effect.fail(error)
          : Effect.sync(() => {
              writeStderr(`Warning: configured preferred model could not be applied: ${String(error)}\n`);
              return configured;
            }),
      ),
    );
  }

  const explicitThinkingLevel = parseThinkingLevel(options.thinkingLevel);
  const thinkingLevel = explicitThinkingLevel ?? getAgentPreferredThinkingLevel(agentName);
  if (thinkingLevel) {
    configured = yield* applyThinkingLevel(client, configured, thinkingLevel).pipe(
      Effect.catch((error) =>
        explicitThinkingLevel
          ? Effect.fail(error)
          : Effect.sync(() => {
              writeStderr(`Warning: configured preferred thinking level could not be applied: ${String(error)}\n`);
              return configured;
            }),
      ),
    );
  }
  return configured;
});

function connectWithTimeout(client: AcpClient, agentName: string) {
  return client
    .connectEffect()
    .pipe(Effect.timeoutOption(`${AGENT_CONNECT_TIMEOUT_MS} millis`))
    .pipe(
      Effect.flatMap((result) =>
        Option.match(result, {
          onSome: () => Effect.void,
          onNone: () =>
            Effect.fail(execError(`Timed out connecting to ${agentName} after ${AGENT_CONNECT_TIMEOUT_MS / 1000}s`)),
        }),
      ),
    );
}

function interruptEffect(): Effect.Effect<never, ExecInterruptedError> {
  return Effect.callback<never, ExecInterruptedError>((resume) => {
    const onSignal = (signal: NodeJS.Signals) => resume(Effect.fail(new ExecInterruptedError(signal)));
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    return Effect.sync(() => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    });
  });
}

function flushExecTelemetry(flush: () => Promise<void>) {
  return Effect.tryPromise(() => flushTelemetryBeforeExit(flush)).pipe(Effect.catch(() => Effect.void));
}

export function runExec(options: ExecOptions, dependencies: ExecDependencies = {}) {
  return Effect.gen(function* () {
    const prompt = options.prompt.trim();
    if (!prompt) return yield* Effect.fail(execError("Exec requires a non-empty prompt."));

    const agent = resolveAcpLaunchAgent(options.agent, options.acpCommand);
    if (!agent) return yield* Effect.fail(execError(missingAcpLaunchAgentErrorMessage(options.agent)));

    const writeStdout = dependencies.writeStdout ?? ((text: string) => process.stdout.write(text));
    const writeStderr = dependencies.writeStderr ?? ((text: string) => process.stderr.write(text));
    const createClient =
      dependencies.createClient ??
      ((callbacks: AcpClientCallbacks, clientOptions: AcpClientOptions) => new AcpClient(callbacks, clientOptions));
    const responseChunks: string[] = [];

    const callbacks: AcpClientCallbacks = {
      onSessionUpdate: (update) => {
        const event = acpThreadEventFromSessionUpdate(update);
        if (event?.type !== "agentMessage" || !event.content) return;
        const text = textFromAcpThreadContent(event.content, "message");
        if (text) responseChunks.push(text);
      },
      onPermissionRequest: (request) => request.respond(ApprovalResponse.DENY),
      onElicitationRequest: (request) => request.respond({ action: "decline" }),
    };

    const profile = resolveAgentBehaviorProfileForLaunchAgent(agent);
    const client = createClient(callbacks, acpClientOptionsForAgent(agent, options.cwd, profile));
    const telemetryFlush = flushExecTelemetry(dependencies.flushTelemetry ?? flushTelemetry);
    yield* Effect.gen(function* () {
      yield* connectWithTimeout(client, agent.name);
      const sessionResult = yield* client.newSessionEffect(options.cwd);
      yield* applyRequestedSessionConfiguration(client, sessionResult, agent.name, options, writeStderr);
      const promptEffect = client.promptEffect(prompt);
      yield* (dependencies.installSignalHandlers ?? true)
        ? Effect.raceFirst(promptEffect, interruptEffect())
        : promptEffect;
      const response = responseChunks.join("");
      if (response) {
        yield* Effect.sync(() => {
          writeStdout(response.endsWith("\n") ? response : `${response}\n`);
        });
      }
    }).pipe(
      Effect.ensuring(
        client.disposeEffect().pipe(Effect.timeoutOption("5 seconds"), Effect.asVoid, Effect.ensuring(telemetryFlush)),
      ),
    );
  });
}
