import { defineRelayPlugin } from "@atlassian/relay-plugin-sdk";

const SHOWCASE_PROMPT = "relay ui showcase";
const QUEUE_SHOWCASE_PROMPT = "relay queue showcase";
const initialPrompt = process.env.RELAY_UI_SHOWCASE_MODE === "queue" ? QUEUE_SHOWCASE_PROMPT : SHOWCASE_PROMPT;

export default defineRelayPlugin((relay) => {
  const showcaseThreads = new Set<string>();
  const completedThreads = new Set<string>();
  let started = false;

  relay.on("session:new", () => {
    if (started) return;
    started = true;
    setTimeout(() => {
      void relay.agent.prompt(initialPrompt, {
        display: {
          kind: "skill",
          name: initialPrompt === QUEUE_SHOWCASE_PROMPT ? "queue-showcase" : "ui-showcase",
          userMessage: initialPrompt,
        },
      });
    }, 250);
  });

  relay.on("prompt:submitted", (event) => {
    if (!event.text.toLowerCase().includes(SHOWCASE_PROMPT)) return;
    showcaseThreads.add(event.threadId);
  });

  relay.on("prompt:complete", async (event) => {
    if (!showcaseThreads.has(event.threadId) || completedThreads.has(event.threadId)) return;
    completedThreads.add(event.threadId);

    await relay.ui.confirm(
      "Install plugin script?",
      "Install the selected script into your local plugin configuration? This is the same SDK confirmation used by bundled plugins.",
      { confirmLabel: "Install", cancelLabel: "Cancel" },
    );

    await relay.ui.confirm(
      "Approve pull request?",
      "Approve PR #184 after reviewing its latest commit and build status?",
      { confirmLabel: "Approve", cancelLabel: "Cancel" },
    );

    await relay.ui.confirm(
      "Merge pull request?",
      "Merge PR #184 into main? This final confirmation demonstrates longer action labels.",
      { confirmLabel: "Merge pull request", cancelLabel: "Keep open" },
    );
  });
});
