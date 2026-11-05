import { readFileSync } from "node:fs";

const expected = readFileSync(".bun-version", "utf8").trim();
const actual = Bun.version;

if (actual !== expected) {
  console.error(
    [
      `Relay requires Bun ${expected}; current runtime is Bun ${actual}.`,
      `Install the pinned version with: curl -fsSL https://bun.sh/install | bash -s -- bun-v${expected}`,
      `Then ensure 'bun --version' prints ${expected} before running Relay checks.`,
    ].join("\n"),
  );
  process.exit(1);
}
