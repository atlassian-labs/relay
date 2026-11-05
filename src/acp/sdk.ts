import {
  ClientSideConnection as SdkClientSideConnection,
  PROTOCOL_VERSION as SDK_PROTOCOL_VERSION,
  RequestError,
  methods,
  type AnyMessage,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type AuthMethod,
  type AuthMethodId,
  type CancelNotification,
  type ClientCapabilities,
  type Client as SdkClient,
  type CloseSessionRequest,
  type CloseSessionResponse,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  type DeleteSessionRequest,
  type DeleteSessionResponse,
  type ForkSessionRequest,
  type ForkSessionResponse,
  type InitializeRequest,
  type InitializeResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type LogoutRequest,
  type LogoutResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type RequestPermissionResponse,
  type RequestPermissionRequest,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
  type SessionNotification,
  type Stream as SdkStream,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
} from "@agentclientprotocol/sdk";
import { Effect } from "effect";
import {
  AcpConnectionClosedError,
  AcpProtocolError,
  AcpRequestError,
  AcpUnsupportedMethodError,
  RelayError,
  errorMessage,
} from "../effect/errors";
import { runEffect } from "../effect/runtime";

export const PROTOCOL_VERSION = SDK_PROTOCOL_VERSION;
export type {
  AnyMessage,
  AuthenticateRequest,
  AuthenticateResponse,
  AuthMethod,
  AuthMethodId,
  CancelNotification,
  ClientCapabilities,
  CloseSessionRequest,
  CloseSessionResponse,
  ContentBlock,
  ContentChunk,
  CreateElicitationResponse,
  DeleteSessionRequest,
  DeleteSessionResponse,
  Diff,
  ForkSessionRequest,
  ForkSessionResponse,
  InitializeRequest,
  InitializeResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  LogoutRequest,
  LogoutResponse,
  McpServer,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ResumeSessionRequest,
  ResumeSessionResponse,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  SetSessionModeRequest,
  SetSessionModeResponse,
  SessionNotification,
  SessionUpdate,
  ToolCall,
  ToolCallContent,
  ToolCallUpdate,
} from "@agentclientprotocol/sdk";

const NOTIFICATION_DRAIN_TIMEOUT_MS = 2_000;
const MESSAGE_SLICE_BUDGET_MS = 16;
const RELAY_ACP_STREAM = Symbol("relay.acp.stream");

type RelayAcpStreamMarker = {
  readonly [RELAY_ACP_STREAM]: true;
};

type JsonRpcId = number | string | null;
type JsonRecord = Record<string, unknown>;

type JsonRpcRequest = {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly method: string;
  readonly params?: unknown;
};

type JsonRpcNotification = {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: unknown;
};

type JsonRpcErrorEnvelope = {
  readonly code?: number;
  readonly message?: string;
  readonly data?: unknown;
};

type JsonRpcResponse = {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly result?: unknown;
  readonly error?: JsonRpcErrorEnvelope;
};

type AcpConnectionError = AcpRequestError | AcpConnectionClosedError | AcpProtocolError | RelayError;

export type JsonObject = Record<string, unknown>;
export type RelayNewSessionRequest = NewSessionRequest & { readonly metadata?: JsonObject };
export type RelayLoadSessionRequest = LoadSessionRequest & { readonly metadata?: JsonObject };
export type RelayForkSessionRequest = ForkSessionRequest & { readonly metadata?: JsonObject };
export type RelayPromptRequest = PromptRequest & { readonly metadata?: JsonObject };
export type RelaySessionUpdate = SessionNotification["update"];
export type RelaySessionNotification = Omit<SessionNotification, "update"> & {
  readonly update: RelaySessionUpdate;
  readonly metadata?: JsonObject;
  readonly _meta?: JsonObject | null;
};

type PermissionOption = RequestPermissionRequest["options"][number];
type PermissionOptionKind = PermissionOption["kind"];
type PermissionToolCallUpdate = RequestPermissionRequest["toolCall"];
type ToolKind = NonNullable<PermissionToolCallUpdate["kind"]>;
type ToolStatus = NonNullable<PermissionToolCallUpdate["status"]>;

type NotificationDrainWaiter = {
  readonly sequence: number;
  readonly resolve: () => void;
};

