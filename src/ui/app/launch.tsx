import type { EventEmitter } from "node:events";
import { CliRenderEvents, createCliRenderer } from "@opentui/core";
import { render } from "@opentui/solid";
import { getRelayLogger, type RelayLogger } from "../../logging/logger";
import { App } from "../app-root";
import type { AppProps, LaunchOptions } from "./types";
import { resolveTranscriptRendererMode } from "../util/transcript-renderer-mode";

/**
 * Converts command-line launch options and environment overrides into application props.
 *
 * @param opts - Parsed launch options supplied by the CLI entrypoint.
 * @param env - Optional environment override used to resolve rollout settings in tests or callers.
 * @returns Fully resolved props for constructing the Relay application.
 */
export function appPropsForLaunch(
  opts: LaunchOptions = {},
  env?: Readonly<Record<string, string | undefined>>,
): AppProps {
  return {
    cwd: opts.cwd ?? process.cwd(),
    initialAgent: opts.agent ?? "",
    initialAcpCommand: opts.acpCommand,
    initialContinue: opts.continueSession ?? false,
    initialResume: opts.resume ?? false,
    initialResumeSessionId: opts.resumeSessionId ?? "",
    initialDefaultRenderer: opts.defaultRenderer ?? false,
    initialYolo: opts.yolo ?? false,
    initialPrompt: opts.initialPrompt,
    initialThinkingLevel: opts.thinkingLevel,
    acpClientFactory: opts.acpClientFactory,
    transcriptRendererMode: env ? resolveTranscriptRendererMode(env) : resolveTranscriptRendererMode(),
  };
}

/**
 * OpenTUI only prints uncaught errors to its hidden console, so also log them while the renderer is alive.
 * Detaches on renderer destroy, matching OpenTUI's own handlers, so errors after teardown crash as usual.
 */
export function logUncaughtErrorsUntilDestroy(
  renderer: Pick<EventEmitter, "once" | "off">,
  logger: Pick<RelayLogger, "error"> = getRelayLogger(),
): void {
  const handler = (kind: "exception" | "rejection") => (error: unknown) =>
    logger.error("ui.uncaught", { kind, error: error instanceof Error ? (error.stack ?? error.message) : error });
  const onException = handler("exception");
  const onRejection = handler("rejection");
  const detach = () => {
    process.off("uncaughtException", onException);
    process.off("unhandledRejection", onRejection);
    renderer.off(CliRenderEvents.DESTROY, detach);
  };
  process.on("uncaughtException", onException);
  process.on("unhandledRejection", onRejection);
  renderer.once(CliRenderEvents.DESTROY, detach);
}

export async function launchTUI(opts: LaunchOptions = {}): Promise<void> {
  const appProps = appPropsForLaunch(opts);
  const renderer = await createCliRenderer({
    externalOutputMode: "passthrough",
    targetFps: 60,
    gatherStats: false,
    exitOnCtrlC: false,
    openConsoleOnError: false,
    useKittyKeyboard: {},
    autoFocus: false,
    useMouse: true,
  });
  logUncaughtErrorsUntilDestroy(renderer);

  try {
    await render(() => <App {...appProps} />, renderer);
  } catch (error) {
    renderer.destroy();
    // effect-shape-allow: OpenTUI exposes a Promise mount boundary; propagate only after restoring terminal state.
    throw error;
  }
}
