import { defineRelayPlugin, type RelayMcpStatus } from "@atlassian/relay-plugin-sdk";

const WIDGET_KEY = "mcp-manager";

function statusLines(status: RelayMcpStatus): string[] {
  const active = status.activeServers.map((server) => `active  ${server.name} -> ${server.command}`);
  const pending = status.pendingServers.map((server) => `pending ${server.name} -> ${server.command}`);
  return [
    `restart needed: ${status.restartNeeded ? "yes" : "no"}`,
    `applied to current agent: ${status.applied ? "yes" : "no"}`,
    "",
    ...(active.length ? active : ["active  <none>"]),
    ...(pending.length ? pending : ["pending <none>"]),
  ];
}

export default defineRelayPlugin((relay) => {
  relay.mcp.addServer(
    {
      name: "docs-search",
      command: "docs-mcp-server",
      args: ["--stdio"],
    },
    { apply: "promptRestart" },
  );

  let overlayOpen = false;

  function closeStatusOverlay() {
    overlayOpen = false;
    relay.ui.setWidget(WIDGET_KEY, undefined);
  }

  function setStatusOverlay() {
    overlayOpen = true;
    relay.ui.setWidget(WIDGET_KEY, {
      placement: "overlay",
      title: "Plugin MCP manager",
      modalCorners: { bottomLeft: "r restart · esc/q close" },
      onClose: closeStatusOverlay,
      render() {
        return statusLines(relay.mcp.status()).map((text) => ({ text }));
      },
    });
  }

  async function restartAgent() {
    try {
      await relay.agent.restart();
      relay.ui.toast("Agent restarted for MCP changes", "info");
      if (overlayOpen) setStatusOverlay();
    } catch (error: unknown) {
      relay.ui.toast(error instanceof Error ? error.message : String(error), "error");
    }
  }

  relay.keybindings.register("r", {
    description: "MCP manager: restart agent",
    enabled: () => overlayOpen,
    run: restartAgent,
  });
  for (const key of ["escape", "q"]) {
    relay.keybindings.register(key, {
      description: "MCP manager: close overlay",
      enabled: () => overlayOpen,
      run: closeStatusOverlay,
    });
  }

  relay.commands.register("mcp-manager", {
    description: "Show plugin MCP server status and restart the agent if needed",
    async run() {
      const status = relay.mcp.status();
      if (status.restartNeeded) {
        const restart = await relay.ui.confirm(
          "MCP restart needed",
          "Restart the active agent so plugin MCP server changes take effect?",
          { confirmLabel: "Restart", cancelLabel: "Later" },
        );
        if (restart) await restartAgent();
      }
      setStatusOverlay();
    },
  });
});
