import { defineRelayPlugin, type RelayPermissionRequestOption } from "@atlassian/relay-plugin-sdk";

const DANGEROUS_BASH_PATTERNS: readonly RegExp[] = [
  /\brm\s+-rf\s+(?:\/|~|\$HOME)(?:\s|$)/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-[a-zA-Z]*[fd][a-zA-Z]*\b/,
  /\bchmod\s+-R\s+777\b/,
  /\bsudo\b.*\b(?:rm|chmod|chown)\b/,
];

const READ_ONLY_BASH_PATTERNS: readonly RegExp[] = [
  /^\s*(?:git\s+status|git\s+diff|git\s+log|git\s+show)\b/,
  /^\s*(?:ls|pwd|find|fd|rg|grep)\b/,
  /^\s*(?:bun|npm|pnpm|yarn)\s+(?:test|run\s+(?:test|typecheck|lint|format:check))\b/,
];

function previewText(value: string | undefined): string {
  return (value ?? "").trim();
}

function findAllowOption(options: readonly RelayPermissionRequestOption[]): RelayPermissionRequestOption | undefined {
  return options.find((option) => (option.kind ?? option.optionId).startsWith("allow"));
}

export default defineRelayPlugin((relay) => {
  relay.settings.define("auto_allow_readonly", {
    title: "Auto-allow read-only shell permissions",
    description: "Automatically approve obvious read-only bash permission requests.",
    type: "boolean",
    default: true,
  });

  relay.permissions.onRequest((request) => {
    if (request.toolName !== "bash") return { action: "continue" };

    const command = previewText(request.preview);
    if (DANGEROUS_BASH_PATTERNS.some((pattern) => pattern.test(command))) {
      return { action: "deny", reason: "Blocked by permission-safety-policy" };
    }

    if (relay.settings.get("auto_allow_readonly") && READ_ONLY_BASH_PATTERNS.some((pattern) => pattern.test(command))) {
      const allow = findAllowOption(request.options);
      return allow ? { action: "select", optionId: allow.optionId } : { action: "approve" };
    }

    return { action: "continue" };
  });
});
