import type { ElicitationChoice, ElicitationField } from "../state";

export function choiceFromValue(value: unknown, title?: unknown, description?: unknown): ElicitationChoice {
  const stringValue = String(value);
  return {
    value: stringValue,
    title: typeof title === "string" && title.length > 0 ? title : stringValue,
    description: typeof description === "string" && description.length > 0 ? description : undefined,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function choicesForSchemaProperty(property: unknown): ElicitationChoice[] {
  const propertyRecord = asRecord(property);
  if (!propertyRecord) return [];

  if (Array.isArray(propertyRecord.oneOf)) {
    return propertyRecord.oneOf.flatMap((entry) => {
      const entryRecord = asRecord(entry);
      if (!entryRecord || !Object.prototype.hasOwnProperty.call(entryRecord, "const")) return [];
      return [choiceFromValue(entryRecord.const, entryRecord.title, entryRecord.description)];
    });
  }
  if (Array.isArray(propertyRecord.enum)) {
    return propertyRecord.enum.map((entry) => choiceFromValue(entry));
  }
  // Parse options encoded in description: "Some header — options: A, B, C"
  if (typeof propertyRecord.description === "string") {
    const optionsSuffix = " — options: ";
    const idx = propertyRecord.description.indexOf(optionsSuffix);
    if (idx !== -1) {
      const optionsPart = propertyRecord.description.slice(idx + optionsSuffix.length);
      return optionsPart.split(",").map((label: string) => choiceFromValue(label.trim()));
    }
  }
  return [];
}

export function fieldsFromElicitationSchema(schema: unknown): ElicitationField[] {
  const rawSchema = asRecord(schema);
  const propertiesValue = rawSchema?.properties;
  const properties = asRecord(propertiesValue) ?? {};
  const required = new Set(
    Array.isArray(rawSchema?.required) ? rawSchema.required.filter((key) => typeof key === "string") : [],
  );
  const fields = Object.entries(properties).map(([key, property]) => {
    const propertyRecord = asRecord(property) ?? {};
    const rawTitle: string | undefined =
      typeof propertyRecord.title === "string" && propertyRecord.title.length > 0 ? propertyRecord.title : undefined;
    const rawDescription: string | undefined =
      typeof propertyRecord.description === "string" ? propertyRecord.description : undefined;
    // Descriptions may encode option labels as "<header> — options: ...".
    // When the schema has an explicit title, keep it as the question text and only use the description for choices.
    const optionsSuffix = " — options: ";
    let displayTitle: string = rawTitle ?? key;
    let displayDescription: string | undefined = rawDescription;
    if (rawDescription) {
      const idx = rawDescription.indexOf(optionsSuffix);
      if (idx !== -1) {
        displayTitle = (rawTitle ?? rawDescription.slice(0, idx)) || key;
        displayDescription = undefined; // options shown as choices, not description
      } else {
        displayTitle = (rawTitle ?? rawDescription) || key;
        displayDescription = rawTitle ? rawDescription : undefined;
      }
    }
    return {
      key,
      type: typeof propertyRecord.type === "string" ? propertyRecord.type : undefined,
      title: displayTitle,
      description: displayDescription,
      ...(required.has(key) ? { required: true } : {}),
      choices: choicesForSchemaProperty(propertyRecord),
    };
  });
  const supportedFields = fields.filter((field) => field.choices.length > 0);
  return supportedFields.length > 0 ? supportedFields : fields;
}

export * as ElicitationSchema from "./elicitation-schema";
