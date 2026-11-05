import type { Config } from "../../config";

export function formatConfigWarningMessage(warnings: string[]): string {
  const [firstWarning] = warnings;
  if (!firstWarning) return "Config warning";
  const remaining = warnings.length - 1;
  return remaining > 0 ? `${firstWarning} (+${remaining} more)` : firstWarning;
}

export function pluginsConfigFingerprint(config: Config | null): string {
  if (!config) return "";
  return JSON.stringify({
    enabled: config.plugins.enabled,
    allowProjectPlugins: config.plugins.allow_project_plugins,
    paths: config.plugins.paths,
    trustedWorkspaces: config.plugins.trusted_workspaces,
    disabled: config.plugins.disabled,
  });
}
