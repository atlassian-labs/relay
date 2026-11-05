import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createConnection, createServer, type AddressInfo, type Socket } from "node:net";
import * as path from "node:path";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "./fs";
import { getConfigDir } from "./paths";
import {
  LIVE_SESSION_PROTOCOL_VERSION,
  type LiveSessionControlRequest,
  type LiveSessionControlResponse,
} from "../core/live-sessions";

const CONTROL_HOST = "127.0.0.1";
const REQUEST_TIMEOUT_MS = 10_000;
const WAIT_REQUEST_TIMEOUT_MS = 125_000;
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_OPERATION_CACHE_ENTRIES = 512;

export interface LiveSessionInstanceManifest {
  readonly version: 1;
  readonly instanceId: string;
  readonly pid: number;
  readonly host: string;
  readonly port: number;
  readonly token: string;
  readonly actorSessionId?: string;
  readonly startedAt: string;
}

export interface LiveSessionControlServer {
  readonly instanceId: string;
  readonly endpoint: string;
  readonly token: string;
  readonly tokenForSession: (sessionId: string) => string;
  readonly close: () => Promise<void>;
}

export type LiveSessionRequestHandler = (
  request: LiveSessionControlRequest,
) => Promise<LiveSessionControlResponse> | LiveSessionControlResponse;

function instancesDirectory(): string {
  return path.join(getConfigDir(), "runtime", "instances");
}

function manifestPath(instanceId: string): string {
  return path.join(instancesDirectory(), `${instanceId}.json`);
}

function manifestValue(value: unknown): LiveSessionInstanceManifest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const manifest = value as Partial<LiveSessionInstanceManifest>;
  if (
    manifest.version !== 1 ||
    typeof manifest.instanceId !== "string" ||
    typeof manifest.pid !== "number" ||
    typeof manifest.host !== "string" ||
    typeof manifest.port !== "number" ||
    typeof manifest.token !== "string" ||
    typeof manifest.startedAt !== "string"
  ) {
    return null;
  }
  return manifest as LiveSessionInstanceManifest;
}

function readManifest(filePath: string): LiveSessionInstanceManifest | null {
  try {
    return manifestValue(JSON.parse(readFileSync(filePath, "utf8")));
  } catch {
    return null;
  }
}

