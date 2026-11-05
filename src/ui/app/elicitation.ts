import type { ElicitationBlock, ElicitationField, ElicitationResponse, useApp } from "../state";
import { findPendingElicitationBlock } from "./approval-block";

type AppController = ReturnType<typeof useApp>;
type SetOptionIndex = (index: number) => void;

export function pendingElicitationBlock(app: AppController): ElicitationBlock | null {
  return findPendingElicitationBlock(app.state.blocks);
}

function choiceIndexForAnswer(field: ElicitationField | undefined, answers: Record<string, unknown>): number {
  if (!field) return 0;
  const answeredValue = answers[field.key];
  const index = field.choices.findIndex((choice) => choice.value === answeredValue);
  return index >= 0 ? index : 0;
}

export function elicitationOptionCount(block: ElicitationBlock, field: ElicitationField): number {
  return field.choices.length + (block.allowCustomEnumInput && field.choices.length > 0 ? 1 : 0);
}

export function isEditingCustomElicitationInput(block: ElicitationBlock, field?: ElicitationField): boolean {
  return field !== undefined && block.editingCustomFieldKey === field.key;
}

function hasAnswer(field: ElicitationField, answers: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(answers, field.key);
}

function answerableFields(block: ElicitationBlock): ElicitationField[] {
  return block.fields.filter((field) => field.choices.length > 0);
}

function requiredFieldsAnswered(block: ElicitationBlock, answers: Record<string, unknown> = block.answers): boolean {
  const fields = answerableFields(block);
  if (fields.length === 0) return false;
  const requiredFields = fields.filter((field) => field.required);
  const fieldsToAnswer = requiredFields.length > 0 ? requiredFields : fields;
  return fieldsToAnswer.every((field) => hasAnswer(field, answers));
}

function submitIndex(block: ElicitationBlock): number {
  return block.fields.length;
}

function normalizedFieldIndex(block: ElicitationBlock, index: number): number {
  const maxIndex = submitIndex(block);
  if (maxIndex <= 0) return 0;
  if (index < 0) return maxIndex;
  if (index > maxIndex) return 0;
  return index;
}

function focusElicitationIndex(
  app: AppController,
  block: ElicitationBlock,
  index: number,
  setOptionIndex: SetOptionIndex,
  answers: Record<string, unknown> = block.answers,
): void {
  const nextIndex = normalizedFieldIndex(block, index);
  app.updateBlock(block.id, { currentFieldIndex: nextIndex } as Partial<ElicitationBlock>);
  setOptionIndex(choiceIndexForAnswer(block.fields[nextIndex], answers));
}

export function finishElicitation(
  app: AppController,
  block: ElicitationBlock,
  response: ElicitationResponse,
  resetOptionIndex: () => void,
): void {
  block.respond?.(response);
  app.updateBlock(block.id, {
    status: response.action === "accept" ? "accepted" : response.action === "decline" ? "declined" : "cancelled",
    respond: undefined,
  } as Partial<ElicitationBlock>);
  resetOptionIndex();
}

export function navigateElicitationField(
  app: AppController,
  block: ElicitationBlock,
  delta: -1 | 1,
  setOptionIndex: SetOptionIndex,
): void {
  focusElicitationIndex(app, block, block.currentFieldIndex + delta, setOptionIndex);
}

export function submitElicitationText(
  app: AppController,
  block: ElicitationBlock,
  value: string,
  setOptionIndex: SetOptionIndex,
): void {
  const index = normalizedFieldIndex(block, block.currentFieldIndex);
  const field = block.fields[index];
  const customEnumInput = field ? isEditingCustomElicitationInput(block, field) : false;
  if (!field || field.type !== "string" || !customEnumInput) return;

  const text = value.trim();
  if (field.required && text.length === 0) return;
  const answers = { ...block.answers };
  if (text.length > 0) answers[field.key] = text;
  else delete answers[field.key];
  const nextIndex = normalizedFieldIndex(block, index + 1);
  app.updateBlock(block.id, {
    answers,
    currentFieldIndex: nextIndex,
    editingCustomFieldKey: undefined,
  } as Partial<ElicitationBlock>);
  setOptionIndex(choiceIndexForAnswer(block.fields[nextIndex], answers));
}

export function selectElicitationChoice(
  app: AppController,
  block: ElicitationBlock,
  optionIndex: number,
  setOptionIndex: SetOptionIndex,
): void {
  const index = normalizedFieldIndex(block, block.currentFieldIndex);
  if (index === submitIndex(block)) {
    if (!requiredFieldsAnswered(block)) {
      const fields = answerableFields(block);
      const hasExplicitRequiredFields = fields.some((field) => field.required);
      const firstUnansweredField = fields.find(
        (field) => (hasExplicitRequiredFields ? field.required : true) && !hasAnswer(field, block.answers),
      );
      const firstUnanswered = firstUnansweredField ? block.fields.indexOf(firstUnansweredField) : -1;
      focusElicitationIndex(app, block, firstUnanswered >= 0 ? firstUnanswered : 0, setOptionIndex);
      return;
    }
    finishElicitation(app, block, { action: "accept", content: block.answers }, () => setOptionIndex(0));
    return;
  }

  const field = block.fields[index];
  if (!field || field.choices.length === 0) return;
  const choice = field.choices[Math.min(optionIndex, field.choices.length - 1)];
  const answers = { ...block.answers, [field.key]: choice.value };
  const nextIndex = normalizedFieldIndex(block, index + 1);
  app.updateBlock(block.id, { answers, currentFieldIndex: nextIndex } as Partial<ElicitationBlock>);
  setOptionIndex(choiceIndexForAnswer(block.fields[nextIndex], answers));
}
