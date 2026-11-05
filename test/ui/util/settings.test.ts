import { describe, expect, test } from "bun:test";
import { Config } from "../../../src/config";
import { coercePluginSettingValue } from "../../../src/plugins/types";
import type { RelayPluginSettingDefinition } from "../../../src/plugins/types";
import {
  buildAcpConfigOptionValueItems,
  buildSettingsItems,
  formatAcpConfigOptionCaption,
  formatAcpConfigOptionTitle,
  formatAcpConfigOptionValue,
  formatPluginSettingValue,
  nextAcpConfigOptionValue,
  nextPluginSettingValue,
} from "../../../src/ui/util/settings";

const booleanDef: RelayPluginSettingDefinition = {
  title: "Show badge",
  description: "Display a badge.",
  type: "boolean",
  default: true,
};

const choiceDef: RelayPluginSettingDefinition = {
  title: "Format",
  description: "Clock format.",
  type: "choice",
  default: "%H:%M",
  choices: () => ["%H:%M", "%I:%M %p", "%H:%M:%S"],
};

const intDef: RelayPluginSettingDefinition = {
  title: "Count",
  description: "Item count.",
  type: "integer",
  default: 1,
  min: 1,
  max: 3,
};

describe("coercePluginSettingValue", () => {
  test("returns default for undefined", () => {
    expect(coercePluginSettingValue(undefined, booleanDef)).toBe(true);
  });

  test("returns default for null", () => {
    expect(coercePluginSettingValue(null, booleanDef)).toBe(true);
  });

  test("boolean: passes through correct type", () => {
    expect(coercePluginSettingValue(false, booleanDef)).toBe(false);
    expect(coercePluginSettingValue(true, booleanDef)).toBe(true);
  });

  test("boolean: returns default for wrong type", () => {
    expect(coercePluginSettingValue("yes", booleanDef)).toBe(true);
    expect(coercePluginSettingValue(1, booleanDef)).toBe(true);
  });

  test("choice: passes through a valid choice", () => {
    expect(coercePluginSettingValue("%I:%M %p", choiceDef)).toBe("%I:%M %p");
  });

  test("choice: returns default for value not in list", () => {
    expect(coercePluginSettingValue("invalid", choiceDef)).toBe("%H:%M");
    expect(coercePluginSettingValue(42, choiceDef)).toBe("%H:%M");
  });

  test("integer: passes through in-range integer", () => {
    expect(coercePluginSettingValue(2, intDef)).toBe(2);
  });

  test("integer: rounds float to integer", () => {
    expect(coercePluginSettingValue(1.7, intDef)).toBe(2);
  });

  test("integer: returns default when out of range", () => {
    expect(coercePluginSettingValue(0, intDef)).toBe(1);
    expect(coercePluginSettingValue(4, intDef)).toBe(1);
  });

  test("integer: returns default for non-number", () => {
    expect(coercePluginSettingValue("2", intDef)).toBe(1);
  });
});

describe("formatPluginSettingValue", () => {
  test("boolean true -> on", () => {
    expect(formatPluginSettingValue(booleanDef, true)).toBe("on");
  });

  test("boolean false -> off", () => {
    expect(formatPluginSettingValue(booleanDef, false)).toBe("off");
  });

  test("non-boolean stringifies", () => {
    expect(formatPluginSettingValue(choiceDef, "%H:%M")).toBe("%H:%M");
    expect(formatPluginSettingValue(intDef, 3)).toBe("3");
  });
});

describe("nextPluginSettingValue", () => {
  test("boolean toggles", () => {
    expect(nextPluginSettingValue(true, booleanDef)).toBe(false);
    expect(nextPluginSettingValue(false, booleanDef)).toBe(true);
  });

  test("choice cycles forward", () => {
    expect(nextPluginSettingValue("%H:%M", choiceDef)).toBe("%I:%M %p");
    expect(nextPluginSettingValue("%I:%M %p", choiceDef)).toBe("%H:%M:%S");
    expect(nextPluginSettingValue("%H:%M:%S", choiceDef)).toBe("%H:%M");
  });

  test("choice with unknown current starts from index 0", () => {
    expect(nextPluginSettingValue("unknown", choiceDef)).toBe("%H:%M");
  });

  test("integer increments and wraps at max back to min", () => {
    expect(nextPluginSettingValue(1, intDef)).toBe(2);
    expect(nextPluginSettingValue(2, intDef)).toBe(3);
    expect(nextPluginSettingValue(3, intDef)).toBe(1);
  });
});

describe("buildSettingsItems", () => {
  test("includes terminal title prompt source as an editable setting", () => {
    const config = new Config({ ui: { terminal_title_prompt_source: "last" } });
    const items = buildSettingsItems(config);

    expect(items.some((item) => item.label === "terminal title prompt source: last")).toBe(true);
  });

  test("includes Mermaid rendering mode as an editable setting", () => {
    const config = new Config({ ui: { mermaid_rendering: "final" } });
    const items = buildSettingsItems(config);

    expect(items.some((item) => item.label === "mermaid rendering: final")).toBe(true);
  });

  test("does not include fixed styling as editable settings", () => {
    const config = new Config({});
    const items = buildSettingsItems(config);

    expect(items.some((item) => item.label.startsWith("wrap tool headers:"))).toBe(false);
    expect(items.some((item) => item.label.startsWith("color tool names:"))).toBe(false);
    expect(items.some((item) => item.label.startsWith("color markdown headings:"))).toBe(false);
    expect(items.some((item) => item.label === "tips: on")).toBe(true);
  });

  test("shows persisted thinking visibility as on/off and omits startup tips", () => {
    const visibleItems = buildSettingsItems(new Config({ ui: { show_thinking: true } }));
    const hiddenItems = buildSettingsItems(new Config({ ui: { show_thinking: false } }));

    expect(visibleItems.some((item) => item.label === "thinking visibility: on")).toBe(true);
    expect(hiddenItems.some((item) => item.label === "thinking visibility: off")).toBe(true);
    expect(visibleItems.some((item) => item.label.includes("startup tips"))).toBe(false);
  });
});

