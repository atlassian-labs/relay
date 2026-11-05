import { afterEach, expect, test } from "bun:test";
import { PluginRunner } from "../../src/plugins";
import { setPluginRunner } from "../../src/ui/app/plugin-runtime";
import { activeStartupTips } from "../../src/ui/app/status-indicators";

afterEach(() => {
  setPluginRunner(null);
});

test("plugin tips are included in startup tips while enabled", async () => {
  let enabled = true;
  const runner = new PluginRunner({ cwd: "/workspace" });

  await runner.register({
    info: { id: "test-tip", name: "test-tip", path: "/plugins/test-tip" },
    factory(relay) {
      relay.ui.addTip("Plugin conditional tip", { enabled: () => enabled });
      relay.ui.addTip("Plugin always tip");
    },
  });
  setPluginRunner(runner);

  expect(activeStartupTips()).toContain("Plugin conditional tip");
  expect(activeStartupTips()).toContain("Plugin always tip");

  enabled = false;
  expect(activeStartupTips()).not.toContain("Plugin conditional tip");
  expect(activeStartupTips()).toContain("Plugin always tip");

  runner.dispose();
  expect(activeStartupTips()).not.toContain("Plugin always tip");
});

test("plugin tip predicate failures are recorded and skipped", async () => {
  const runner = new PluginRunner({ cwd: "/workspace" });

  await runner.register({
    info: { id: "bad-tip", name: "bad-tip", path: "/plugins/bad-tip" },
    factory(relay) {
      relay.ui.addTip("Broken tip", {
        enabled() {
          throw new Error("tip failed");
        },
      });
    },
  });
  setPluginRunner(runner);

  expect(activeStartupTips()).not.toContain("Broken tip");
  expect(runner.diagnostics.some((entry) => entry.message.includes("Plugin tip predicate failed: tip failed"))).toBe(
    true,
  );

  runner.dispose();
});
