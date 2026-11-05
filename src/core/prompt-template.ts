export function renderPromptTemplate(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{\{([a-z0-9_]+)\}\}/gu, (placeholder, key: string) => values[key] ?? placeholder);
}