type InterceptedRequestHandler = (message: JsonRpcRequest, writer: SerializedMessageWriter) => Promise<boolean>;

type InterceptedNotificationResult = boolean | AcpProtocolError;
type InterceptedNotificationHandler = (message: JsonRpcNotification) => InterceptedNotificationResult;

export interface Client {
  readonly requestPermission: (
    params: RequestPermissionRequest,
  ) => Effect.Effect<RequestPermissionResponse, RelayError>;
  readonly unstable_createElicitation?: (
    params: CreateElicitationRequest,
  ) => Effect.Effect<CreateElicitationResponse, RelayError>;
  readonly sessionUpdate: (params: RelaySessionNotification) => Effect.Effect<void, RelayError | AcpProtocolError>;
  readonly writeTextFile?: (params: WriteTextFileRequest) => Effect.Effect<WriteTextFileResponse | void, RelayError>;
  readonly readTextFile?: (params: ReadTextFileRequest) => Effect.Effect<ReadTextFileResponse, RelayError>;
}

export interface RelayAcpMessageStream extends SdkStream {
  readonly close?: () => Promise<void>;
}

export interface RelayAcpStream extends RelayAcpMessageStream, RelayAcpStreamMarker {}

export function relayAcpStream(stream: RelayAcpMessageStream): RelayAcpStream {
  return { [RELAY_ACP_STREAM]: true, ...stream };
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: JsonRecord, key: string): boolean {
  return Object.hasOwn(value, key);
}

function optionalMeta(value: unknown): JsonObject | null | undefined {
  return value === null || isRecord(value) ? value : undefined;
}

type DecodeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: AcpProtocolError };

function decoded<T>(value: T): DecodeResult<T> {
  return { ok: true, value };
}

function decodeError(message: string, data?: unknown): DecodeResult<never> {
  return { ok: false, error: new AcpProtocolError({ message, data }) };
}

const PERMISSION_OPTION_KINDS = new Set<string>(["allow_once", "allow_always", "reject_once", "reject_always"]);

const TOOL_KINDS = new Set<string>([
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "think",
  "fetch",
  "switch_mode",
  "other",
]);

const TOOL_STATUSES = new Set<string>(["pending", "in_progress", "completed", "failed"]);
const CONTENT_SESSION_UPDATE_KINDS = new Set<string>([
  "user_message_chunk",
  "agent_message_chunk",
  "agent_thought_chunk",
]);

function isPermissionOptionKind(value: unknown): value is PermissionOptionKind {
  return typeof value === "string" && PERMISSION_OPTION_KINDS.has(value);
}

function isToolKind(value: unknown): value is ToolKind {
  return typeof value === "string" && TOOL_KINDS.has(value);
}

function isToolStatus(value: unknown): value is ToolStatus {
  return typeof value === "string" && TOOL_STATUSES.has(value);
}

function permissionOption(value: unknown): PermissionOption | undefined {
  if (!isRecord(value) || typeof value.optionId !== "string") return undefined;
  if (typeof value.name !== "string" || !isPermissionOptionKind(value.kind)) return undefined;
  return {
    optionId: value.optionId,
    name: value.name,
    kind: value.kind,
    ...(optionalMeta(value._meta) !== undefined ? { _meta: optionalMeta(value._meta) } : {}),
  };
}

function permissionOptions(value: unknown): PermissionOption[] {
  if (!Array.isArray(value)) return [];
  return value.map(permissionOption).filter((option): option is PermissionOption => option !== undefined);
}

function toolCallUpdate(value: unknown): DecodeResult<PermissionToolCallUpdate> {
  if (!isRecord(value) || typeof value.toolCallId !== "string") {
    return decodeError("Invalid ACP session/request_permission params; expected toolCall.toolCallId", value);
  }
  return decoded({
    toolCallId: value.toolCallId,
    ...(isToolKind(value.kind) ? { kind: value.kind } : {}),
    ...(isToolStatus(value.status) ? { status: value.status } : {}),
    ...(typeof value.title === "string" ? { title: value.title } : {}),
    ...(hasOwn(value, "rawInput") ? { rawInput: value.rawInput } : {}),
    ...(hasOwn(value, "rawOutput") ? { rawOutput: value.rawOutput } : {}),
    ...(optionalMeta(value._meta) !== undefined ? { _meta: optionalMeta(value._meta) } : {}),
  });
}

