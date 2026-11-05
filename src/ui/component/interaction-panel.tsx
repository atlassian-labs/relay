import { For, Show, type JSX } from "solid-js";
import { getColors } from "../context/theme";
import { userMessageBackgroundColor } from "../util/user-message-style";

export interface InteractionPanelProps {
  readonly children: JSX.Element;
}

export interface InteractionChoice {
  readonly label: string;
  readonly description?: string;
}

export interface InteractionChoiceListProps {
  readonly choices: readonly InteractionChoice[];
  readonly activeIndex: number;
  readonly selectedIndex?: number;
  readonly accentColor?: string;
}

/** Shared bottom-pane surface for permission and elicitation interactions. */
export function InteractionPanel(props: InteractionPanelProps) {
  const colors = getColors();
  return (
    <box
      width="100%"
      paddingLeft={1}
      paddingRight={1}
      paddingTop={1}
      paddingBottom={1}
      flexDirection="column"
      flexShrink={0}
      backgroundColor={userMessageBackgroundColor(colors)}
    >
      {props.children}
    </box>
  );
}

/** Choice rows shared by one-step permissions and multi-field elicitations. */
export function InteractionChoiceList(props: InteractionChoiceListProps) {
  const colors = getColors();
  const accent = () => props.accentColor ?? colors.accent;

  return (
    <box flexDirection="column">
      <For each={props.choices}>
        {(choice, index) => {
          const active = () => index() === props.activeIndex;
          const selected = () => index() === props.selectedIndex;
          return (
            <text wrapMode="none">
              <span style={{ fg: active() ? accent() : colors.textMuted, bold: active() } as never}>
                {active() ? "› " : "  "}
              </span>
              <Show when={props.selectedIndex !== undefined}>
                <span style={{ fg: selected() ? accent() : colors.textMuted } as never}>
                  {selected() ? "● " : "○ "}
                </span>
              </Show>
              <span
                style={
                  {
                    fg: active() ? colors.fg : selected() ? colors.fg : colors.textLabel,
                    bold: active(),
                  } as never
                }
              >
                {choice.label}
              </span>
              <Show when={choice.description}>
                <span style={{ fg: colors.textSubtle } as never}>{`  ${choice.description}`}</span>
              </Show>
            </text>
          );
        }}
      </For>
    </box>
  );
}
