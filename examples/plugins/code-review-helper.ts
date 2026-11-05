import { defineRelayPlugin, type RelayAutocompleteItem } from "@atlassian/relay-plugin-sdk";

const REVIEW_MODES: readonly RelayAutocompleteItem[] = [
  { label: "working", description: "Review unstaged and staged working tree changes" },
  { label: "staged", description: "Review only staged changes" },
];

const MAX_PROMPT_DIFF_CHARS = 30_000;

async function gitOutput(cwd: string, args: readonly string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr.trim() || `git ${args.join(" ")} failed`);
  return stdout;
}

function reviewMode(args: string): "working" | "staged" {
  return args.trim().toLowerCase() === "staged" ? "staged" : "working";
}

function promptDiff(diff: string): string {
  if (diff.length <= MAX_PROMPT_DIFF_CHARS) return diff;
  return `${diff.slice(0, MAX_PROMPT_DIFF_CHARS)}\n\n[diff truncated for prompt; use the Relay diff overlay for the full patch]`;
}

export default defineRelayPlugin((relay) => {
  relay.commands.register("review-changes", {
    description: "Preview git diff and ask the active agent for a focused review",
    argumentPlaceholder: "[working|staged]",
    getArgumentCompletions(argsPrefix) {
      const prefix = argsPrefix.trim().toLowerCase();
      return REVIEW_MODES.filter((item) => item.label.startsWith(prefix));
    },
    async run(args, ctx) {
      const mode = reviewMode(args);
      const diffArgs = mode === "staged" ? ["diff", "--cached"] : ["diff"];
      const diff = await gitOutput(ctx.cwd, diffArgs);
      if (!diff.trim()) {
        ctx.toast(`No ${mode === "staged" ? "staged" : "working tree"} changes to review`, "info");
        return;
      }

      const overlay = relay.ui.openDiff({
        title: mode === "staged" ? "Staged changes" : "Working tree changes",
        subtitle: "Review before asking the agent",
        diffText: diff,
      });

      let confirmed = false;
      try {
        confirmed = await relay.ui.confirm(
          "Ask for code review?",
          `Send ${mode} diff to the active agent for review?`,
          { confirmLabel: "Review", cancelLabel: "Skip" },
        );
      } finally {
        overlay.dispose();
      }
      if (!confirmed) return;

      await relay.agent.prompt(
        [
          "Review the following git diff.",
          "Focus on correctness, regressions, missing tests, security, and maintainability.",
          "Return prioritized findings first, then a short summary.",
          "",
          "```diff",
          promptDiff(diff),
          "```",
        ].join("\n"),
        { display: { kind: "skill", name: "review-changes", userMessage: `Review ${mode} changes` } },
      );
    },
  });
});