function requestPermissionParams(value: unknown): DecodeResult<RequestPermissionRequest> {
  if (!isRecord(value)) return decodeError("Invalid ACP session/request_permission params; expected object", value);
  if (typeof value.sessionId !== "string") {
    return decodeError("Invalid ACP session/request_permission params; expected sessionId", value);
  }
  const toolCall = toolCallUpdate(value.toolCall);
  if (!toolCall.ok) return toolCall;
  return decoded({
    sessionId: value.sessionId,
    toolCall: toolCall.value,
    options: permissionOptions(value.options),
    ...(optionalMeta(value._meta) !== undefined ? { _meta: optionalMeta(value._meta) } : {}),
  });
}

function createElicitationParams(value: unknown): DecodeResult<CreateElicitationRequest> {
  if (!isRecord(value)) return decodeError("Invalid ACP elicitation/create params; expected object", value);
  if (typeof value.message !== "string") {
    return decodeError("Invalid ACP elicitation/create params; expected message", value);
  }
  const mode = typeof value.mode === "string" ? value.mode : "form";
  if (mode !== "form") {
    return decodeError(`Unsupported ACP elicitation/create mode "${mode}"; Relay supports mode "form"`, value);
  }
  return decoded({ ...value, mode: "form" } as CreateElicitationRequest);
}

function acpContentBlock(value: unknown): boolean {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "text":
      return typeof value.text === "string";
    case "image":
    case "audio":
      return typeof value.data === "string" && typeof value.mimeType === "string";
    case "resource_link":
      return typeof value.name === "string" && typeof value.uri === "string";
    case "resource": {
      const resource = value.resource;
      return (
        isRecord(resource) &&
        typeof resource.uri === "string" &&
        (typeof resource.text === "string" || typeof resource.blob === "string")
      );
    }
    default:
      return false;
  }
}

function relaySessionUpdate(value: unknown): DecodeResult<RelaySessionUpdate> {
  if (!isRecord(value) || typeof value.sessionUpdate !== "string") {
    return decodeError("Invalid ACP session/update params; expected update.sessionUpdate", value);
  }

  if (CONTENT_SESSION_UPDATE_KINDS.has(value.sessionUpdate)) {
    return acpContentBlock(value.content)
      ? decoded(value as SessionNotification["update"])
      : decodeError("Invalid ACP session/update params; expected content block", value);
  }

  switch (value.sessionUpdate) {
    case "tool_call":
      return typeof value.toolCallId === "string" && typeof value.title === "string"
        ? decoded(value as SessionNotification["update"])
        : decodeError("Invalid ACP session/update params; expected tool_call id and title", value);
    case "tool_call_update":
      return typeof value.toolCallId === "string"
        ? decoded(value as SessionNotification["update"])
        : decodeError("Invalid ACP session/update params; expected tool_call_update id", value);
    case "plan":
      return Array.isArray(value.entries)
        ? decoded(value as SessionNotification["update"])
        : decodeError("Invalid ACP session/update params; expected plan entries", value);
    case "plan_update":
      return isRecord(value.plan)
        ? decoded(value as SessionNotification["update"])
        : decodeError("Invalid ACP session/update params; expected plan update content", value);
    case "plan_removed":
      return typeof value.id === "string"
        ? decoded(value as SessionNotification["update"])
        : decodeError("Invalid ACP session/update params; expected plan id", value);
    case "available_commands_update":
      return Array.isArray(value.availableCommands)
        ? decoded(value as SessionNotification["update"])
        : decodeError("Invalid ACP session/update params; expected available commands", value);
    case "current_mode_update":
      return typeof value.currentModeId === "string"
        ? decoded(value as SessionNotification["update"])
        : decodeError("Invalid ACP session/update params; expected current mode id", value);
    case "config_option_update":
      return Array.isArray(value.configOptions)
        ? decoded(value as SessionNotification["update"])
        : decodeError("Invalid ACP session/update params; expected config options", value);
    case "session_info_update":
      return decoded(value as SessionNotification["update"]);
    case "usage_update":
      return typeof value.used === "number" && typeof value.size === "number"
        ? decoded(value as SessionNotification["update"])
        : decodeError("Invalid ACP session/update params; expected usage size and used", value);
    default:
      return decodeError("Invalid ACP session/update params; unsupported sessionUpdate", value);
  }
}

