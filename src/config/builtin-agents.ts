export const ROVO_AGENT_COMMAND = "rovo";
export const ROVO_AGENT_ARGS = ["acp"] as const;
export const CODEX_ACP_PACKAGE = "@zed-industries/codex-acp";
export const CLAUDE_ACP_PACKAGE = "@agentclientprotocol/claude-agent-acp";
export const CURSOR_AGENT_COMMAND = "agent";
export const CURSOR_AGENT_ARGS = ["acp"] as const;

const LEGACY_BUILTIN_AGENT_PACKAGES: Readonly<Record<string, readonly string[]>> = {
  codex: ["@agentclientprotocol/codex-acp", "@agentclientprotocol/codex-acp@1.0.2"],
  claude: ["@agentclientprotocol/claude-agent-acp@0.54.1"],
};

export interface BuiltinAgentRunnerConfig {
  readonly command: string;
  readonly args: string[];
  readonly profile: string;
  readonly env?: Record<string, string>;
}

export interface BuiltinAgentDefinition {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly description: string;
  readonly packageName?: string;
  readonly runner: () => BuiltinAgentRunnerConfig;
}

function packageRunner(packageName: string, profile: string, env?: Record<string, string>): BuiltinAgentRunnerConfig {
  // Use the ACP registry launch style. `bun x` currently mis-resolves
  // Atlassian Artifactory npm registry URLs for scoped packages, while `npx`
  // honors the user's npm configuration correctly.
  return {
    command: "npx",
    args: ["--yes", "--loglevel=error", packageName],
    profile,
    ...(env && Object.keys(env).length > 0 ? { env: { ...env } } : {}),
  };
}

function commandRunner(command: string, args: readonly string[], profile: string): BuiltinAgentRunnerConfig {
  return {
    command,
    args: [...args],
    profile,
  };
}

export const BUILTIN_AGENT_DEFINITIONS = [
  {
    name: "rovo",
    aliases: ["rovodev", "rovo-dev"],
    description: "Rovo Dev ACP agent",
    runner: () => commandRunner(ROVO_AGENT_COMMAND, ROVO_AGENT_ARGS, "rovodev"),
  },
  {
    name: "codex",
    aliases: ["codex-acp"],
    description: "Codex ACP adapter",
    packageName: CODEX_ACP_PACKAGE,
    runner: () => packageRunner(CODEX_ACP_PACKAGE, "codex", { NO_BROWSER: "1" }),
  },
  {
    name: "claude",
    aliases: ["claude-acp", "claude-code"],
    description: "Claude Code ACP adapter",
    packageName: CLAUDE_ACP_PACKAGE,
    runner: () => packageRunner(CLAUDE_ACP_PACKAGE, "claude", { NO_BROWSER: "1" }),
  },
  {
    name: "cursor",
    aliases: ["cursor-agent", "cursor-acp"],
    description: "Cursor Agent ACP adapter",
    runner: () => commandRunner(CURSOR_AGENT_COMMAND, CURSOR_AGENT_ARGS, "default"),
  },
] as const satisfies readonly BuiltinAgentDefinition[];

const BUILTIN_AGENT_ALIASES = new Map<string, BuiltinAgentDefinition>();
for (const definition of BUILTIN_AGENT_DEFINITIONS) {
  BUILTIN_AGENT_ALIASES.set(definition.name, definition);
  for (const alias of definition.aliases) BUILTIN_AGENT_ALIASES.set(alias, definition);
}

function normalizeAgentName(agentName: string | undefined | null): string {
  return (agentName ?? "").trim().toLowerCase();
}

function commandBasename(command: string): string {
  const trimmed = command.trim();
  const slashIndex = trimmed.lastIndexOf("/");
  return slashIndex >= 0 ? trimmed.slice(slashIndex + 1) : trimmed;
}

function npxPackageToken(args: readonly string[]): string | null {
  const packageTokens = args.filter(
    (arg) =>
      arg !== "-y" &&
      arg !== "--yes" &&
      arg !== "--silent" &&
      arg !== "--loglevel=error" &&
      arg !== "--loglevel" &&
      arg !== "error" &&
      !arg.startsWith("--loglevel="),
  );
  return packageTokens.length === 1 ? packageTokens[0] : null;
}

function argsEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isCommandStockRunner(
  command: string,
  args: readonly string[],
  stockCommand: string,
  stockArgs: readonly string[],
): boolean {
  return commandBasename(command) === stockCommand && argsEqual(args, stockArgs);
}

export function isBuiltinStockRunner(agentName: string, command: string, args: readonly string[]): boolean {
  const definition = BUILTIN_AGENT_ALIASES.get(normalizeAgentName(agentName));
  if (!definition) return false;
  if (definition.name === "rovo") return isCommandStockRunner(command, args, ROVO_AGENT_COMMAND, ROVO_AGENT_ARGS);
  if (definition.name === "cursor") return isCommandStockRunner(command, args, CURSOR_AGENT_COMMAND, CURSOR_AGENT_ARGS);
  if (!definition.packageName || commandBasename(command) !== "npx") return false;
  const packageToken = npxPackageToken(args);
  if (!packageToken) return false;
  return (
    packageToken === definition.packageName ||
    (LEGACY_BUILTIN_AGENT_PACKAGES[definition.name] ?? []).includes(packageToken)
  );
}

export function builtinAgentNames(): string[] {
  return BUILTIN_AGENT_DEFINITIONS.map((definition) => definition.name);
}

export function builtinAgentDisplayNames(): string[] {
  return BUILTIN_AGENT_DEFINITIONS.map((definition) =>
    definition.aliases.length > 0 ? `${definition.name} (${definition.aliases.join(", ")})` : definition.name,
  );
}

export function builtinAgentCanonicalName(agentName: string | undefined | null): string | null {
  return BUILTIN_AGENT_ALIASES.get(normalizeAgentName(agentName))?.name ?? null;
}

export function isBuiltinAgentName(agentName: string | undefined | null): boolean {
  return builtinAgentCanonicalName(agentName) !== null;
}

export function resolveBuiltinAgentRunner(
  agentName: string,
): { readonly name: string; readonly runner: BuiltinAgentRunnerConfig } | null {
  const definition = BUILTIN_AGENT_ALIASES.get(normalizeAgentName(agentName));
  if (!definition) return null;
  return { name: definition.name, runner: definition.runner() };
}
