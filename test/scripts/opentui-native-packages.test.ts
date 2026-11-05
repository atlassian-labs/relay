import { describe, expect, test } from "bun:test";

import { opentuiNativePackagesFromPackageJson } from "../../scripts/opentui-native-packages";

describe("opentuiNativePackagesFromPackageJson", () => {
  test("derives native OpenTUI externals from optional dependency metadata", () => {
    expect(
      opentuiNativePackagesFromPackageJson({
        optionalDependencies: {
          "@opentui/core-darwin-arm64": "0.3.2",
          "@opentui/core-linux-x64-musl": "0.3.2",
          "@opentui/solid": "0.3.2",
          "@scope/not-opentui-core-native": "1.0.0",
        },
      }),
    ).toEqual(["@opentui/core-darwin-arm64", "@opentui/core-linux-x64-musl"]);
  });

  test("does not fall back to a stale hard-coded native package list", () => {
    expect(opentuiNativePackagesFromPackageJson({ optionalDependencies: {} })).toEqual([]);
    expect(opentuiNativePackagesFromPackageJson({})).toEqual([]);
  });
});
