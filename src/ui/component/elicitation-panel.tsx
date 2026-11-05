import { createTextAttributes } from "@opentui/core";
import { For, Show, onCleanup } from "solid-js";
import { useApp, type ElicitationBlock, type ElicitationField } from "../state";
import { getColors } from "../context/theme";
import { truncateTextEnd } from "../util/format";
import { ENTER_KEY_NAMES } from "../util/key-events";
import { isEditingCustomElicitationInput, submitElicitationText } from "../app/elicitation";
import { InteractionChoiceList, InteractionPanel } from "./interaction-panel";
import { ShortcutHints } from "./shortcut-hints";

const ELICITATION_ENTER_KEY_BINDINGS = ENTER_KEY_NAMES.flatMap((name) => [
  { name, shift: false, action: "submit" as const },
  { name, shift: true, action: "newline" as const },
]);

export interface ElicitationPanelProps {
  block: ElicitationBlock;
  optionIndex: () => number;
  setOptionIndex?: (index: number) => void;
}

function CustomElicitationField(props: {
  block: ElicitationBlock;
  field: ElicitationField;
  setOptionIndex: (index: number) => void;
}) {
  const app = useApp();
  const colors = getColors();
  let textarea: any;
  let focusTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => {
    if (focusTimer) clearTimeout(focusTimer);
    try {
      textarea?.blur?.();
    } catch {}
    textarea = undefined;
  });
  const currentAnswer = props.block.answers[props.field.key];
  const initialValue =
    typeof currentAnswer === "string" && !props.field.choices.some((choice) => choice.value === currentAnswer)
      ? currentAnswer
      : "";
  return (
    <>
      <box height={1} flexDirection="row">
        <text>
          <span style={{ fg: colors.accent, bold: true } as never}>› </span>
          <span style={{ fg: colors.textMuted } as never}>○ </span>
        </text>
        <textarea
          ref={(ref: any) => {
            textarea = ref;
            focusTimer = setTimeout(() => {
              try {
                textarea?.focus?.();
              } catch {}
            }, 0);
          }}
          flexGrow={1}
          wrapMode="word"
          initialValue={initialValue}
          placeholder="Type your own answer…"
          placeholderColor={colors.textMuted}
          textColor={colors.fg}
          focusedTextColor={colors.fg}
          keyBindings={ELICITATION_ENTER_KEY_BINDINGS}
          onMouseDown={(event: any) => {
            event.stopPropagation?.();
            event.target?.focus?.();
          }}
          onSubmit={() => {
            const value = textarea?.plainText ?? textarea?.editBuffer?.getText?.() ?? "";
            submitElicitationText(app, props.block, value, props.setOptionIndex);
          }}
        />
      </box>
      <text>{""}</text>
      <text fg={colors.textMuted}>
        <ShortcutHints
          hints={[
            ["enter", "continue"],
            ["shift+enter", "newline"],
            ["esc", "cancel"],
          ]}
        />
      </text>
    </>
  );
}

function fieldAnswered(block: ElicitationBlock, field: ElicitationBlock["fields"][number]): boolean {
  return Object.prototype.hasOwnProperty.call(block.answers, field.key);
}

function requiredAnswered(block: ElicitationBlock): boolean {
  const answerableFields = block.fields.filter((field) => field.choices.length > 0);
  if (answerableFields.length === 0) return false;
  const requiredFields = answerableFields.filter((field) => field.required);
  const fieldsToAnswer = requiredFields.length > 0 ? requiredFields : answerableFields;
  return fieldsToAnswer.every((field) => fieldAnswered(block, field));
}

function tabLabel(field: ElicitationBlock["fields"][number]): string {
  const keyLabel = field.key.replace(/[_-]+/g, " ").trim();
  const title = (field.title || field.key).trim();
  const label = keyLabel && keyLabel.length < title.length && keyLabel.length <= 24 ? keyLabel : title;
  return truncateTextEnd(label, 18);
}

function reviewLabel(field: ElicitationBlock["fields"][number]): string {
  const label = (field.title || field.key).trim();
  return label.length > 64 ? `${label.slice(0, 64)}...` : label;
}

