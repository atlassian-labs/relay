import { For, Show } from "solid-js";
import { createTextAttributes } from "@opentui/core";
import type { RelayLine } from "../../plugins";

export function RelayLineSpans(props: { line: RelayLine; fallbackFg?: string }) {
  return (
    <Show
      when={props.line.segments}
      fallback={
        <span
          style={
            {
              fg: props.line.fg ?? props.fallbackFg,
              bg: props.line.bg,
              bold: props.line.bold === true,
              underline: props.line.underline === true,
              strikethrough: props.line.strikethrough === true,
            } as never
          }
        >
          {props.line.text}
        </span>
      }
    >
      {(segments) => (
        <For each={segments()}>
          {(segment) => (
            <span
              style={
                {
                  fg: segment.fg ?? props.line.fg ?? props.fallbackFg,
                  bg: segment.bg ?? props.line.bg,
                  bold: segment.bold === true || props.line.bold === true,
                  underline: segment.underline === true || props.line.underline === true,
                  strikethrough: segment.strikethrough === true || props.line.strikethrough === true,
                } as never
              }
            >
              {segment.text}
            </span>
          )}
        </For>
      )}
    </Show>
  );
}

export function RelayLineText(props: { line: RelayLine; fallbackFg?: string }) {
  const attributes = () =>
    createTextAttributes({
      bold: props.line.bold === true,
      underline: props.line.underline === true,
      strikethrough: props.line.strikethrough === true,
    });
  return (
    <text fg={props.line.fg ?? props.fallbackFg} bg={props.line.bg} attributes={attributes()} wrapMode="none">
      <RelayLineSpans line={props.line} fallbackFg={props.fallbackFg} />
    </text>
  );
}
