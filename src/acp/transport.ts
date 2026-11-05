import { Effect } from "effect";
import type { AcpLaunchCommandMissingError, RelayError } from "../effect/errors";
import type { RelayAcpStream } from "./sdk";
import { StdioAcpTransport } from "./stdio-transport";
import { WebSocketAcpTransport } from "./websocket-transport";

export type AcpTransportKind = "stdio" | "websocket";
export type AcpWebSocketFraming = "json" | "ndjson";

export interface AcpLaunchOptions {
  readonly cwd: string;
  readonly transport?: AcpTransportKind;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly shell?: boolean;
  readonly env?: Readonly<Record<string, string>>;
  readonly url?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly protocols?: readonly string[];
  readonly framing?: AcpWebSocketFraming;
  readonly mcpServers?: readonly unknown[];
}

export interface AcpTransportConnection {
  readonly stream: RelayAcpStream;
  readonly diagnosticLogPath?: string | null;
  readonly waitForStartupOutput: () => Effect.Effect<void, never>;
  readonly startupOutput: () => string;
}

export type AcpTransportError = RelayError | AcpLaunchCommandMissingError;

export interface AcpTransport {
  readonly kind: AcpTransportKind;
  readonly connect: () => Effect.Effect<AcpTransportConnection, AcpTransportError>;
  readonly dispose: () => Effect.Effect<void, never>;
  readonly forceDispose?: () => void;
}

export type AcpProcessExitReason = "exit" | "error" | "websocket-close" | "dispose";

export interface AcpProcessExitEvent {
  readonly code?: number;
  readonly signal?: string;
  readonly expected: boolean;
  readonly reason: AcpProcessExitReason;
  readonly transport: AcpTransportKind;
  /** True once the ACP initialize handshake completed; false for startup/handshake exits. */
  readonly connected?: boolean;
  readonly message?: string;
}

export interface AcpTransportCallbacks {
  readonly onProcessExit?: (event: AcpProcessExitEvent) => void;
}

export function acpTransportKind(opts: AcpLaunchOptions): AcpTransportKind {
  return opts.transport ?? "stdio";
}

export function createAcpTransport(opts: AcpLaunchOptions, callbacks: AcpTransportCallbacks): AcpTransport {
  return acpTransportKind(opts) === "websocket"
    ? new WebSocketAcpTransport(opts, callbacks)
    : new StdioAcpTransport(opts, callbacks);
}
