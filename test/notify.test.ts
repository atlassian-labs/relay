import { describe, expect, test } from "bun:test";
import { Config } from "../src/config";
import { notifyEffect, type NotificationEvent } from "../src/notify";
import { runTestEffect } from "./lib/effect";

type RunCall = { command: string; args: string[] };
type TerminalCall = { title: string; message: string };

function environment(overrides: {
  terminalEnabled?: boolean;
  soundEnabled?: boolean;
  platform?: string;
  exists?: boolean;
  linuxPlayer?: string | null;
  eventPath?: string;
  volume?: number;
  run?: (command: string, args: string[]) => void;
  notifyTerminal?: (title: string, message: string) => boolean;
}) {
  return {
    config: new Config({
      notifications: {
        terminal_enabled: overrides.terminalEnabled ?? false,
        sound_enabled: overrides.soundEnabled ?? true,
        volume: overrides.volume ?? 0.5,
      },
    }),
    disabledByEnvironment: () => false,
    platform: overrides.platform ?? "darwin",
    soundPath: (event: NotificationEvent) => overrides.eventPath ?? `/sounds/${event}.wav`,
    exists: () => overrides.exists ?? true,
    linuxPlayer: () => overrides.linuxPlayer ?? "paplay",
    run: overrides.run ?? (() => undefined),
    notifyTerminal: overrides.notifyTerminal ?? (() => false),
  };
}

describe("notifyEffect", () => {
  test("does not expose permission replies as notification events", () => {
    type PermissionReplyEvent = Extract<NotificationEvent, "permission_replied">;
    const replyEventIsDisallowed: PermissionReplyEvent extends never ? true : false = true;

    expect(replyEventIsDisallowed).toBe(true);
  });

  test("does not spawn when sound notifications are disabled", async () => {
    const calls: RunCall[] = [];

    await runTestEffect(
      notifyEffect(
        "completion",
        {},
        environment({ soundEnabled: false, run: (command, args) => calls.push({ command, args }) }),
      ),
    );

    expect(calls).toEqual([]);
  });

  test("does not spawn when notifications are disabled by the environment", async () => {
    const calls: RunCall[] = [];

    await runTestEffect(
      notifyEffect(
        "completion",
        {},
        {
          ...environment({ run: (command, args) => calls.push({ command, args }) }),
          disabledByEnvironment: () => true,
        },
      ),
    );

    expect(calls).toEqual([]);
  });

  test("does not spawn when the sound file is missing", async () => {
    const calls: RunCall[] = [];

    await runTestEffect(
      notifyEffect("error", {}, environment({ exists: false, run: (command, args) => calls.push({ command, args }) })),
    );

    expect(calls).toEqual([]);
  });

  test("plays macOS sounds with afplay and configured volume", async () => {
    const calls: RunCall[] = [];

    await runTestEffect(
      notifyEffect(
        "elicitation",
        {},
        environment({
          platform: "darwin",
          eventPath: "/custom.wav",
          volume: 0.25,
          run: (command, args) => calls.push({ command, args }),
        }),
      ),
    );

    expect(calls).toEqual([{ command: "afplay", args: ["-v", "0.25", "/custom.wav"] }]);
  });

  test("plays Linux sounds with the detected player", async () => {
    const calls: RunCall[] = [];

    await runTestEffect(
      notifyEffect(
        "completion",
        {},
        environment({
          platform: "linux",
          linuxPlayer: "paplay",
          eventPath: "/completion.wav",
          volume: 0.5,
          run: (command, args) => calls.push({ command, args }),
        }),
      ),
    );

    expect(calls).toEqual([{ command: "paplay", args: ["--volume=32768", "/completion.wav"] }]);
  });

  test("emits a terminal notification through the injected notifier", async () => {
    const calls: TerminalCall[] = [];

    await runTestEffect(
      notifyEffect(
        "completion",
        { query: "build", response: "Final assistant answer." },
        environment({
          exists: false,
          terminalEnabled: true,
          notifyTerminal: (title, message) => {
            calls.push({ title, message });
            return true;
          },
        }),
      ),
    );

    expect(calls).toEqual([{ title: "Relay", message: "Final assistant answer." }]);
  });

  test("still plays sounds when terminal notification dispatch fails", async () => {
    const calls: RunCall[] = [];

    await runTestEffect(
      notifyEffect(
        "completion",
        { response: "done" },
        environment({
          terminalEnabled: true,
          soundEnabled: true,
          run: (command, args) => calls.push({ command, args }),
          notifyTerminal: () => {
            throw new Error("terminal failed");
          },
        }),
      ),
    );

    expect(calls).toEqual([{ command: "afplay", args: ["-v", "0.5", "/sounds/completion.wav"] }]);
  });

  test("still emits terminal notifications when sound playback fails", async () => {
    const calls: TerminalCall[] = [];

    await runTestEffect(
      notifyEffect(
        "completion",
        { response: "done" },
        environment({
          terminalEnabled: true,
          soundEnabled: true,
          run: () => {
            throw new Error("sound failed");
          },
          notifyTerminal: (title, message) => {
            calls.push({ title, message });
            return true;
          },
        }),
      ),
    );

    expect(calls).toEqual([{ title: "Relay", message: "done" }]);
  });

  test("builds a permission summary from the tool input preview", async () => {
    const calls: TerminalCall[] = [];

    await runTestEffect(
      notifyEffect(
        "permission",
        { toolName: "bash", toolInput: { command: "bun test" } },
        environment({
          exists: false,
          terminalEnabled: true,
          notifyTerminal: (title, message) => {
            calls.push({ title, message });
            return true;
          },
        }),
      ),
    );

    expect(calls).toEqual([{ title: "Relay", message: "Wants to run bash: bun test" }]);
  });

  test("permission terminal event omits empty tool input preview", async () => {
    const calls: TerminalCall[] = [];

    await runTestEffect(
      notifyEffect(
        "permission",
        { toolName: "bash", toolInput: {} },
        environment({
          exists: false,
          terminalEnabled: true,
          notifyTerminal: (title, message) => {
            calls.push({ title, message });
            return true;
          },
        }),
      ),
    );

    expect(calls).toEqual([{ title: "Relay", message: "Wants to run bash" }]);
  });

  test("sanitizes control characters out of the notification message", async () => {
    const calls: TerminalCall[] = [];

    await runTestEffect(
      notifyEffect(
        "elicitation",
        { summary: "line one\nline two\ttabbed" },
        environment({
          exists: false,
          terminalEnabled: true,
          notifyTerminal: (title, message) => {
            calls.push({ title, message });
            return true;
          },
        }),
      ),
    );

    expect(calls).toEqual([{ title: "Relay", message: "line one line two tabbed" }]);
  });

  test("does not emit terminal events when terminal notifications are disabled", async () => {
    const calls: TerminalCall[] = [];

    await runTestEffect(
      notifyEffect(
        "completion",
        {},
        environment({
          terminalEnabled: false,
          notifyTerminal: (title, message) => {
            calls.push({ title, message });
            return true;
          },
        }),
      ),
    );

    expect(calls).toEqual([]);
  });
});
