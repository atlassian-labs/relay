import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { MockTreeSitterClient } from "@opentui/core/testing";
import { installTreeSitterClientOverride } from "../src/ui/util/tree-sitter-client";

installTreeSitterClientOverride(new MockTreeSitterClient());

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-test-"));

process.env.HOME = path.join(testRoot, "home");
process.env.USERPROFILE = process.env.HOME;
process.env.XDG_CONFIG_HOME = path.join(testRoot, "config");
process.env.XDG_DATA_HOME = path.join(testRoot, "data");
process.env.XDG_CACHE_HOME = path.join(testRoot, "cache");
process.env.RELAY_TEST_ROOT = testRoot;
process.env.RELAY_DISABLE_NOTIFICATIONS = "1";

// Keep spawned shells (e.g. the ! / !! user-bash commands) hermetic. We redirect
// HOME above, but zsh still sources $ZDOTDIR/.zshenv and bash still sources
// $BASH_ENV / $ENV for non-interactive shells. Left pointing at the developer's
// real config, those startup files emit stderr noise (e.g. sourcing a file that
// only exists in the real home) that pollutes captured command output and makes
// tests pass/fail depending on the machine. Clear them so shells fall back to the
// isolated temp HOME, which has no startup files.
delete process.env.ZDOTDIR;
delete process.env.ENV;
delete process.env.BASH_ENV;

for (const dir of [
  process.env.HOME,
  process.env.XDG_CONFIG_HOME,
  process.env.XDG_DATA_HOME,
  process.env.XDG_CACHE_HOME,
]) {
  if (dir) fs.mkdirSync(dir, { recursive: true });
}

process.on("exit", () => {
  fs.rmSync(testRoot, { recursive: true, force: true });
});
