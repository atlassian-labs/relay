import { createTextAttributes } from "@opentui/core";
import { For } from "solid-js";
import { getColors } from "../context/theme";

export interface ActionChoice {
  readonly label: string;
}

export interface ActionChoicesProps {
  readonly choices: readonly ActionChoice[];
  readonly selectedIndex: number;
  readonly direction?: "horizontal" | "vertical";
  readonly align?: "start" | "end";
  readonly gap?: number;
  readonly appearance?: "list" | "buttons";
}

/**
 * Shared action presentation for floating-list rows and background-filled
 * confirmation buttons. Button labels use padding rather than literal brackets.
 */
export function ActionChoices(props: ActionChoicesProps) {
  const colors = getColors();
  const horizontal = () => props.direction === "horizontal";
  const buttons = () => props.appearance === "buttons";
  const gap = () => " ".repeat(Math.max(0, props.gap ?? 2));

  return (
    <box
      width="100%"
      flexDirection={horizontal() ? "row" : "column"}
      justifyContent={horizontal() && props.align === "end" ? "flex-end" : "flex-start"}
    >
      <For each={props.choices}>
        {(choice, index) => {
          const selected = () => index() === props.selectedIndex;
          return (
            <>
              <text
                fg={selected() ? (buttons() ? colors.bg : colors.selected) : colors.textMuted}
                bg={selected() && buttons() ? colors.accent : undefined}
                attributes={selected() ? createTextAttributes({ bold: true }) : undefined}
                wrapMode="none"
              >
                {buttons() ? ` ${choice.label} ` : `${selected() ? "› " : "  "}${choice.label}`}
              </text>
              {horizontal() && index() < props.choices.length - 1 ? (
                <text fg={colors.textMuted} wrapMode="none">
                  {gap()}
                </text>
              ) : null}
            </>
          );
        }}
      </For>
    </box>
  );
}
