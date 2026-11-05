import { For, Show, type JSX } from "solid-js";
import { getColors } from "../context/theme";

/** A keyboard shortcut followed by its optional action caption. */
export type ShortcutHint = readonly [key: string, label?: string];

export function shortcutHintsText(hints: readonly ShortcutHint[], separator = " · "): string {
  return hints.map(([key, label]) => (label ? `${key} ${label}` : key)).join(separator);
}

/**
 * Shared keyboard-hint presentation: prominent key, subtle action, subtle separator.
 * Keep this aligned with the editor diff footer.
 */
export function ShortcutHints(props: {
  readonly hints: readonly ShortcutHint[];
  readonly separator?: string;
}): JSX.Element {
  const colors = getColors();
  const separator = () => props.separator ?? " · ";

  return (
    <For each={props.hints}>
      {([key, label], index) => (
        <>
          <Show when={index() > 0}>
            <span style={{ fg: colors.textSubtle } as never}>{separator()}</span>
          </Show>
          <span style={{ fg: colors.textLabel } as never}>{key}</span>
          <Show when={label}>
            <span style={{ fg: colors.textSubtle } as never}> {label}</span>
          </Show>
        </>
      )}
    </For>
  );
}
