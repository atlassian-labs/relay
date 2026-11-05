import { describe, expect, test } from "bun:test";
import {
  applyStartupPromptKey,
  renderStartupPrompt,
  type StartupPromptConfig,
  type StartupPromptState,
} from "../../src/platform/startup-prompt";

const ESCAPE_CHARACTER = String.fromCharCode(27);
const ANSI_ESCAPE_PATTERN = new RegExp(`${ESCAPE_CHARACTER}\\[[0-?]*[ -/]*[@-~]`, "g");

function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE_PATTERN, "");
}

type Choice = "alpha" | "beta";

const config: StartupPromptConfig<Choice> = {
  header: ["  Test prompt", "", "  Pick one:"],
  options: [
    { value: "alpha", label: "Alpha option" },
    { value: "beta", label: "Beta option", isDefault: true },
  ],
  initialHighlight: "beta",
  skipValue: "beta",
  marker: ">",
  numbered: false,
};

const numberedConfig: StartupPromptConfig<Choice> = {
  ...config,
  marker: "›",
  numbered: true,
};

describe("startup prompt rendering", () => {
  test("renders header and options", () => {
    const rendered = stripAnsi(renderStartupPrompt(config, "beta"));
    expect(rendered).toContain("Test prompt");
    expect(rendered).toContain("Pick one:");
    expect(rendered).toContain("Alpha option");
    expect(rendered).toContain("> Beta option");
    expect(rendered).toContain("(default)");
    expect(rendered).toContain("Press enter to continue");
  });

  test("highlights the selected option", () => {
    const renderedAlpha = stripAnsi(renderStartupPrompt(config, "alpha"));
    expect(renderedAlpha).toContain("> Alpha option");
    expect(renderedAlpha).not.toContain("> Beta option");
  });

  test("numbered mode renders numeric prefixes", () => {
    const rendered = stripAnsi(renderStartupPrompt(numberedConfig, "alpha"));
    expect(rendered).toContain("1. Alpha option");
    expect(rendered).toContain("2. Beta option");
  });
});

describe("startup prompt key handling", () => {
  const state: StartupPromptState<Choice> = { highlighted: "alpha", selection: null };

  test("enter confirms current highlight", () => {
    expect(applyStartupPromptKey(state, "\r", config)).toEqual({ highlighted: "alpha", selection: "alpha" });
    expect(applyStartupPromptKey(state, "\n", config)).toEqual({ highlighted: "alpha", selection: "alpha" });
  });

  test("escape and ctrl-c select skip value", () => {
    expect(applyStartupPromptKey(state, "\x1b", config)).toEqual({ highlighted: "beta", selection: "beta" });
    expect(applyStartupPromptKey(state, "\x03", config)).toEqual({ highlighted: "beta", selection: "beta" });
    expect(applyStartupPromptKey(state, "\x04", config)).toEqual({ highlighted: "beta", selection: "beta" });
  });

  test("arrow down and j move to next option", () => {
    expect(applyStartupPromptKey(state, "\x1b[B", config)).toEqual({ highlighted: "beta", selection: null });
    expect(applyStartupPromptKey(state, "j", config)).toEqual({ highlighted: "beta", selection: null });
  });

  test("arrow up and k move to previous option", () => {
    const betaState: StartupPromptState<Choice> = { highlighted: "beta", selection: null };
    expect(applyStartupPromptKey(betaState, "\x1b[A", config)).toEqual({ highlighted: "alpha", selection: null });
    expect(applyStartupPromptKey(betaState, "k", config)).toEqual({ highlighted: "alpha", selection: null });
  });

  test("first-letter shortcut selects and confirms", () => {
    expect(applyStartupPromptKey(state, "a", config)).toEqual({ highlighted: "alpha", selection: "alpha" });
    expect(applyStartupPromptKey(state, "b", config)).toEqual({ highlighted: "beta", selection: "beta" });
    expect(applyStartupPromptKey(state, "B", config)).toEqual({ highlighted: "beta", selection: "beta" });
  });

  test("numbered mode allows numeric direct selection", () => {
    expect(applyStartupPromptKey(state, "1", numberedConfig)).toEqual({
      highlighted: "alpha",
      selection: "alpha",
    });
    expect(applyStartupPromptKey(state, "2", numberedConfig)).toEqual({
      highlighted: "beta",
      selection: "beta",
    });
  });

  test("does not move past boundaries", () => {
    expect(applyStartupPromptKey(state, "\x1b[A", config)).toEqual({ highlighted: "alpha", selection: null });
    const betaState: StartupPromptState<Choice> = { highlighted: "beta", selection: null };
    expect(applyStartupPromptKey(betaState, "\x1b[B", config)).toEqual({ highlighted: "beta", selection: null });
  });

  test("unrecognized keys are ignored", () => {
    expect(applyStartupPromptKey(state, "x", config)).toEqual(state);
    expect(applyStartupPromptKey(state, "z", config)).toEqual(state);
  });
});
