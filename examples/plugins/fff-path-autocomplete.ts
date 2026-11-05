import { basename } from "node:path";
import { defineRelayPlugin, type RelayAutocompleteItem } from "@atlassian/relay-plugin-sdk";

/**
 * FFF autocomplete bridge.
 *
 * Set RELAY_FFF_COMMAND to a local command that accepts the current query as its
 * final argument and prints repo-relative paths, one per line. That command can
 * wrap @ff-labs/fff-node, the FFF CLI you use internally, or another FFF bridge.
 */
const DEFAULT_FFF_COMMAND = "fff-relay-files";
const MAX_RESULTS = 40;
const TIMEOUT_MS = 800;

function commandParts(): readonly string[] {
  return (process.env.RELAY_FFF_COMMAND ?? DEFAULT_FFF_COMMAND).split(/\s+/).filter(Boolean);
}

function queryFromToken(token: string): string {
  const raw = token.startsWith('@"') ? token.slice(2) : token.slice(1);
  return raw.replace(/"$/, "");
}

function mentionValue(path: string): string {
  const escaped = path.replace(/"/g, '\\"');
  return /\s/.test(path) ? `@"${escaped}"` : `@${path}`;
}

function itemsFromOutput(output: string): readonly RelayAutocompleteItem[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, MAX_RESULTS)
    .map((path) => ({ label: basename(path), description: path, insertText: mentionValue(path) }));
}

async function queryFff(cwd: string, query: string): Promise<readonly RelayAutocompleteItem[]> {
  const [command, ...baseArgs] = commandParts();
  if (!command) return [];

  const proc = Bun.spawn([command, ...baseArgs, query], { cwd, stdout: "pipe", stderr: "ignore" });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, TIMEOUT_MS);

  try {
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (timedOut || exitCode !== 0) return [];
    return itemsFromOutput(stdout);
  } finally {
    clearTimeout(timeout);
  }
}

export default defineRelayPlugin((relay) => {
  relay.editor.addAutocompleteProvider({
    trigger: "@",
    async provide(ctx) {
      const query = queryFromToken(ctx.token);
      const items = await queryFff(ctx.cwd, query).catch(() => []);
      return items.length > 0 ? { items, tokenStart: ctx.tokenStart, tokenEnd: ctx.cursorOffset } : null;
    },
    applyCompletion({ text, item, tokenStart, tokenEnd }) {
      const insertText = item.insertText ?? item.label;
      return {
        text: `${text.slice(0, tokenStart)}${insertText}${text.slice(tokenEnd)}`,
        cursorOffset: tokenStart + insertText.length,
      };
    },
  });
});
