import { describe, expect, test } from "bun:test";
import { disposeAcpClientsForShutdown, type AcpShutdownClient } from "../../src/acp/shutdown";

async function withWatchdog<T>(promise: Promise<T>, message: string): Promise<T> {
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        watchdog = setTimeout(() => reject(new Error(message)), 500);
      }),
    ]);
  } finally {
    if (watchdog) clearTimeout(watchdog);
  }
}

function delayedClient(delayMs: number): AcpShutdownClient & {
  readonly disposals: () => number;
  readonly forceDisposals: () => number;
} {
  let disposals = 0;
  let forceDisposals = 0;
  return {
    async disposeAsync() {
      await Bun.sleep(delayMs);
      disposals += 1;
    },
    forceDispose() {
      forceDisposals += 1;
    },
    disposals: () => disposals,
    forceDisposals: () => forceDisposals,
  };
}

describe("disposeAcpClientsForShutdown", () => {
  test("allows every client to dispose within the graceful budget", async () => {
    const client = delayedClient(10);

    const result = await disposeAcpClientsForShutdown([client], {
      disposeTimeoutMs: 100,
      forceSettleMs: 20,
    });

    expect(result.forced).toBe(false);
    expect(client.disposals()).toBe(1);
    expect(client.forceDisposals()).toBe(0);
  });

  test("does not let one rejected disposal hide another client that needs force disposal", async () => {
    let releaseHangingClient = () => {};
    let forceDisposals = 0;
    const disposeErrors: Error[] = [];
    const rejectingClient: AcpShutdownClient = {
      async disposeAsync() {
        throw new Error("dispose failed");
      },
      forceDispose() {
        forceDisposals += 1;
      },
    };
    const hangingClient: AcpShutdownClient = {
      disposeAsync: () =>
        new Promise<void>((resolve) => {
          releaseHangingClient = resolve;
        }),
      forceDispose() {
        forceDisposals += 1;
        releaseHangingClient();
      },
    };

    const result = await disposeAcpClientsForShutdown([rejectingClient, hangingClient], {
      disposeTimeoutMs: 20,
      forceSettleMs: 50,
      onDisposeError: (error) => disposeErrors.push(error),
    });

    expect(result.forced).toBe(true);
    expect(forceDisposals).toBe(2);
    expect(disposeErrors.map((error) => error.message)).toEqual(["dispose failed"]);
  });

  test("returns after the force-settle budget when graceful disposal never resolves", async () => {
    let forceDisposals = 0;
    const client: AcpShutdownClient = {
      disposeAsync: () => new Promise<void>(() => {}),
      forceDispose() {
        forceDisposals += 1;
      },
    };
    const result = await withWatchdog(
      disposeAcpClientsForShutdown([client], {
        disposeTimeoutMs: 20,
        forceSettleMs: 20,
      }),
      "shutdown did not honor its force-settle budget",
    );

    expect(result.forced).toBe(true);
    expect(forceDisposals).toBe(1);
  });

  test("does not let a throwing disposal-error observer skip forced cleanup", async () => {
    let releaseHangingClient = () => {};
    let forceDisposals = 0;
    const rejectingClient: AcpShutdownClient = {
      async disposeAsync() {
        throw new Error("dispose failed");
      },
      forceDispose() {
        forceDisposals += 1;
      },
    };
    const hangingClient: AcpShutdownClient = {
      disposeAsync: () =>
        new Promise<void>((resolve) => {
          releaseHangingClient = resolve;
        }),
      forceDispose() {
        forceDisposals += 1;
        releaseHangingClient();
      },
    };

    const result = await withWatchdog(
      disposeAcpClientsForShutdown([rejectingClient, hangingClient], {
        disposeTimeoutMs: 20,
        forceSettleMs: 50,
        onDisposeError() {
          throw new Error("observer failed");
        },
      }),
      "throwing disposal observer aborted forced cleanup",
    );

    expect(result.forced).toBe(true);
    expect(forceDisposals).toBe(2);
  });

  test("isolates force-disposal errors so every client is attempted", async () => {
    const forceDisposeErrors: Error[] = [];
    let successfulForceDisposals = 0;
    const throwingClient: AcpShutdownClient = {
      disposeAsync: () => new Promise<void>(() => {}),
      forceDispose() {
        throw new Error("force dispose failed");
      },
    };
    const successfulClient: AcpShutdownClient = {
      disposeAsync: () => new Promise<void>(() => {}),
      forceDispose() {
        successfulForceDisposals += 1;
      },
    };

    const result = await withWatchdog(
      disposeAcpClientsForShutdown([throwingClient, successfulClient], {
        disposeTimeoutMs: 20,
        forceSettleMs: 20,
        onForceDisposeError: (error) => forceDisposeErrors.push(error),
      }),
      "shutdown stopped after a force-disposal error",
    );

    expect(result.forced).toBe(true);
    expect(successfulForceDisposals).toBe(1);
    expect(forceDisposeErrors.map((error) => error.message)).toEqual(["force dispose failed"]);
  });

  test("does not let a throwing force-disposal observer skip later clients", async () => {
    let successfulForceDisposals = 0;
    const throwingClient: AcpShutdownClient = {
      disposeAsync: () => new Promise<void>(() => {}),
      forceDispose() {
        throw new Error("force dispose failed");
      },
    };
    const successfulClient: AcpShutdownClient = {
      disposeAsync: () => new Promise<void>(() => {}),
      forceDispose() {
        successfulForceDisposals += 1;
      },
    };

    const result = await withWatchdog(
      disposeAcpClientsForShutdown([throwingClient, successfulClient], {
        disposeTimeoutMs: 20,
        forceSettleMs: 20,
        onForceDisposeError() {
          throw new Error("observer failed");
        },
      }),
      "throwing force-disposal observer aborted shutdown",
    );

    expect(result.forced).toBe(true);
    expect(successfulForceDisposals).toBe(1);
  });
});
