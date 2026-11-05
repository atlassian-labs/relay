import { createTextAttributes } from "@opentui/core";
import type { JSX } from "solid-js";
import { getColors } from "../context/theme";
import { truncateTextEnd } from "../util/format";
import { ShortcutHints, shortcutHintsText, type ShortcutHint } from "./shortcut-hints";

type ReactiveText = string | (() => string);
type ReactiveNumber = number | (() => number);

function textValue(value: ReactiveText | undefined): string {
  return typeof value === "function" ? value() : (value ?? "");
}

function numberValue(value: ReactiveNumber): number {
  return typeof value === "function" ? value() : value;
}

export function ModalHeader(props: {
  title: ReactiveText;
  width: ReactiveNumber;
  right?: ReactiveText;
  onRightMouseDown?: (event: { stopPropagation?: () => void }) => void;
  rightAccent?: boolean;
}) {
  const colors = getColors();
  const right = () => textValue(props.right);
  const titleWidth = () => Math.max(0, numberValue(props.width) - right().length - (right() ? 2 : 0));

  return (
    <box height={1} width="100%" flexDirection="row" justifyContent="space-between" flexShrink={0}>
      <text fg={colors.fg} attributes={createTextAttributes({ bold: true })} wrapMode="none">
        {truncateTextEnd(textValue(props.title), titleWidth())}
      </text>
      <text
        fg={props.rightAccent ? colors.accent : colors.textMuted}
        attributes={props.onRightMouseDown ? createTextAttributes({ underline: true }) : undefined}
        wrapMode="none"
        onMouseDown={props.onRightMouseDown}
      >
        {truncateTextEnd(right(), numberValue(props.width))}
      </text>
    </box>
  );
}

export function ModalFooter(props: {
  width: ReactiveNumber;
  left?: ReactiveText;
  right?: ReactiveText;
  leftHints?: readonly ShortcutHint[] | (() => readonly ShortcutHint[]);
  rightHints?: readonly ShortcutHint[] | (() => readonly ShortcutHint[]);
}) {
  const colors = getColors();
  const hintValue = (value: readonly ShortcutHint[] | (() => readonly ShortcutHint[]) | undefined) =>
    typeof value === "function" ? value() : value;
  const leftHints = () => hintValue(props.leftHints);
  const rightHints = () => hintValue(props.rightHints);
  const left = () => (leftHints() ? shortcutHintsText(leftHints()!) : textValue(props.left));
  const right = () =>
    truncateTextEnd(rightHints() ? shortcutHintsText(rightHints()!) : textValue(props.right), numberValue(props.width));
  const leftWidth = () => Math.max(0, numberValue(props.width) - right().length - (left() && right() ? 2 : 0));

  return (
    <box height={1} width="100%" flexDirection="row" justifyContent="space-between" flexShrink={0}>
      <text fg={colors.textSubtle} wrapMode="none">
        {leftHints() ? <ShortcutHints hints={leftHints()!} /> : truncateTextEnd(left(), leftWidth())}
      </text>
      <text fg={colors.textSubtle} wrapMode="none">
        {rightHints() ? <ShortcutHints hints={rightHints()!} /> : right()}
      </text>
    </box>
  );
}

export function ModalSectionHeading(props: { children: JSX.Element }) {
  const colors = getColors();
  return (
    <box height={1} flexShrink={0}>
      <text fg={colors.accent} attributes={createTextAttributes({ bold: true })}>
        {props.children}
      </text>
    </box>
  );
}

export function ModalKeyValue(props: { label: ReactiveText; value: ReactiveText }) {
  const colors = getColors();
  return (
    <box height={1} width="100%" flexDirection="row" justifyContent="space-between" flexShrink={0}>
      <text fg={colors.textMuted} wrapMode="none">
        {textValue(props.label)}
      </text>
      <text fg={colors.fg} wrapMode="none">
        {textValue(props.value)}
      </text>
    </box>
  );
}
