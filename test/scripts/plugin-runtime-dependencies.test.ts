import { describe, expect, test } from "bun:test";
import { pluginRuntimeDependencies } from "../../scripts/plugin-runtime-dependencies";

describe("plugin runtime dependencies", () => {
  test("keeps plugin-owned packages but excludes Relay's SDK", () => {
    expect(
      pluginRuntimeDependencies({
        dependencies: {
          "@atlassian/relay-plugin-sdk": "0.6.0",
          "@pierre/diffs": "1.2.12",
          zod: "4.4.3",
        },
      }),
    ).toEqual({ "@pierre/diffs": "1.2.12", zod: "4.4.3" });
  });

  test("ignores missing and malformed dependency entries", () => {
    expect(pluginRuntimeDependencies(null)).toEqual({});
    expect(pluginRuntimeDependencies({ dependencies: { valid: "1.0.0", invalid: 2, empty: "" } })).toEqual({
      valid: "1.0.0",
    });
  });
});
