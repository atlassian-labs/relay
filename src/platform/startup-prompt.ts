// ---------------------------------------------------------------------------
// Shared full-screen startup prompt used before the TUI renders.
// The telemetry consent prompt delegates to
// this module for the raw-mode TTY interaction loop and ANSI rendering helpers.
// ---------------------------------------------------------------------------

// -- ANSI helpers ------------------------------------------------------------

export const ANSI = {
  RESET: "\x1b[0m",
  BOLD: "\x1b[1m",
  DIM: "\x1b[2m",
  CYAN: "\x1b[36m",
  HIDE_CURSOR: "\x1b[?25l",
  SHOW_CURSOR: "\x1b[?25h",
  CLEAR_SCREEN: "\x1b[2J\x1b[H",
} as const;

// -- Types -------------------------------------------------------------------

export interface StartupPromptOption<T extends string> {
  /** The value returned when this option is selected. */
  value: T;
  /** Display label shown to the user. */
  label: string;
  /** When true, "(default)" is appended in dim text. */
  isDefault?: boolean;
}

export interface StartupPromptConfig<T extends string> {
  /** Lines rendered above the option list. */
  header: string[];
  /** Selectable options shown as a vertical list. */
  options: StartupPromptOption<T>[];
  /** Which option value is highlighted initially. */
  initialHighlight: T;
  /** Value returned when the prompt is skipped (non-TTY, CI, etc.). */
  skipValue: T;
  /** Optional marker character for the highlighted row (default: `>`). */
  marker?: string;
  /** When true, options are rendered with 1-based numeric prefixes. */
  numbered?: boolean;
}

// -- Rendering ---------------------------------------------------------------

export function renderOptionLine<T extends string>(
  option: StartupPromptOption<T>,
  highlighted: boolean,
  index: number,
  config: Pick<StartupPromptConfig<T>, "marker" | "numbered">,
): string {
  const marker = config.marker ?? ">";
  const prefix = highlighted ? `${ANSI.CYAN}${marker}${ANSI.RESET}` : " ";
  const number = config.numbered ? `${index + 1}. ` : "";
  const suffix = option.isDefault ? `  ${ANSI.DIM}(default)${ANSI.RESET}` : "";
  return `  ${prefix} ${number}${option.label}${suffix}`;
}

export function renderStartupPrompt<T extends string>(config: StartupPromptConfig<T>, highlighted: T): string {
  const optionLines = config.options.map((opt, i) => renderOptionLine(opt, opt.value === highlighted, i, config));
  return [...config.header, "", ...optionLines, "", `  ${ANSI.DIM}Press enter to continue${ANSI.RESET}`, ""].join("\n");
}

// -- Key handling ------------------------------------------------------------

export interface StartupPromptState<T extends string> {
  highlighted: T;
  selection: T | null;
}

export function applyStartupPromptKey<T extends string>(
  state: StartupPromptState<T>,
  key: string,
  config: StartupPromptConfig<T>,
): StartupPromptState<T> {
  const values = config.options.map((o) => o.value);
  const currentIndex = values.indexOf(state.highlighted);

  // Escape / Ctrl-C / Ctrl-D -> select the skip/default value
  if (key === "\x03" || key === "\x04" || key === "\x1b") {
    return { highlighted: config.skipValue, selection: config.skipValue };
  }
  // Enter -> confirm current highlight
  if (key === "\r" || key === "\n") {
    return { ...state, selection: state.highlighted };
  }
  // Numeric direct selection (1-based)
  if (config.numbered) {
    const numIndex = parseInt(key, 10) - 1;
    if (numIndex >= 0 && numIndex < values.length) {
      const value = values[numIndex]!;
      return { highlighted: value, selection: value };
    }
  }
  // Letter shortcut: first character of each option's value (case-insensitive)
  const lower = key.toLowerCase();
  for (const opt of config.options) {
    if (opt.value[0]?.toLowerCase() === lower) {
      return { highlighted: opt.value, selection: opt.value };
    }
  }
  // Arrow / vim navigation
  if (key === "\x1b[A" || lower === "k") {
    const prev = currentIndex > 0 ? values[currentIndex - 1]! : values[0]!;
    return { ...state, highlighted: prev };
  }
  if (key === "\x1b[B" || lower === "j") {
    const next = currentIndex < values.length - 1 ? values[currentIndex + 1]! : values[values.length - 1]!;
    return { ...state, highlighted: next };
  }
  return state;
}

// -- Interactive runner ------------------------------------------------------

/**
 * True when a full-screen startup prompt can actually be shown. Callers that
 * need to distinguish "user answered" from "never asked" should check this
 * before running a prompt, since a skipped prompt resolves to `skipValue`.
 */
export function startupPromptSupported(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY && !process.env.CI);
}

export async function runStartupPrompt<T extends string>(config: StartupPromptConfig<T>): Promise<T> {
  if (!startupPromptSupported()) {
    return config.skipValue;
  }

  let state: StartupPromptState<T> = {
    highlighted: config.initialHighlight,
    selection: null,
  };

  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;

  const draw = () => {
    process.stdout.write(`${ANSI.CLEAR_SCREEN}${ANSI.HIDE_CURSOR}${renderStartupPrompt(config, state.highlighted)}`);
  };

  return await new Promise<T>((resolve) => {
    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode(wasRaw);
      process.stdout.write(`${ANSI.RESET}${ANSI.SHOW_CURSOR}\n`);
    };

    const finish = (selection: T) => {
      cleanup();
      process.stdout.write(ANSI.CLEAR_SCREEN);
      resolve(selection);
    };

    const onData = (chunk: Buffer) => {
      state = applyStartupPromptKey(state, chunk.toString("utf8"), config);
      if (state.selection) {
        finish(state.selection);
        return;
      }
      draw();
    };

    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
    draw();
  });
}
