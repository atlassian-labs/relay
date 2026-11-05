export const RELAY_PLUGIN_SDK_PACKAGE = "@atlassian/relay-plugin-sdk";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Return dependencies that must be installed beside a plugin for bundling or
 * runtime loading. Relay provides its SDK, so plugins never install or bundle
 * a private copy of it.
 */
export function pluginRuntimeDependencies(packageJson: unknown): Record<string, string> {
  if (!isRecord(packageJson) || !isRecord(packageJson.dependencies)) return {};

  const dependencies: Record<string, string> = {};
  for (const [name, version] of Object.entries(packageJson.dependencies)) {
    if (name === RELAY_PLUGIN_SDK_PACKAGE || typeof version !== "string" || version.length === 0) continue;
    dependencies[name] = version;
  }
  return dependencies;
}