function sessionNotificationParams(value: unknown): DecodeResult<RelaySessionNotification> {
  if (!isRecord(value)) return decodeError("Invalid ACP session/update params; expected object", value);
  if (typeof value.sessionId !== "string") {
    return decodeError("Invalid ACP session/update params; expected sessionId", value);
  }
  const update = relaySessionUpdate(value.update);
  if (!update.ok) return update;
  return decoded({
    sessionId: value.sessionId,
    update: update.value,
    ...(isRecord(value.metadata) ? { metadata: value.metadata } : {}),
    ...(optionalMeta(value._meta) !== undefined ? { _meta: optionalMeta(value._meta) } : {}),
  });
}

function hasId(value: JsonRecord): value is JsonRecord & { readonly id: JsonRpcId } {
  return hasOwn(value, "id") && (typeof value.id === "number" || typeof value.id === "string" || value.id === null);
}

function hasJsonRpcVersion(value: JsonRecord): value is JsonRecord & { readonly jsonrpc: "2.0" } {
  return value.jsonrpc === "2.0";
}

function isJsonRpcErrorEnvelope(value: unknown): value is JsonRpcErrorEnvelope {
  return isRecord(value) && (value.message === undefined || typeof value.message === "string");
}

function isRequest(value: unknown): value is JsonRpcRequest {
  return isRecord(value) && hasJsonRpcVersion(value) && hasId(value) && typeof value.method === "string";
}

function isNotification(value: unknown): value is JsonRpcNotification {
  return isRecord(value) && hasJsonRpcVersion(value) && !hasOwn(value, "id") && typeof value.method === "string";
}

function isResponse(value: unknown): value is JsonRpcResponse {
  return (
    isRecord(value) &&
    hasJsonRpcVersion(value) &&
    hasId(value) &&
    typeof value.method !== "string" &&
    (hasOwn(value, "result") || hasOwn(value, "error")) &&
    (value.error === undefined || isJsonRpcErrorEnvelope(value.error))
  );
}

export function parseJsonLine(line: string): unknown | undefined {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return Bun.sleep(ms);
}

function requestFailure(error: unknown): AcpRequestError {
  if (error instanceof AcpRequestError) return error;
  return new AcpRequestError({ message: errorMessage(error), data: error });
}

function isUnsupportedMethodError(error: unknown): boolean {
  if (error instanceof AcpRequestError && error.code === -32601) return true;
  return /method not found|unsupported method|unknown method/i.test(errorMessage(error));
}

function isConnectionClosedError(error: unknown): boolean {
  return error instanceof AcpConnectionClosedError || /ACP connection closed/i.test(errorMessage(error));
}

function sdkFailure(error: unknown): AcpConnectionError {
  if (
    error instanceof AcpRequestError ||
    error instanceof AcpConnectionClosedError ||
    error instanceof AcpProtocolError ||
    error instanceof RelayError
  ) {
    return error;
  }
  if (error instanceof RequestError) {
    return new AcpRequestError({ message: error.message, code: error.code, data: error.data });
  }
  if (isConnectionClosedError(error)) {
    return new AcpConnectionClosedError({ message: "ACP connection closed" });
  }
  return new RelayError({ message: errorMessage(error), cause: error });
}

async function runEffectAs<T>(effect: Effect.Effect<T, unknown, never>): Promise<T> {
  return runEffect(effect);
}

class NotificationDrain {
  private nextSequence = 0;
  private handledSequence = 0;
  private readonly waiters: NotificationDrainWaiter[] = [];

  run(handler: () => Promise<void>): Promise<void> {
    const sequence = this.nextSequence + 1;
    this.nextSequence = sequence;
    return Promise.resolve()
      .then(handler)
      .catch(() => undefined)
      .finally(() => this.markHandled(sequence));
  }

