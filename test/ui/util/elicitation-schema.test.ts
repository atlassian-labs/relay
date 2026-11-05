import { describe, expect, test } from "bun:test";
import { choicesForSchemaProperty, fieldsFromElicitationSchema } from "../../../src/ui/util/elicitation-schema";

describe("elicitation schema utilities", () => {
  test("builds choices from oneOf const values", () => {
    expect(
      choicesForSchemaProperty({ oneOf: [{ const: "a", title: "A", description: "first" }, { const: "b" }] }),
    ).toEqual([
      { value: "a", title: "A", description: "first" },
      { value: "b", title: "b", description: undefined },
    ]);
  });

  test("builds choices from enum values", () => {
    expect(choicesForSchemaProperty({ enum: ["yes", "no"] }).map((c) => c.value)).toEqual(["yes", "no"]);
  });

  test("parses choices encoded in description suffix", () => {
    expect(choicesForSchemaProperty({ description: "Pick one — options: red, blue" }).map((c) => c.title)).toEqual([
      "red",
      "blue",
    ]);
  });

  test("builds fields and strips option suffix from descriptions", () => {
    expect(
      fieldsFromElicitationSchema({
        properties: {
          color: { type: "string", description: "Pick color — options: red, blue" },
        },
      }),
    ).toEqual([
      {
        key: "color",
        type: "string",
        title: "Pick color",
        description: undefined,
        choices: [
          { value: "red", title: "red", description: undefined },
          { value: "blue", title: "blue", description: undefined },
        ],
      },
    ]);
  });

  test("skips unsupported free-text fields when selectable fields are present", () => {
    expect(
      fieldsFromElicitationSchema({
        properties: {
          planet: { type: "string", title: "Planets", enum: ["Earth", "Mars"] },
          planet_other: { type: "string", title: "Other" },
          literature: { type: "string", title: "Literature", enum: ["Hamlet", "Dune"] },
        },
        required: ["planet", "planet_other", "literature"],
      }).map((field) => field.key),
    ).toEqual(["planet", "literature"]);
  });

  test("preserves schema title as the question when description encodes header and options", () => {
    expect(
      fieldsFromElicitationSchema({
        properties: {
          "What is the capital of France?": {
            type: "string",
            title: "What is the capital of France?",
            description: "Trivia #1 — options: Paris, Berlin",
          },
        },
      }),
    ).toEqual([
      {
        key: "What is the capital of France?",
        type: "string",
        title: "What is the capital of France?",
        description: undefined,
        choices: [
          { value: "Paris", title: "Paris", description: undefined },
          { value: "Berlin", title: "Berlin", description: undefined },
        ],
      },
    ]);
  });
});