describe("buildSettingsItems with plugin settings", () => {
  test("includes plugin-setting items after core settings", () => {
    const config = new Config({});
    const plugin = { id: "global:/clock:0", name: "clock", path: "/clock" };
    const items = buildSettingsItems(config, [{ plugin, key: "format", definition: choiceDef }]);

    const pluginItems = items.filter((item) => item.value.type === "plugin-setting");
    expect(pluginItems).toHaveLength(1);
    expect(pluginItems[0]?.value.type).toBe("plugin-setting");
    if (pluginItems[0]?.value.type === "plugin-setting") {
      expect(pluginItems[0].value.key).toBe("format");
      expect(pluginItems[0].value.plugin.name).toBe("clock");
      expect(pluginItems[0].value.currentValue).toBe("%H:%M");
    }
  });

  test("plugin-setting label includes plugin name, setting title, and current value", () => {
    const config = new Config({});
    const plugin = { id: "global:/clock:0", name: "clock", path: "/clock" };
    const items = buildSettingsItems(config, [{ plugin, key: "show_badge", definition: booleanDef }]);

    const pluginItem = items.find((item) => item.value.type === "plugin-setting");
    expect(pluginItem?.label).toBe("clock: show badge: on");
  });

  test("returns no plugin-setting items when none provided", () => {
    const config = new Config({});
    const items = buildSettingsItems(config);
    expect(items.filter((item) => item.value.type === "plugin-setting")).toHaveLength(0);
  });

  test("plugin-setting item is active for boolean true", () => {
    const config = new Config({});
    const plugin = { id: "global:/p:0", name: "p", path: "/p" };
    const items = buildSettingsItems(config, [{ plugin, key: "badge", definition: booleanDef }]);
    const pluginItem = items.find((item) => item.value.type === "plugin-setting");
    expect(pluginItem?.active).toBe(true);
  });
});

describe("buildSettingsItems with ACP config options", () => {
  test("shows generic ACP selects and hides native selectors and reasoning effort", () => {
    const config = new Config({});
    const items = buildSettingsItems(config, [], {
      acpConfigOptions: [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "sonnet",
          options: [{ value: "sonnet", name: "Sonnet" }],
          raw: {},
        },
        {
          id: "custom-model-selector",
          name: "Custom Model",
          category: "model",
          type: "select",
          currentValue: "opus",
          options: [{ value: "opus", name: "Opus" }],
          raw: {},
        },
        {
          id: "vendor-boolean",
          name: "Vendor Boolean",
          category: "_vendor.boolean",
          type: "boolean",
          currentValue: true,
          options: [],
          raw: {},
        },
        {
          id: "vendor-select",
          name: "Vendor Select",
          category: "_vendor.select",
          type: "select",
          currentValue: "beta",
          options: [
            { value: "alpha", name: "Alpha" },
            { value: "beta", name: "Beta" },
          ],
          raw: {},
        },
        {
          id: "thought_level",
          name: "Thinking",
          category: "thought_level",
          type: "select",
          currentValue: "high",
          options: [
            { value: "low", name: "Low" },
            { value: "high", name: "High", description: "More depth" },
          ],
          raw: {},
        },
      ],
    });

    const acpItems = items.filter((item) => item.value.type === "acp-config-option");
    expect(acpItems).toHaveLength(1);
    expect(acpItems[0]?.label).toBe("vendor select: Beta");
    expect(acpItems.some((item) => item.label.startsWith("reasoning effort:"))).toBe(false);
  });
});

describe("ACP config option helpers", () => {
  const option = {
    id: "thought_level",
    name: "Thinking",
    category: "thought_level",
    type: "select",
    currentValue: "high",
    options: [
      { value: "low", name: "Low" },
      { value: "high", name: "High" },
    ],
    raw: {},
  };

  test("labels thought level as reasoning effort", () => {
    expect(formatAcpConfigOptionTitle(option)).toBe("Reasoning effort");
  });

  test("formats current values with advertised choice names", () => {
    expect(formatAcpConfigOptionValue(option, "low")).toBe("Low");
    expect(formatAcpConfigOptionValue(option, "xhigh")).toBe("xhigh");
  });

  test("uses a clearer reasoning effort caption when the agent only says thinking", () => {
    expect(formatAcpConfigOptionCaption(option)).toBe(
      "choose how much reasoning effort the agent uses before responding",
    );
  });

  test("builds nested ACP config value menu items", () => {
    const items = buildAcpConfigOptionValueItems(option);
    expect(items.map((item) => item.label)).toEqual(["Low", "High"]);
    expect(items.map((item) => item.value.value)).toEqual(["low", "high"]);
    expect(items[1]?.active).toBe(true);
  });

  test("cycles to the next advertised value", () => {
    expect(nextAcpConfigOptionValue(option)).toBe("low");
  });
});