  async drain(): Promise<void> {
    const sequence = this.nextSequence;
    if (this.handledSequence >= sequence) return;

    const done = Promise.withResolvers<void>();
    const waiter: NotificationDrainWaiter = { sequence, resolve: done.resolve };
    this.waiters.push(waiter);

    // effect-shape-allow: official ACP SDK callbacks are Promise-based; this adapter preserves the old drain timeout.
    await Promise.race([done.promise, sleep(NOTIFICATION_DRAIN_TIMEOUT_MS)]);
    if (waiter) this.removeWaiter(waiter);
  }

  private markHandled(sequence: number): void {
    this.handledSequence = Math.max(this.handledSequence, sequence);
    for (let index = this.waiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.waiters[index];
      if (waiter.sequence <= this.handledSequence) {
        this.waiters.splice(index, 1);
        waiter.resolve();
      }
    }
  }

  private removeWaiter(waiter: NotificationDrainWaiter): void {
    const index = this.waiters.indexOf(waiter);
    if (index !== -1) this.waiters.splice(index, 1);
  }
}

class SerializedMessageWriter {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly writable: WritableStream<AnyMessage>) {}

  write(message: AnyMessage): Promise<void> {
    const write = this.queue.then(async () => {
      const writer = this.writable.getWriter();
      try {
        await writer.write(message);
      } finally {
        writer.releaseLock();
      }
    });
    this.queue = write.catch(() => undefined);
    return write;
  }

  close(): Promise<void> {
    const close = this.queue.then(async () => {
      const writer = this.writable.getWriter();
      try {
        await writer.close();
      } finally {
        writer.releaseLock();
      }
    });
    this.queue = close.catch(() => undefined);
    return close;
  }

  abort(reason: unknown): Promise<void> {
    const abort = this.queue.then(() => this.writable.abort(reason));
    this.queue = abort.catch(() => undefined);
    return abort;
  }
}

function jsonRpcResult(id: JsonRpcId, result: unknown): AnyMessage {
  return { jsonrpc: "2.0", id, result: result ?? {} };
}

function jsonRpcError(id: JsonRpcId, error: unknown): AnyMessage {
  const unsupported = error instanceof AcpUnsupportedMethodError;
  const invalidParams = error instanceof AcpProtocolError;
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: unsupported ? -32601 : invalidParams ? -32602 : -32603,
      message: unsupported ? (error.message ?? `Method not found: ${error.method}`) : errorMessage(error),
    },
  };
}

export function isAcpJsonRpcMessage(message: unknown): message is AnyMessage {
  return isRequest(message) || isNotification(message) || isResponse(message);
}

export function ndJsonStream(output: WritableStream<Uint8Array>, input: ReadableStream<Uint8Array>): RelayAcpStream {
  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder();
  let readableController: ReadableStreamDefaultController<AnyMessage> | null = null;
  let inputReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let closed = false;

  const closeWithError = (error: unknown): void => {
    if (closed) return;
    closed = true;
    try {
      readableController?.error(error);
    } catch {
      // The readable may already be closed or errored.
    }
  };

  const readable = new ReadableStream<AnyMessage>({
    start(controller) {
      readableController = controller;
      // effect-shape-allow: ACP stream decoding is an SDK Promise bridge owned by this adapter.
      void (async () => {
        const reader = input.getReader();
        inputReader = reader;
        let buffer = "";
        try {
          while (!closed) {
            const chunk = await reader.read();
            if (chunk.done) break;
            if (!chunk.value) continue;

            buffer += textDecoder.decode(chunk.value, { stream: true });
            let newlineIndex = buffer.indexOf("\n");
            while (newlineIndex !== -1) {
              const line = buffer.slice(0, newlineIndex).trim();
              buffer = buffer.slice(newlineIndex + 1);
              if (line.length > 0) {
                const message = parseJsonLine(line);
                if (message !== undefined) {
                  if (!isAcpJsonRpcMessage(message)) {
                    closeWithError(new AcpProtocolError({ message: "Invalid ACP JSON-RPC envelope", data: message }));
                    return;
                  }
                  controller.enqueue(message);
                }
              }
              newlineIndex = buffer.indexOf("\n");
            }
          }

          if (!closed) {
            buffer += textDecoder.decode();
            const line = buffer.trim();
            if (line.length > 0) {
              const message = parseJsonLine(line);
              if (message !== undefined) {
                if (!isAcpJsonRpcMessage(message)) {
                  closeWithError(new AcpProtocolError({ message: "Invalid ACP JSON-RPC envelope", data: message }));
                  return;
                }
                controller.enqueue(message);
              }
            }
            closed = true;
            controller.close();
          }
        } catch (cause) {
          closeWithError(cause);
        } finally {
          inputReader = null;
          try {
            reader.releaseLock();
          } catch {
            // The reader may already be released by cancellation.
          }
        }
      })();
    },
    cancel(reason) {
      closed = true;
      return inputReader?.cancel(reason) ?? Promise.resolve();
    },
  });

  const writable = new WritableStream<AnyMessage>({
    async write(message) {
      if (closed) return Promise.reject(new Error("ACP connection closed"));
      const writer = output.getWriter();
      try {
        await writer.write(textEncoder.encode(`${JSON.stringify(message)}\n`));
      } finally {
        writer.releaseLock();
      }
    },
    async close() {
      closed = true;
      const writer = output.getWriter();
      try {
        await writer.close();
      } finally {
        writer.releaseLock();
      }
    },
    abort(reason) {
      closed = true;
      return output.abort(reason);
    },
  });

  return {
    [RELAY_ACP_STREAM]: true,
    readable,
    writable,
    close: async () => {
      if (closed) return;
      const error = new Error("ACP connection closed");
      closeWithError(error);
      // effect-shape-allow: closing paired web streams must tolerate either side settling first.
      await Promise.allSettled([inputReader?.cancel(error) ?? Promise.resolve(), output.abort(error)]);
    },
  };
}

