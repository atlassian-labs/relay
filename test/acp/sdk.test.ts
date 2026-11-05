import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Deferred, Effect } from "effect";
import { ClientSideConnection, type Client } from "../../src/acp/sdk";
import { runTestEffect } from "../lib/effect";

function testClient(): Client {
  return {
    requestPermission: () => Effect.succeed({ outcome: { outcome: "cancelled" } }),
    sessionUpdate: () => Effect.void,
  };
}

async function readJsonLine(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<any> {
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) throw new Error("stream closed before JSON line was read");
    buffer += decoder.decode(value, { stream: true });
    const newlineIndex = buffer.indexOf("\n");
    if (newlineIndex !== -1) {
      return JSON.parse(buffer.slice(0, newlineIndex));
    }
  }
}

async function writeJsonLine(writer: WritableStreamDefaultWriter<Uint8Array>, message: any): Promise<void> {
  await writer.write(new TextEncoder().encode(`${JSON.stringify(message)}\n`));
}

async function writeRawLine(writer: WritableStreamDefaultWriter<Uint8Array>, line: string): Promise<void> {
  await writer.write(new TextEncoder().encode(`${line}\n`));
}

function createConnectionHarness() {
  const clientToServer = new TransformStream<Uint8Array, Uint8Array>();
  const serverToClient = new TransformStream<Uint8Array, Uint8Array>();
  const connection = runTestEffect(
    ClientSideConnection.make(() => testClient(), {
      writable: clientToServer.writable,
      readable: serverToClient.readable,
    }),
  );

  return {
    connection,
    requests: clientToServer.readable.getReader(),
    responses: serverToClient.writable.getWriter(),
  };
}

async function expectNoRequest(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  const timedOut = Symbol("timed out");
  const result = await Promise.race([
    readJsonLine(reader),
    new Promise<typeof timedOut>((resolve) => setTimeout(() => resolve(timedOut), 20)),
  ]);

  expect(result).toBe(timedOut);
}

