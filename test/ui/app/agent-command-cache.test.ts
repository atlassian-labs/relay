import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  agentCommandCacheKey,
  readCachedAgentCommands,
  writeCachedAgentCommands,
} from "../../../src/ui/app/agent-command-cache";
import { getCacheDir } from "../../../src/config";

const CACHE_FILE = "agent-slash-commands.json";

function cachePath(): string {
  return path.join(getCacheDir(), CACHE_FILE);
}

function key(suffix: string): string {
  return agentCommandCacheKey({
    agentName: `agent-${suffix}`,
    profile: "default",
    transport: "stdio",
    command: "agent",
    args: ["run"],
  });
}

describe("agent command cache", () => {
  test("clears cached commands when the authoritative command list is empty", () => {
    const cacheKey = key(`clear-${Date.now()}-${Math.random()}`);

    writeCachedAgentCommands(cacheKey, [{ name: "old-skill", description: "stale" }]);
    expect(readCachedAgentCommands(cacheKey)).toEqual([
      {
        name: "old-skill",
        description: "stale",
        origin: "agent",
        kind: "unknown",
        invocation: { syntax: "slash", composable: false },
      },
    ]);

    writeCachedAgentCommands(cacheKey, []);
    expect(readCachedAgentCommands(cacheKey)).toEqual([]);
  });

  test("ignores malformed persisted cache entries", () => {
    const cacheKey = key(`malformed-${Date.now()}-${Math.random()}`);
    fs.mkdirSync(getCacheDir(), { recursive: true });
    fs.writeFileSync(
      cachePath(),
      JSON.stringify({
        version: 1,
        entries: {
          [cacheKey]: {
            version: 1,
            commands: [{ name: "old-skill", description: "missing timestamp must not hydrate" }],
          },
        },
      }),
      "utf-8",
    );

    expect(readCachedAgentCommands(cacheKey)).toEqual([]);
  });

  test("ignores expired persisted cache entries", () => {
    const cacheKey = key(`expired-${Date.now()}-${Math.random()}`);
    fs.mkdirSync(getCacheDir(), { recursive: true });
    fs.writeFileSync(
      cachePath(),
      JSON.stringify({
        version: 1,
        entries: {
          [cacheKey]: {
            version: 1,
            updatedAt: 0,
            commands: [{ name: "old-skill", description: "expired command must not hydrate" }],
          },
        },
      }),
      "utf-8",
    );

    expect(readCachedAgentCommands(cacheKey)).toEqual([]);
  });

  test("keys include command-affecting launch environment", () => {
    const base = {
      agentName: "agent",
      profile: "default",
      transport: "stdio",
      command: "agent",
      args: ["run"],
    } as const;

    expect(agentCommandCacheKey({ ...base, env: { FEATURE_COMMANDS: "1" } })).not.toBe(
      agentCommandCacheKey({ ...base, env: { FEATURE_COMMANDS: "0" } }),
    );
    expect(agentCommandCacheKey({ ...base, env: { B: "2", A: "1" } })).toBe(
      agentCommandCacheKey({ ...base, env: { A: "1", B: "2" } }),
    );
  });
});