function createInterceptedStream(
  source: RelayAcpStream,
  requestHandler: InterceptedRequestHandler,
  notificationHandler: InterceptedNotificationHandler,
): RelayAcpStream {
  const writer = new SerializedMessageWriter(source.writable);
  let sourceReader: ReadableStreamDefaultReader<AnyMessage> | null = null;

  const readable = new ReadableStream<AnyMessage>({
    start(controller) {
      const reader = source.readable.getReader();
      sourceReader = reader;
      // effect-shape-allow: ACP stream interception is an SDK Promise bridge owned by this adapter.
      void (async () => {
        try {
          // Buffered reads and notification handlers settle as microtasks, so a backlog of updates would
          // otherwise run to completion without yielding, starving keyboard input and rendering. The budget
          // only counts back-to-back work: once the event loop gets a turn (an idle read, a yield), a new slice starts.
          let sliceStartedAt = 0;
          let eventLoopTurned = false;
          const startSlice = () => {
            sliceStartedAt = performance.now();
            eventLoopTurned = false;
            setImmediate(() => {
              eventLoopTurned = true;
            });
          };
          startSlice();
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            if (eventLoopTurned) startSlice();
            else if (performance.now() - sliceStartedAt > MESSAGE_SLICE_BUDGET_MS) {
              await sleep(0);
              startSlice();
            }
            const message = chunk.value;
            if (isRequest(message) && (await requestHandler(message, writer))) continue;
            if (isNotification(message)) {
              const notificationResult = notificationHandler(message);
              if (notificationResult instanceof AcpProtocolError) {
                controller.error(notificationResult);
                return;
              }
              if (notificationResult) continue;
            }
            controller.enqueue(message);
            if (isResponse(message)) {
              await sleep(0);
              startSlice();
            }
          }
          controller.close();
        } catch (cause) {
          controller.error(cause);
        } finally {
          sourceReader = null;
          try {
            reader.releaseLock();
          } catch {
            // The reader may already be released by cancellation.
          }
        }
      })();
    },
    cancel(reason) {
      return sourceReader?.cancel(reason) ?? Promise.resolve();
    },
  });

  const writable = new WritableStream<AnyMessage>({
    write: (message) => writer.write(message),
    close: () => writer.close(),
    abort: (reason) => writer.abort(reason),
  });

  return {
    [RELAY_ACP_STREAM]: true,
    readable,
    writable,
    close: () => source.close?.() ?? writer.abort(new Error("ACP connection closed")),
  };
}

export class ClientSideConnection {
  private sdkConnection: SdkClientSideConnection | null = null;
  private stream: RelayAcpStream | null = null;
  private readonly notificationDrain = new NotificationDrain();

  private constructor(private readonly toClient: (_agent: ClientSideConnection) => Client) {}