describe("ClientSideConnection", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      await cleanup.pop()?.();
    }
  });

  test("setSessionConfigOption sends current ACP config option requests", async () => {
    const { connection: connectionPromise, requests, responses } = createConnectionHarness();
    const connection = await connectionPromise;
    cleanup.push(async () => {
      await runTestEffect(connection.close());
      requests.releaseLock();
      await responses.close().catch(() => undefined);
    });

    const params = { sessionId: "session-1", configId: "model", value: "opus" };
    const resultPromise = runTestEffect(connection.setSessionConfigOption(params));

    const request = await readJsonLine(requests);
    expect(request).toMatchObject({ method: "session/set_config_option", params });

    await writeJsonLine(responses, {
      jsonrpc: "2.0",
      id: request.id,
      result: { configOptions: [] },
    });

    await expect(resultPromise).resolves.toEqual({ configOptions: [] });
  });

  test("setSessionMode retries the camelCase method when snake_case is unsupported", async () => {
    const { connection: connectionPromise, requests, responses } = createConnectionHarness();
    const connection = await connectionPromise;
    cleanup.push(async () => {
      await runTestEffect(connection.close());
      requests.releaseLock();
      await responses.close().catch(() => undefined);
    });

    const params = { sessionId: "session-1", modeId: "review" };
    const resultPromise = runTestEffect(connection.setSessionMode(params));

    const primaryRequest = await readJsonLine(requests);
    expect(primaryRequest).toMatchObject({ method: "session/set_mode", params });

    await writeJsonLine(responses, {
      jsonrpc: "2.0",
      id: primaryRequest.id,
      error: { code: -32601, message: "Method not found" },
    });

    const fallbackRequest = await readJsonLine(requests);
    expect(fallbackRequest).toMatchObject({ method: "session/setMode", params });

    await writeJsonLine(responses, {
      jsonrpc: "2.0",
      id: fallbackRequest.id,
      result: {},
    });

    await expect(resultPromise).resolves.toEqual({});
  });

  test("forkSession sends standard session/fork requests", async () => {
    const { connection: connectionPromise, requests, responses } = createConnectionHarness();
    const connection = await connectionPromise;
    cleanup.push(async () => {
      await runTestEffect(connection.close());
      requests.releaseLock();
      await responses.close().catch(() => undefined);
    });

    const params = { sessionId: "foreground-session", cwd: "/workspace", mcpServers: [] };
    const resultPromise = runTestEffect(connection.forkSession(params));

    const request = await readJsonLine(requests);
    expect(request).toMatchObject({ method: "session/fork", params });

    await writeJsonLine(responses, {
      jsonrpc: "2.0",
      id: request.id,
      result: { sessionId: "forked-session" },
    });

    await expect(resultPromise).resolves.toEqual({ sessionId: "forked-session" });
  });

  test("deleteSession sends standard session/delete requests", async () => {
    const { connection: connectionPromise, requests, responses } = createConnectionHarness();
    const connection = await connectionPromise;
    cleanup.push(async () => {
      await runTestEffect(connection.close());
      requests.releaseLock();
      await responses.close().catch(() => undefined);
    });

    const params = { sessionId: "stale-session" };
    const resultPromise = runTestEffect(connection.deleteSession(params));

    const request = await readJsonLine(requests);
    expect(request).toMatchObject({ method: "session/delete", params });

    await writeJsonLine(responses, {
      jsonrpc: "2.0",
      id: request.id,
      result: {},
    });

    await expect(resultPromise).resolves.toEqual({});
  });

  test("setSessionMode does not retry the fallback method for non-method errors", async () => {
    const { connection: connectionPromise, requests, responses } = createConnectionHarness();
    const connection = await connectionPromise;
    cleanup.push(async () => {
      await runTestEffect(connection.close());
      requests.releaseLock();
      await responses.close().catch(() => undefined);
    });

    const params = { sessionId: "session-1", modeId: "review" };
    const resultPromise = runTestEffect(connection.setSessionMode(params));

    const primaryRequest = await readJsonLine(requests);
    expect(primaryRequest).toMatchObject({ method: "session/set_mode", params });

    await writeJsonLine(responses, {
      jsonrpc: "2.0",
      id: primaryRequest.id,
      error: { code: -32603, message: "permission denied" },
    });

    await expect(resultPromise).rejects.toThrow("permission denied");
    await expectNoRequest(requests);
  });

  test("closing connection while request is pending rejects instead of hanging", async () => {
    const { connection: connectionPromise, requests, responses } = createConnectionHarness();
    const connection = await connectionPromise;
    cleanup.push(async () => {
      await runTestEffect(connection.close());
      requests.releaseLock();
      await responses.close().catch(() => undefined);
    });

    const resultPromise = runTestEffect(
      connection.prompt({ sessionId: "session-1", prompt: [{ type: "text", text: "hello" }] }),
    );

    const request = await readJsonLine(requests);
    expect(request).toMatchObject({ method: "session/prompt" });

    await runTestEffect(connection.close());

    await expect(resultPromise).rejects.toThrow("ACP connection closed");
  });

  test("malformed stdout lines are ignored without closing the connection", async () => {
    const { connection: connectionPromise, requests, responses } = createConnectionHarness();
    const connection = await connectionPromise;
    cleanup.push(async () => {
      await runTestEffect(connection.close());
      requests.releaseLock();
      await responses.close().catch(() => undefined);
    });

    const resultPromise = runTestEffect(connection.listSessions({}));

    const request = await readJsonLine(requests);
    expect(request).toMatchObject({ method: "session/list" });

    await writeRawLine(responses, "agent log line on stdout");
    await writeJsonLine(responses, {
      jsonrpc: "2.0",
      id: request.id,
      result: { sessions: [] },
    });

    await expect(resultPromise).resolves.toEqual({ sessions: [] });
  });

  test("invalid JSON-RPC envelopes fail pending requests with a protocol error", async () => {
    const { connection: connectionPromise, requests, responses } = createConnectionHarness();
    const connection = await connectionPromise;
    cleanup.push(async () => {
      await runTestEffect(connection.close());
      requests.releaseLock();
      await responses.close().catch(() => undefined);
    });

    const resultPromise = runTestEffect(connection.listSessions({}));

    const request = await readJsonLine(requests);
    expect(request).toMatchObject({ method: "session/list" });

    await writeJsonLine(responses, {
      id: request.id,
      result: { sessions: [] },
    });

    await expect(resultPromise).rejects.toThrow("Invalid ACP JSON-RPC envelope");
  });

  test("inbound permission requests resolve through the client callback", async () => {
    const clientToServer = new TransformStream<Uint8Array, Uint8Array>();
    const serverToClient = new TransformStream<Uint8Array, Uint8Array>();
    const connection = await runTestEffect(
      ClientSideConnection.make(
        () => ({
          requestPermission: (params) =>
            Effect.succeed({ outcome: { outcome: "selected", optionId: params.options[0]?.optionId ?? "" } }),
          sessionUpdate: () => Effect.void,
        }),
        {
          writable: clientToServer.writable,
          readable: serverToClient.readable,
        },
      ),
    );
    const requests = clientToServer.readable.getReader();
    const responses = serverToClient.writable.getWriter();
    cleanup.push(async () => {
      await runTestEffect(connection.close());
      requests.releaseLock();
      await responses.close().catch(() => undefined);
    });

    await writeJsonLine(responses, {
      jsonrpc: "2.0",
      id: 99,
      method: "session/request_permission",
      params: {
        sessionId: "session-1",
        toolCall: { toolCallId: "tc_1" },
        options: [{ optionId: "allow_custom", name: "Allow", kind: "allow_once" }],
      },
    });

    await expect(readJsonLine(requests)).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: 99,
      result: { outcome: { outcome: "selected", optionId: "allow_custom" } },
    });
  });

  test("malformed inbound permission requests return invalid params errors", async () => {
    const { connection: connectionPromise, requests, responses } = createConnectionHarness();
    const connection = await connectionPromise;
    cleanup.push(async () => {
      await runTestEffect(connection.close());
      requests.releaseLock();
      await responses.close().catch(() => undefined);
    });

    await writeJsonLine(responses, {
      jsonrpc: "2.0",
      id: 101,
      method: "session/request_permission",
      params: "not an object",
    });

    await expect(readJsonLine(requests)).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: 101,
      error: {
        code: -32602,
        message: "Invalid ACP session/request_permission params; expected object",
      },
    });
  });

  test("inbound elicitation requests resolve through the optional client callback", async () => {
    const clientToServer = new TransformStream<Uint8Array, Uint8Array>();
    const serverToClient = new TransformStream<Uint8Array, Uint8Array>();
    const connection = await runTestEffect(
      ClientSideConnection.make(
        () => ({
          requestPermission: () => Effect.succeed({ outcome: { outcome: "cancelled" } }),
          unstable_createElicitation: (params) =>
            Effect.succeed({ action: "accept", content: { message: params.message } }),
          sessionUpdate: () => Effect.void,
        }),
        {
          writable: clientToServer.writable,
          readable: serverToClient.readable,
        },
      ),
    );
    const requests = clientToServer.readable.getReader();
    const responses = serverToClient.writable.getWriter();
    cleanup.push(async () => {
      await runTestEffect(connection.close());
      requests.releaseLock();
      await responses.close().catch(() => undefined);
    });

    await writeJsonLine(responses, {
      jsonrpc: "2.0",
      id: 100,
      method: "elicitation/create",
      params: { message: "Need input" },
    });

    await expect(readJsonLine(requests)).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: 100,
      result: { action: "accept", content: { message: "Need input" } },
    });
  });

  test("malformed inbound elicitation requests return invalid params errors", async () => {
    const { connection: connectionPromise, requests, responses } = createConnectionHarness();
    const connection = await connectionPromise;
    cleanup.push(async () => {
      await runTestEffect(connection.close());
      requests.releaseLock();
      await responses.close().catch(() => undefined);
    });

    await writeJsonLine(responses, {
      jsonrpc: "2.0",
      id: 102,
      method: "elicitation/create",
      params: { mode: "form" },
    });

    await expect(readJsonLine(requests)).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: 102,
      error: {
        code: -32602,
        message: "Invalid ACP elicitation/create params; expected message",
      },
    });
  });

  test("unsupported inbound elicitation modes return invalid params errors", async () => {
    const { connection: connectionPromise, requests, responses } = createConnectionHarness();
    const connection = await connectionPromise;
    cleanup.push(async () => {
      await runTestEffect(connection.close());
      requests.releaseLock();
      await responses.close().catch(() => undefined);
    });

    await writeJsonLine(responses, {
      jsonrpc: "2.0",
      id: 103,
      method: "elicitation/create",
      params: { mode: "url", message: "Open browser", url: "https://example.test", elicitationId: "el-1" },
    });

    await expect(readJsonLine(requests)).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: 103,
      error: {
        code: -32602,
        message: 'Unsupported ACP elicitation/create mode "url"; Relay supports mode "form"',
      },
    });
  });

  test("scoped connection closes pending requests when the scope exits", async () => {
    const clientToServer = new TransformStream<Uint8Array, Uint8Array>();
    const serverToClient = new TransformStream<Uint8Array, Uint8Array>();
    const requests = clientToServer.readable.getReader();
    const responses = serverToClient.writable.getWriter();
    cleanup.push(async () => {
      requests.releaseLock();
      await responses.close().catch(() => undefined);
    });

    let prompt: Promise<unknown> | undefined;

    await runTestEffect(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* ClientSideConnection.scoped(() => testClient(), {
            writable: clientToServer.writable,
            readable: serverToClient.readable,
          });
          prompt = runTestEffect(
            connection.prompt({ sessionId: "session-1", prompt: [{ type: "text", text: "hello" }] }),
          );
          const request = yield* Effect.promise(() => readJsonLine(requests));
          expect(request).toMatchObject({ method: "session/prompt" });
        }),
      ),
    );

    await expect(prompt).rejects.toThrow("ACP connection closed");
  });

  test("prompt responses wait for prior session updates to drain", async () => {
    const updateStarted = await runTestEffect(Deferred.make<void>());
    const releaseNotification = await runTestEffect(Deferred.make<void>());
    const clientToServer = new TransformStream<Uint8Array, Uint8Array>();
    const serverToClient = new TransformStream<Uint8Array, Uint8Array>();
    const connection = await runTestEffect(
      ClientSideConnection.make(
        () => ({
          requestPermission: () => Effect.succeed({ outcome: { outcome: "cancelled" } }),
          sessionUpdate: () =>
            Deferred.succeed(updateStarted, undefined).pipe(Effect.andThen(Deferred.await(releaseNotification))),
        }),
        {
          writable: clientToServer.writable,
          readable: serverToClient.readable,
        },
      ),
    );
    const notificationRequests = clientToServer.readable.getReader();
    const notificationResponses = serverToClient.writable.getWriter();
    cleanup.push(async () => {
      await runTestEffect(connection.close());
      notificationRequests.releaseLock();
      await notificationResponses.close().catch(() => undefined);
    });

    let resolved = false;
    const promptPromise = runTestEffect(
      connection.prompt({ sessionId: "session-1", prompt: [{ type: "text", text: "hello" }] }),
    ).then((value) => {
      resolved = true;
      return value;
    });
    const promptRequest = await readJsonLine(notificationRequests);
    expect(promptRequest).toMatchObject({ method: "session/prompt" });

    await writeJsonLine(notificationResponses, {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "session-1",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } },
      },
    });
    await writeJsonLine(notificationResponses, {
      jsonrpc: "2.0",
      id: promptRequest.id,
      result: { stopReason: "end_turn" },
    });

    await runTestEffect(Deferred.await(updateStarted));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(resolved).toBe(false);

    await runTestEffect(Deferred.succeed(releaseNotification, undefined));
    await expect(promptPromise).resolves.toEqual({ stopReason: "end_turn" });
    await expectNoRequest(notificationRequests);
  });

  test("queued notifications do not block later responses", async () => {
    const releaseNotification = await runTestEffect(Deferred.make<void>());
    const clientToServer = new TransformStream<Uint8Array, Uint8Array>();
    const serverToClient = new TransformStream<Uint8Array, Uint8Array>();
    const connection = await runTestEffect(
      ClientSideConnection.make(
        () => ({
          requestPermission: () => Effect.succeed({ outcome: { outcome: "cancelled" } }),
          sessionUpdate: () => Deferred.await(releaseNotification),
        }),
        {
          writable: clientToServer.writable,
          readable: serverToClient.readable,
        },
      ),
    );
    const notificationRequests = clientToServer.readable.getReader();
    const notificationResponses = serverToClient.writable.getWriter();
    cleanup.push(async () => {
      await runTestEffect(connection.close());
      notificationRequests.releaseLock();
      await notificationResponses.close().catch(() => undefined);
    });

    const promptPromise = runTestEffect(
      connection.prompt({ sessionId: "session-1", prompt: [{ type: "text", text: "hello" }] }),
    );
    const promptRequest = await readJsonLine(notificationRequests);
    expect(promptRequest).toMatchObject({ method: "session/prompt" });

    await writeJsonLine(notificationResponses, {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "session-1",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } },
      },
    });
    await writeJsonLine(notificationResponses, {
      jsonrpc: "2.0",
      id: promptRequest.id,
      result: { stopReason: "end_turn" },
    });

    await expect(promptPromise).resolves.toEqual({ stopReason: "end_turn" });
    await runTestEffect(Deferred.succeed(releaseNotification, undefined));
    await expectNoRequest(notificationRequests);
  });

  test("a backlog of session updates yields to the event loop instead of starving input", async () => {
    const total = 200;
    let handled = 0;
    const allHandled = await runTestEffect(Deferred.make<void>());
    const clientToServer = new TransformStream<Uint8Array, Uint8Array>();
    const serverToClient = new TransformStream<Uint8Array, Uint8Array>();
    const connection = await runTestEffect(
      ClientSideConnection.make(
        () => ({
          requestPermission: () => Effect.succeed({ outcome: { outcome: "cancelled" } }),
          sessionUpdate: () =>
            Effect.sync(() => {
              const until = performance.now() + 1;
              while (performance.now() < until) {
                // Simulate ~1ms of synchronous UI work per update.
              }
              handled += 1;
            }).pipe(
              Effect.andThen(
                Effect.suspend(() => (handled === total ? Deferred.succeed(allHandled, undefined) : Effect.void)),
              ),
            ),
        }),
        { writable: clientToServer.writable, readable: serverToClient.readable },
      ),
    );
    const requests = clientToServer.readable.getReader();
    const responses = serverToClient.writable.getWriter();
    cleanup.push(async () => {
      await runTestEffect(connection.close());
      requests.releaseLock();
      await responses.close().catch(() => undefined);
    });

    const update = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "session-1",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" } },
      },
    });
    await writeRawLine(responses, Array(total).fill(update).join("\n"));
    const handledWhenTimerFired = await new Promise<number>((resolve) => setTimeout(() => resolve(handled), 0));

    await runTestEffect(Deferred.await(allHandled));
    expect(handled).toBe(total);
    expect(handledWhenTimerFired).toBeLessThan(total / 2);
  });

  test("spaced-out session updates don't pay an extra yield per message", async () => {
    let handled = 0;
    const clientToServer = new TransformStream<Uint8Array, Uint8Array>();
    const serverToClient = new TransformStream<Uint8Array, Uint8Array>();
    const connection = await runTestEffect(
      ClientSideConnection.make(
        () => ({
          requestPermission: () => Effect.succeed({ outcome: { outcome: "cancelled" } }),
          sessionUpdate: () =>
            Effect.sync(() => {
              handled += 1;
            }),
        }),
        { writable: clientToServer.writable, readable: serverToClient.readable },
      ),
    );
    const requests = clientToServer.readable.getReader();
    const responses = serverToClient.writable.getWriter();
    const sleepSpy = spyOn(Bun, "sleep");
    cleanup.push(async () => {
      sleepSpy.mockRestore();
      await runTestEffect(connection.close());
      requests.releaseLock();
      await responses.close().catch(() => undefined);
    });

    const update = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "session-1",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" } },
      },
    });
    for (let i = 0; i < 4; i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      await writeRawLine(responses, update);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(handled).toBe(4);
    expect(sleepSpy.mock.calls.filter(([ms]) => ms === 0)).toHaveLength(0);
  });

  test("valid notifications without ids are handled without responding", async () => {
    let updates = 0;
    const updateHandled = await runTestEffect(Deferred.make<void>());
    const clientToServer = new TransformStream<Uint8Array, Uint8Array>();
    const serverToClient = new TransformStream<Uint8Array, Uint8Array>();
    const connection = await runTestEffect(
      ClientSideConnection.make(
        () => ({
          requestPermission: () => Effect.succeed({ outcome: { outcome: "cancelled" } }),
          sessionUpdate: () =>
            Effect.sync(() => {
              updates += 1;
            }).pipe(Effect.andThen(Deferred.succeed(updateHandled, undefined))),
        }),
        {
          writable: clientToServer.writable,
          readable: serverToClient.readable,
        },
      ),
    );
    const requests = clientToServer.readable.getReader();
    const responses = serverToClient.writable.getWriter();
    cleanup.push(async () => {
      await runTestEffect(connection.close());
      requests.releaseLock();
      await responses.close().catch(() => undefined);
    });

    await writeJsonLine(responses, {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "session-1",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } },
      },
    });

    await runTestEffect(Deferred.await(updateHandled));
    await expectNoRequest(requests);
    expect(updates).toBe(1);
  });

  test("malformed session update notifications fail pending requests with protocol errors", async () => {
    const { connection: connectionPromise, requests, responses } = createConnectionHarness();
    const connection = await connectionPromise;
    cleanup.push(async () => {
      await runTestEffect(connection.close());
      requests.releaseLock();
      await responses.close().catch(() => undefined);
    });

    const resultPromise = runTestEffect(connection.listSessions({}));
    const request = await readJsonLine(requests);
    expect(request).toMatchObject({ method: "session/list" });

    await writeJsonLine(responses, {
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "session-1" },
    });

    await expect(resultPromise).rejects.toThrow("Invalid ACP session/update params; expected update.sessionUpdate");
  });

  test("unsupported session update notifications fail pending requests with protocol errors", async () => {
    const { connection: connectionPromise, requests, responses } = createConnectionHarness();
    const connection = await connectionPromise;
    cleanup.push(async () => {
      await runTestEffect(connection.close());
      requests.releaseLock();
      await responses.close().catch(() => undefined);
    });

    const resultPromise = runTestEffect(connection.listSessions({}));
    const request = await readJsonLine(requests);
    expect(request).toMatchObject({ method: "session/list" });

    await writeJsonLine(responses, {
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "session-1", update: { sessionUpdate: "stop_turn" } },
    });

    await expect(resultPromise).rejects.toThrow("Invalid ACP session/update params; unsupported sessionUpdate");
  });
});
