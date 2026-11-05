const BUILTIN_SLASH_COMMAND_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;

export function normalizeBuiltinSlashCommandName(value: string): string | null {
  const withoutLeadingSlash = value.trim().toLowerCase().replace(/^\/+/, "");
  const withoutRelayPrefix = withoutLeadingSlash.startsWith("relay.")
    ? withoutLeadingSlash.slice("relay.".length)
    : withoutLeadingSlash;
  if (!BUILTIN_SLASH_COMMAND_NAME_PATTERN.test(withoutRelayPrefix)) return null;
  return withoutRelayPrefix;
}

export function builtinSlashCommandNameSet(values: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (const value of values) {
    const normalized = normalizeBuiltinSlashCommandName(value);
    if (normalized) names.add(normalized);
  }
  return names;
}