  close(): Effect.Effect<void, never> {
    // effect-shape-allow: official ACP SDK exposes Promise close state; this is the adapter boundary.
    return Effect.promise(async () => {
      const stream = this.stream;
      const sdkConnection = this.sdkConnection;
      await stream?.close?.().catch(() => undefined);
      if (sdkConnection)
        // effect-shape-allow: close waits for either SDK shutdown or a bounded adapter timeout.
        await Promise.race([sdkConnection.closed, sleep(250)]).catch(() => undefined);
      this.sdkConnection = null;
      this.stream = null;
    }).pipe(Effect.catch(() => Effect.void));
  }

  static scoped(
    toClient: (_agent: ClientSideConnection) => Client,
    stream:
      | { readonly writable: WritableStream<Uint8Array>; readonly readable: ReadableStream<Uint8Array> }
      | RelayAcpStream,
  ) {
    return Effect.acquireRelease(ClientSideConnection.make(toClient, stream), (connection) => connection.close());
  }

  static make(
    toClient: (_agent: ClientSideConnection) => Client,
    stream:
      | { readonly writable: WritableStream<Uint8Array>; readonly readable: ReadableStream<Uint8Array> }
      | RelayAcpStream,
  ): Effect.Effect<ClientSideConnection, never> {
    return Effect.sync(() => {
      const connection = new ClientSideConnection(toClient);
      const messageStream = isRelayAcpStream(stream) ? stream : ndJsonStream(stream.writable, stream.readable);
      const interceptedStream = createInterceptedStream(
        messageStream,
        (message, writer) => connection.handleInterceptedRequest(message, writer),
        (message) => connection.handleInterceptedNotification(message),
      );
      connection.stream = interceptedStream;
      connection.sdkConnection = new SdkClientSideConnection(() => connection.sdkClient(), interceptedStream);
      return connection;
    });
  }

  private client(): Client {
    return this.toClient(this);
  }

  private sdkClient(): SdkClient {
    return {
      requestPermission: (params) => runEffectAs<RequestPermissionResponse>(this.client().requestPermission(params)),
      sessionUpdate: (params) =>
        this.notificationDrain.run(() => runEffectAs<void>(this.client().sessionUpdate(params))),
      unstable_createElicitation: (params) => {
        const handler = this.client().unstable_createElicitation;
        return handler
          ? runEffectAs<CreateElicitationResponse>(handler(params))
          : Promise.resolve({ action: "cancel" });
      },
    } satisfies SdkClient;
  }

  private async handleInterceptedRequest(message: JsonRpcRequest, writer: SerializedMessageWriter): Promise<boolean> {
    switch (message.method) {
      case methods.client.session.requestPermission:
        await this.respondToInterceptedRequest(message, writer, () => {
          const params = requestPermissionParams(message.params);
          return params.ok ? this.client().requestPermission(params.value) : Effect.fail(params.error);
        });
        return true;
      case methods.client.elicitation.create: {
        const handler = this.client().unstable_createElicitation;
        await this.respondToInterceptedRequest(message, writer, () => {
          const params = createElicitationParams(message.params);
          if (!params.ok) return Effect.fail(params.error);
          return handler?.(params.value) ?? Effect.succeed({ action: "cancel" });
        });
        return true;
      }
      default:
        return false;
    }
  }

  private handleInterceptedNotification(message: JsonRpcNotification): InterceptedNotificationResult {
    if (message.method !== methods.client.session.update) return false;
    const params = sessionNotificationParams(message.params);
    if (!params.ok) return params.error;
    void this.notificationDrain.run(() => runEffectAs<void>(this.client().sessionUpdate(params.value)));
    return true;
  }

  private async respondToInterceptedRequest(
    message: JsonRpcRequest,
    writer: SerializedMessageWriter,
    handler: () => Effect.Effect<unknown, unknown, never>,
  ): Promise<void> {
    try {
      const result = await runEffectAs<unknown>(handler());
      await writer.write(jsonRpcResult(message.id, result));
    } catch (error) {
      await writer.write(jsonRpcError(message.id, error));
    }
  }