function writeManifest(manifest: LiveSessionInstanceManifest): void {
  mkdirSync(instancesDirectory(), { recursive: true, mode: 0o700 });
  const filePath = manifestPath(manifest.instanceId);
  writeFileSync(filePath, `${JSON.stringify(manifest)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(filePath, 0o600);
}

function errorResponse(requestId: string, code: string, message: string): LiveSessionControlResponse {
  return { version: LIVE_SESSION_PROTOCOL_VERSION, requestId, ok: false, error: { code, message } };
}

export function liveSessionActorToken(controlToken: string, sessionId: string): string {
  return createHmac("sha256", controlToken).update(`relay-live-session:${sessionId}`).digest("hex");
}

function tokensEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

type LiveSessionAuthenticationResult =
  | { readonly authenticated: true; readonly request: LiveSessionControlRequest }
  | { readonly authenticated: false; readonly response: LiveSessionControlResponse };

function authenticatedRequest(
  request: LiveSessionControlRequest,
  controlToken: string,
): LiveSessionAuthenticationResult {
  if (!request.actorSessionId) {
    return tokensEqual(request.token, controlToken)
      ? { authenticated: true, request }
      : {
          authenticated: false,
          response: errorResponse(request.requestId, "unauthorized", "invalid control token"),
        };
  }
  if (!tokensEqual(request.token, liveSessionActorToken(controlToken, request.actorSessionId))) {
    return {
      authenticated: false,
      response: errorResponse(request.requestId, "unauthorized", "invalid session control token"),
    };
  }
  const params = { ...(request.params ?? {}) };
  const identityKey = request.method === "session.message" ? "senderSessionId" : "requesterSessionId";
  const claimedIdentity = params[identityKey];
  if (claimedIdentity !== undefined && claimedIdentity !== request.actorSessionId) {
    return {
      authenticated: false,
      response: errorResponse(
        request.requestId,
        "identity_mismatch",
        "session identity does not match its control token",
      ),
    };
  }
  params[identityKey] = request.actorSessionId;
  return { authenticated: true, request: { ...request, params } };
}

function parseRequest(line: string): LiveSessionControlRequest | null {
  try {
    const value = JSON.parse(line) as Partial<LiveSessionControlRequest>;
    if (
      value.version !== LIVE_SESSION_PROTOCOL_VERSION ||
      typeof value.requestId !== "string" ||
      typeof value.token !== "string" ||
      (value.actorSessionId !== undefined && typeof value.actorSessionId !== "string") ||
      (value.method !== "session.list" &&
        value.method !== "session.inspect" &&
        value.method !== "session.message" &&
        value.method !== "session.createChild" &&
        value.method !== "session.wait" &&
        value.method !== "session.cancel")
    ) {
      return null;
    }
    return value as LiveSessionControlRequest;
  } catch {
    return null;
  }
}

interface CachedLiveSessionOperation {
  readonly fingerprint: string;
  readonly response: Promise<LiveSessionControlResponse>;
}

type LiveSessionOperationCache = Map<string, CachedLiveSessionOperation>;

function operationId(request: LiveSessionControlRequest): string | null {
  if (
    request.method !== "session.createChild" &&
    request.method !== "session.message" &&
    request.method !== "session.cancel"
  ) {
    return null;
  }
  const value = request.params?.operationId;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function handleOperation(
  request: LiveSessionControlRequest,
  handler: LiveSessionRequestHandler,
  cache: LiveSessionOperationCache,
): Promise<LiveSessionControlResponse> {
  const id = operationId(request);
  if (!id) return Promise.resolve(handler(request));
  const cacheKey = `${request.actorSessionId ?? "admin"}:${id}`;
  const fingerprint = JSON.stringify({ method: request.method, params: request.params });
  const cached = cache.get(cacheKey);
  if (cached) {
    if (cached.fingerprint !== fingerprint) {
      return Promise.resolve(
        errorResponse(request.requestId, "operation_conflict", `Operation ${id} was already used with different input`),
      );
    }
    return cached.response.then((response) => ({ ...response, requestId: request.requestId }));
  }
  const response = Promise.resolve(handler(request));
  cache.set(cacheKey, { fingerprint, response });
  if (cache.size > MAX_OPERATION_CACHE_ENTRIES) cache.delete(cache.keys().next().value as string);
  return response;
}

function handleSocket(
  socket: Socket,
  token: string,
  handler: LiveSessionRequestHandler,
  operationCache: LiveSessionOperationCache,
): void {
  socket.setEncoding("utf8");
  let input = "";
  let handled = false;
  socket.on("data", (chunk: string) => {
    if (handled) return;
    input += chunk;
    if (input.length > MAX_REQUEST_BYTES) {
      handled = true;
      socket.end(`${JSON.stringify(errorResponse("unknown", "request_too_large", "request is too large"))}\n`);
      return;
    }
    const newline = input.indexOf("\n");
    if (newline < 0) return;
    handled = true;
    const request = parseRequest(input.slice(0, newline));
    if (!request) {
      socket.end(`${JSON.stringify(errorResponse("unknown", "invalid_request", "invalid control request"))}\n`);
      return;
    }
    const authentication = authenticatedRequest(request, token);
    if (!authentication.authenticated) {
      socket.end(`${JSON.stringify(authentication.response)}\n`);
      return;
    }
    void handleOperation(authentication.request, handler, operationCache)
      .then((response) => socket.end(`${JSON.stringify(response)}\n`))
      .catch((error: unknown) =>
        socket.end(
          `${JSON.stringify(errorResponse(request.requestId, "internal_error", error instanceof Error ? error.message : String(error)))}\n`,
        ),
      );
  });
}

export async function startLiveSessionControlServer(
  handler: LiveSessionRequestHandler,
): Promise<LiveSessionControlServer> {
  const instanceId = `ri_${randomUUID().replaceAll("-", "")}`;
  const token = randomBytes(24).toString("hex");
  const operationCache: LiveSessionOperationCache = new Map();
  const server = createServer((socket) => handleSocket(socket, token, handler, operationCache));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, CONTROL_HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const manifest: LiveSessionInstanceManifest = {
    version: 1,
    instanceId,
    pid: process.pid,
    host: CONTROL_HOST,
    port: address.port,
    token,
    startedAt: new Date().toISOString(),
  };
  writeManifest(manifest);
  let closed = false;
  return {
    instanceId,
    endpoint: `tcp://${CONTROL_HOST}:${address.port}`,
    token,
    tokenForSession: (sessionId) => liveSessionActorToken(token, sessionId),
    close: async () => {
      if (closed) return;
      closed = true;
      rmSync(manifestPath(instanceId), { force: true });
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export function discoverLiveSessionInstances(): LiveSessionInstanceManifest[] {
  const directory = instancesDirectory();
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .flatMap((name) => readManifest(path.join(directory, name)) ?? []);
}

export async function sendLiveSessionControlRequest(
  manifest: LiveSessionInstanceManifest,
  method: LiveSessionControlRequest["method"],
  params?: Record<string, unknown>,
): Promise<LiveSessionControlResponse> {
  const requestId = randomUUID();
  const mutating = method === "session.createChild" || method === "session.message" || method === "session.cancel";
  const requestParams = mutating ? { operationId: randomUUID(), ...(params ?? {}) } : params;
  const request: LiveSessionControlRequest = {
    version: LIVE_SESSION_PROTOCOL_VERSION,
    requestId,
    token: manifest.token,
    ...(manifest.actorSessionId ? { actorSessionId: manifest.actorSessionId } : {}),
    method,
    ...(requestParams ? { params: requestParams } : {}),
  };
  const timeoutMs = method === "session.wait" ? WAIT_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
  const send = (): Promise<LiveSessionControlResponse> =>
    new Promise<LiveSessionControlResponse>((resolve, reject) => {
      const socket = createConnection({ host: manifest.host, port: manifest.port });
      let output = "";
      let settled = false;
      const timeout = setTimeout(() => {
        settled = true;
        socket.destroy();
        reject(new Error(`Relay instance ${manifest.instanceId} did not respond`));
      }, timeoutMs);
      const settle = (action: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        action();
      };
      socket.setEncoding("utf8");
      socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
      socket.on("data", (chunk: string) => {
        output += chunk;
        const newline = output.indexOf("\n");
        if (newline < 0) return;
        try {
          const response = JSON.parse(output.slice(0, newline)) as LiveSessionControlResponse;
          settle(() => resolve(response));
        } catch (error) {
          settle(() => reject(error));
        } finally {
          socket.end();
        }
      });
      socket.on("error", (error) => settle(() => reject(error)));
    });

  try {
    return await send();
  } catch (error) {
    if (!mutating) throw error; // effect-shape-allow: platform adapter preserves transport failures for non-idempotent reads.
    return await send();
  }
}

export function removeLiveSessionInstance(manifest: LiveSessionInstanceManifest): void {
  rmSync(manifestPath(manifest.instanceId), { force: true });
}