export function ElicitationPanel(props: ElicitationPanelProps) {
  const app = useApp();
  const colors = getColors();
  const activeField = () => props.block.fields[props.block.currentFieldIndex];
  const isSingleChoiceQuestion = () =>
    props.block.fields.length === 1 && (props.block.fields[0]?.choices.length ?? 0) > 0;
  const showStepNavigation = () => !isSingleChoiceQuestion();
  const submitActive = () => props.block.currentFieldIndex >= props.block.fields.length;
  const answerForField = (field: ElicitationBlock["fields"][number]) => {
    const value = props.block.answers[field.key];
    return field.choices.find((choice) => choice.value === value)?.title ?? String(value ?? "");
  };
  const renderTabs = () => (
    <text>
      <span style={{ fg: colors.textMuted } as never}>← </span>
      <For each={props.block.fields}>
        {(field, index) => {
          const active = () => index() === props.block.currentFieldIndex;
          const answered = () => fieldAnswered(props.block, field);
          return (
            <>
              <span
                style={
                  {
                    fg: active() ? colors.bg : answered() ? colors.accent : colors.textLabel,
                    bg: active() ? colors.accent : colors.bg,
                    bold: active(),
                  } as never
                }
              >{` ${answered() ? "✓ " : ""}${tabLabel(field)} `}</span>
              <span style={{ fg: colors.textMuted } as never}> </span>
            </>
          );
        }}
      </For>
      <span
        style={
          {
            fg: submitActive() ? colors.bg : requiredAnswered(props.block) ? colors.accent : colors.textLabel,
            bg: submitActive() ? (requiredAnswered(props.block) ? colors.accent : colors.notice) : colors.bg,
            bold: submitActive(),
          } as never
        }
      >{` ${requiredAnswered(props.block) ? "✓ " : ""}Submit `}</span>
      <span style={{ fg: colors.textMuted } as never}> →</span>
    </text>
  );

  return (
    <InteractionPanel>
      <Show when={showStepNavigation()}>{renderTabs()}</Show>
      <Show
        when={submitActive()}
        fallback={
          <Show when={activeField()}>
            {(field) => (
              <>
                <Show when={showStepNavigation()}>
                  <text>{""}</text>
                </Show>
                <Show
                  when={field().choices.length > 0}
                  fallback={
                    <>
                      <text fg={colors.notice} attributes={createTextAttributes({ bold: true })}>
                        Question
                      </text>
                      <text fg={colors.fg}>{field().title || props.block.message}</text>
                      <text>
                        <span style={{ fg: colors.textMuted } as never}>Unsupported form field · </span>
                        <span style={{ fg: colors.textLabel } as never}>←/→</span>
                        <span style={{ fg: colors.textSubtle } as never}> navigate · </span>
                        <span style={{ fg: colors.textLabel } as never}>esc</span>
                        <span style={{ fg: colors.textSubtle } as never}> cancel</span>
                      </text>
                    </>
                  }
                >
                  <text>
                    <span style={{ fg: colors.accent, bold: true } as never}>✦ Question</span>
                    <Show when={props.block.fields.length > 1}>
                      <span
                        style={{ fg: colors.textMuted } as never}
                      >{` ${props.block.currentFieldIndex + 1} of ${props.block.fields.length}`}</span>
                    </Show>
                  </text>
                  <text>{""}</text>
                  <text fg={colors.fg}>{field().title || props.block.message}</text>
                  <Show when={field().description}>
                    <text fg={colors.textSubtle}>{field().description}</text>
                  </Show>
                  <box marginTop={1} flexDirection="column">
                    <InteractionChoiceList
                      choices={field().choices.map((choice) => ({
                        label: choice.title,
                        ...(choice.description ? { description: choice.description } : {}),
                      }))}
                      activeIndex={props.optionIndex()}
                      selectedIndex={field().choices.findIndex(
                        (choice) => props.block.answers[field().key] === choice.value,
                      )}
                    />
                  </box>
                  <Show when={props.block.allowCustomEnumInput}>
                    <Show
                      when={isEditingCustomElicitationInput(props.block, field())}
                      fallback={
                        <text
                          onMouseDown={() => {
                            props.setOptionIndex?.(field().choices.length);
                            app.updateBlock(props.block.id, {
                              editingCustomFieldKey: field().key,
                            } as Partial<ElicitationBlock>);
                          }}
                        >
                          <span style={{ fg: colors.textMuted } as never}>{"  "}</span>
                          <span style={{ fg: colors.textMuted } as never}>○ </span>
                          <span style={{ fg: colors.textLabel } as never}>Type your own answer…</span>
                        </text>
                      }
                    >
                      <CustomElicitationField
                        block={props.block}
                        field={field()}
                        setOptionIndex={props.setOptionIndex ?? (() => {})}
                      />
                    </Show>
                  </Show>
                  <Show when={!isEditingCustomElicitationInput(props.block, field())}>
                    <text>{""}</text>
                    <text fg={colors.textMuted}>
                      <ShortcutHints
                        hints={
                          showStepNavigation()
                            ? [
                                ["←/→", "navigate questions"],
                                ["↑/↓", "navigate options"],
                                ["enter", "select"],
                                ["esc", "cancel"],
                              ]
                            : [
                                ["↑/↓", "navigate"],
                                ["enter", "review"],
                                ["esc", "cancel"],
                              ]
                        }
                      />
                    </text>
                  </Show>
                </Show>
              </>
            )}
          </Show>
        }
      >
        <Show when={showStepNavigation()}>
          <text>{""}</text>
        </Show>
        <text fg={colors.fg} attributes={createTextAttributes({ bold: true })}>
          Review answers
        </text>
        <box marginTop={1} flexDirection="column">
          <For each={props.block.fields}>
            {(field, index) => (
              <text>
                <span style={{ fg: fieldAnswered(props.block, field) ? colors.accent : colors.textMuted } as never}>
                  {fieldAnswered(props.block, field) ? "✓ " : "□ "}
                </span>
                <span style={{ fg: colors.textLabel } as never}>{`${index() + 1}. ${reviewLabel(field)}`}</span>
                <Show when={fieldAnswered(props.block, field)}>
                  <span style={{ fg: colors.textMuted } as never}> — </span>
                  <span style={{ fg: colors.fg } as never}>{answerForField(field)}</span>
                </Show>
                <Show when={!fieldAnswered(props.block, field) && field.required}>
                  <span style={{ fg: colors.notice } as never}> — required</span>
                </Show>
              </text>
            )}
          </For>
        </box>
        <text>{""}</text>
        <text fg={colors.textMuted}>
          {requiredAnswered(props.block)
            ? showStepNavigation()
              ? "←/→ navigate questions · enter submit · esc cancel"
              : "← edit answer · enter submit · esc cancel"
            : "←/→ navigate missing questions · enter jumps to first missing · esc cancel"}
        </text>
      </Show>
    </InteractionPanel>
  );
}