  private activeSdk(operation: string): SdkClientSideConnection {
    if (!this.sdkConnection) {
      // effect-shape-allow: SDK Promise request bridge maps this tagged close error at the boundary.
      throw new AcpConnectionClosedError({ message: `ACP connection closed during ${operation}` });
    }
    return this.sdkConnection;
  }

  private requestEffect<T>(operation: string, request: (connection: SdkClientSideConnection) => Promise<T>) {
    return Effect.tryPromise({
      try: async () => {
        const result = await request(this.activeSdk(operation));
        await this.notificationDrain.drain();
        return result;
      },
      catch: sdkFailure,
    });
  }

  private notificationEffect(operation: string, notification: (connection: SdkClientSideConnection) => Promise<void>) {
    return Effect.tryPromise({
      try: () => notification(this.activeSdk(operation)),
      catch: sdkFailure,
    });
  }

  initialize(params: InitializeRequest) {
    return this.requestEffect<InitializeResponse>("initialize", (connection) => connection.initialize(params));
  }

  authenticate(params: AuthenticateRequest) {
    return this.requestEffect<AuthenticateResponse>("authenticate", (connection) => connection.authenticate(params));
  }

  logout(params: LogoutRequest) {
    return this.requestEffect<LogoutResponse>("logout", (connection) => connection.logout(params));
  }

  newSession(params: RelayNewSessionRequest) {
    return this.requestEffect<NewSessionResponse>("newSession", (connection) => connection.newSession(params));
  }

  forkSession(params: RelayForkSessionRequest) {
    return this.requestEffect<ForkSessionResponse>("forkSession", (connection) =>
      connection.unstable_forkSession(params),
    );
  }

  loadSession(params: RelayLoadSessionRequest) {
    return this.requestEffect<LoadSessionResponse>("loadSession", (connection) => connection.loadSession(params));
  }

  listSessions(params: ListSessionsRequest) {
    return this.requestEffect<ListSessionsResponse>("listSessions", (connection) => connection.listSessions(params));
  }

  deleteSession(params: DeleteSessionRequest) {
    return this.requestEffect<DeleteSessionResponse>("deleteSession", (connection) => connection.deleteSession(params));
  }

  resumeSession(params: ResumeSessionRequest) {
    return this.requestEffect<ResumeSessionResponse>("resumeSession", (connection) => connection.resumeSession(params));
  }

  closeSession(params: CloseSessionRequest) {
    return this.requestEffect<CloseSessionResponse>("closeSession", (connection) => connection.closeSession(params));
  }

  prompt(params: RelayPromptRequest) {
    return this.requestEffect<PromptResponse>("prompt", (connection) => connection.prompt(params));
  }

  sendCustomRequest<Response = unknown>(method: string, params: JsonObject) {
    return this.requestEffect<Response>(
      "sendCustomRequest",
      (connection) => connection.extMethod(method, params) as Promise<Response>,
    );
  }

  cancel(params: CancelNotification) {
    return this.notificationEffect("cancel", (connection) => connection.cancel(params));
  }

  setSessionMode(params: SetSessionModeRequest) {
    const fallbackParams: JsonObject = {
      sessionId: params.sessionId,
      modeId: params.modeId,
      ...(params._meta ? { _meta: params._meta } : {}),
    };
    return this.requestEffect<SetSessionModeResponse>("setSessionMode", (connection) =>
      connection.setSessionMode(params),
    ).pipe(
      Effect.catch((error) =>
        isUnsupportedMethodError(error)
          ? this.requestEffect<SetSessionModeResponse>(
              "setSessionModeFallback",
              (connection) =>
                connection.extMethod("session/setMode", fallbackParams) as Promise<SetSessionModeResponse>,
            )
          : Effect.fail(requestFailure(error)),
      ),
    );
  }

  setSessionConfigOption(params: SetSessionConfigOptionRequest) {
    return this.requestEffect<SetSessionConfigOptionResponse>("setSessionConfigOption", (connection) =>
      connection.setSessionConfigOption(params),
    );
  }
}

function isRelayAcpStream(
  stream:
    | { readonly writable: WritableStream<Uint8Array>; readonly readable: ReadableStream<Uint8Array> }
    | RelayAcpStream,
): stream is RelayAcpStream {
  return isRecord(stream) && (stream as Partial<RelayAcpStreamMarker>)[RELAY_ACP_STREAM] === true;
}
