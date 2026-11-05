import { describe, expect, test } from "bun:test";
import { getConfigSetting, getConfigSettingByAcpOptionId } from "../../src/config/schema";

describe("config schema", () => {
  test("does not expose notification settings as ACP-writable options", () => {
    expect(getConfigSettingByAcpOptionId("relay.notifications.terminal_enabled")).toBeUndefined();
    expect(getConfigSettingByAcpOptionId("relay.notifications.sound_enabled")).toBeUndefined();
    expect(getConfigSettingByAcpOptionId("relay.notifications.volume")).toBeUndefined();
  });

  test("does not expose fixed UI styling as ACP-writable options", () => {
    expect(getConfigSettingByAcpOptionId("relay.ui.color_tool_names")).toBeUndefined();
    expect(getConfigSettingByAcpOptionId("relay.ui.color_markdown_headings")).toBeUndefined();
    expect(getConfigSettingByAcpOptionId("relay.ui.wrap_tool_headers")).toBeUndefined();
  });

  test("defines terminal title prompt source as an editable choice", () => {
    const setting = getConfigSetting("ui.terminal_title_prompt_source");

    expect(setting?.type).toBe("choice");
    expect(setting?.default).toBe("smart");
    expect(setting?.choices?.()).toEqual(["smart", "first", "last"]);
  });
});
