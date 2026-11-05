/**
 * Native `/slash` command dispatch.
 *
 * Extracted from app-root: `handleSubmit` delegates here whenever the prompt
 * starts with `/`. Like the keyboard handler, this is a leaf that takes a typed
 * deps bundle of the root's orchestration functions and live singleton
 * accessors, so the compiler enforces that every dependency is wired.
 */

import {
  type ChatBlock,
  type ContentBlock,
  type SessionModeOption,
  type SessionModelOption,
  type SessionThinkingLevelOption,
  nextBlockId,
  useApp,
} from "../state";
import { findBuiltinSkill } from "../../builtin-skills/registry";
import type { BuiltinSkill } from "../../builtin-skills/types";
import { type ListItem, SelectionMode } from "../autocomplete";
import type { AcpClient } from "../../acp/client";
import { parseThinkingLevel, thinkingLevelLabel, type ThinkingLevel } from "../../core/thinking";
import type { PluginRunner, RelayCommandContext, RelayMcpServerConfig, RelayMcpStatus } from "../../plugins";
import { writeFileSync } from "../../platform/fs";
import {
  isAgentAdvertisedSlashCommand,
  shouldPreferNativeSlashCommand,
  slashCommandName,
  slashCommandUserMessage,
} from "./slash-commands";
import { copyToClipboard } from "../util/clipboard";
import { clearDiffOverlayRequest, setFileChangesModalOpen } from "./diff-overlay-controller";
import { emitPluginEvent } from "./plugin-runtime";
import {
  formatRelayConversationMarkdown,
  relayExportFilePath,
  snapshotThreadConversation,
} from "./conversation-export";
import {
  isBuiltinSlashCommandDisabled,
  nativeSlashCommandBaseName,
  nativeSlashCommandNames,
  nativeSlashCommandRequiresSession,
} from "../util/native-slash-commands";
import {
  acpAuthMethodsUnavailableMessage,
  authenticateWithAcpMethod,
  logoutAcpAuth,
  supportedAcpAuthMethods,
  type AcpTerminalAuthRunner,
} from "./acp-client-controller";
import { getTelemetry } from "../../telemetry";
import type { SelectionOverlayBehavior } from "./selection-overlay";
import { conversationTreeItems } from "./conversation-tree";
import type { ToastVariant } from "../ui/toast";
import { SUBAGENT_PICKER_LAYOUT, subagentListItems, subagentPickerBehavior } from "./subagents";
import { CHILD_PICKER_LAYOUT, childListItems, childPickerBehavior } from "./children";
import { store } from "./runtime-store";

type App = ReturnType<typeof useApp>;

function localSlashCommands(disabledBuiltinCommands: readonly string[]): Set<string> {
  return new Set([...nativeSlashCommandNames({ disabledBuiltinCommands })].map((name) => `/${name}`));
}

function isUserMessageBlock(block: ChatBlock): boolean {
  return block.type === "user";
}

function reasoningEffortValueLabel(
  thinkingLevel: ThinkingLevel | "",
  levels: readonly SessionThinkingLevelOption[],
): string {
  if (!thinkingLevel) return "";
  return levels.find((level) => level.id === thinkingLevel)?.name ?? thinkingLevelLabel(thinkingLevel);
}

function reasoningEffortCaption(
  thinkingLevel: ThinkingLevel | "",
  levels: readonly SessionThinkingLevelOption[],
): string {
  const label = reasoningEffortValueLabel(thinkingLevel, levels);
  return label ? `reasoning effort: ${label}` : "";
}

function fallbackCommandContext(app: App, client: AcpClient | null): RelayCommandContext {
  const activeThread = app.state.threads.find((thread) => thread.id === app.state.activeThreadId && !thread.archived);
  const running =
    app.state.connecting ||
    app.state.running ||
    activeThread?.status === "connecting" ||
    activeThread?.status === "running";
  return {
    cwd: app.state.cwd,
    sessionId: client?.sessionId ?? activeThread?.sessionId ?? null,
    threadId: activeThread?.id ?? null,
    userMessageCount: app.state.blocks.filter(isUserMessageBlock).length,
    running,
    waitForIdle: () => Promise.resolve(),
    toast: () => undefined,
  };
}

function mcpServerCommand(server: RelayMcpServerConfig): string {
  return [server.command, ...(server.args ?? [])].filter(Boolean).join(" ") || "(no command)";
}

function mcpServerLines(servers: readonly RelayMcpServerConfig[]): string[] {
  return servers.map((server) => {
    const envCount = Object.keys(server.env ?? {}).length;
    const envSuffix = envCount > 0 ? ` · ${envCount} env var${envCount === 1 ? "" : "s"}` : "";
    return `  - ${server.name}: ${mcpServerCommand(server)}${envSuffix}`;
  });
}

function mcpNoServersMessage(): string {
  return "No MCP servers are enabled.\n\nUse /plugins to enable plugins that register MCP servers.";
}

function formatMcpStatus(status: RelayMcpStatus): string {
  const pendingServers = status.pendingServers;
  const activeServers = status.activeServers;
  if (pendingServers.length === 0 && activeServers.length === 0) return mcpNoServersMessage();

  if (status.restartNeeded) {
    return [
      "MCP servers:",
      "",
      "Active in current agent:",
      ...(activeServers.length ? mcpServerLines(activeServers) : ["  (none)"]),
      "",
      "Enabled after agent restart:",
      ...(pendingServers.length ? mcpServerLines(pendingServers) : ["  (none)"]),
      "",
      "MCP changes require restarting the agent.",
    ].join("\n");
  }

  const servers = status.applied ? activeServers : pendingServers;
  return [
    status.applied ? "Enabled MCP servers:" : "Enabled MCP servers (will apply when the agent starts):",
    "",
    ...mcpServerLines(servers),
  ].join("\n");
}

export interface SlashCommandHandlerDeps {
  submitPromptToAgent: (
    text: string,
    app: App,
    queuePlacement?: "in-place" | "end",
    options?: { suppressLocalEcho?: boolean },
  ) => Promise<void>;
  createThread: (
    app: App,
    inWorktree: boolean,
    options?: { snapshotCurrent?: boolean; cwd?: string; title?: string },
  ) => Promise<unknown>;
  selectThread?: (app: App, threadId: string, options?: { snapshotCurrent?: boolean }) => Promise<void>;
  forkThread: (app: App) => Promise<void>;
  loadSession: (
    sessionId: string,
    app: App,
    client: AcpClient,
    agentName: string,
    sessionTitle?: string,
    sessionCwd?: string,
  ) => Promise<void>;
  openResumePicker: (app: App, client: AcpClient) => Promise<void>;
  switchSessionModel: (app: App, modelId: string) => Promise<void>;
  switchSessionThinkingLevel: (app: App, thinkingLevel: ThinkingLevel) => Promise<void>;
  ensureSessionForCommand: (app: App) => Promise<void>;
  shutdownAndExit: (renderer: { destroy: () => void }, exitCode?: number) => Promise<void>;
  showSelectionOverlay: (
    items: ListItem<any>[],
    mode: SelectionMode,
    layout?: any,
    selectedIndex?: number,
    behavior?: SelectionOverlayBehavior,
  ) => void;
  showToast: (message: string, variant?: ToastVariant, durationMs?: number) => void;
  openSettingsOverlay: (selected?: { readonly acpConfigOptionId: string }) => void;
  openPluginsOverlay: () => void;
  openPromptInExternalEditor: (initialText?: string) => Promise<void> | void;
  hideOverlay: () => void;
  setWelcomeDismissed: (value: boolean) => void;
  setShowThreadSidebar: (value: boolean) => void;
  setSidebarFocused: (value: boolean) => void;
  setSidebarFocusedIndex: (value: number) => void;
  acpClient: () => AcpClient | null;
  activeAgentName: () => string;
  pluginRunner: () => PluginRunner | null;
  reloadPlugins: () => ((reason: "reload" | "error") => Promise<void>) | null;
  exitRenderer: () => { destroy: () => void } | null;
  commandContext?: (app: App) => RelayCommandContext;
  runBuiltinSkillCommand?: (app: App, skill: BuiltinSkill, args: string, ctx: RelayCommandContext) => Promise<void>;
  runNativeHandoffCommand?: (app: App, args: string, ctx: RelayCommandContext) => Promise<void>;
  disabledBuiltinSlashCommands?: () => readonly string[];
  runTerminalAuth?: AcpTerminalAuthRunner;
}

export function createSlashCommandHandler(deps: SlashCommandHandlerDeps): (command: string, app: App) => Promise<void> {
  const {
    submitPromptToAgent,
    createThread,
    selectThread,
    forkThread,
    loadSession,
    openResumePicker,
    switchSessionModel,
    switchSessionThinkingLevel,
    ensureSessionForCommand,
    shutdownAndExit,
    showSelectionOverlay,
    showToast,
    openSettingsOverlay,
    openPluginsOverlay,
    openPromptInExternalEditor,
    hideOverlay,
    setWelcomeDismissed,
    setShowThreadSidebar,
    setSidebarFocused,
    setSidebarFocusedIndex,
    acpClient,
    activeAgentName,
    pluginRunner,
    reloadPlugins,
    exitRenderer,
    commandContext,
    runBuiltinSkillCommand,
    runNativeHandoffCommand,
    disabledBuiltinSlashCommands,
    runTerminalAuth,
  } = deps;

  function showThinkingLevelSelection(app: App): void {
    const items: ListItem<SessionThinkingLevelOption>[] = app.state.availableThinkingLevels.map((thinkingLevel) => ({
      value: thinkingLevel,
      label: thinkingLevelLabel(thinkingLevel.id),
      description: [thinkingLevel.name, thinkingLevel.description].filter(Boolean).join(" · "),
      active: thinkingLevel.id === app.state.thinkingLevel,
    }));
    if (items.length === 0) {
      app.addBlock({
        type: "info",
        id: nextBlockId(),
        content: "This ACP agent did not advertise switchable reasoning effort levels.",
        variant: "warning",
      });
      return;
    }
    showSelectionOverlay(items, SelectionMode.THINKING, { labelMinWidth: 16, labelMaxWidth: 32 }, 0, {
      onSelect: (item, selectedApp) => {
        const level = item.value as SessionThinkingLevelOption;
        void switchSessionThinkingLevel(selectedApp, level.id).catch((err) =>
          selectedApp.addBlock({
            type: "info",
            id: nextBlockId(),
            content: `Failed to set reasoning effort: ${err}`,
            variant: "error",
          }),
        );
      },
    });
  }

  return async (command: string, app: App): Promise<void> => {
    const _acpClient = acpClient();
    const _activeAgentName = activeAgentName();
    const _pluginRunner = pluginRunner();
    const _reloadPlugins = reloadPlugins();
    const _exitRenderer = exitRenderer();

    setWelcomeDismissed(true);
    const parts = command.trim().split(/\s+/);
    const rawCmd = parts[0].toLowerCase();
    const commandName = slashCommandName(command);
    const disabledNativeCommands = disabledBuiltinSlashCommands?.() ?? [];
    const nativeCommandOptions = { disabledBuiltinCommands: disabledNativeCommands };
    const nativeCommandName = nativeSlashCommandBaseName(commandName, nativeCommandOptions);
    const cmd = `/${nativeCommandName ?? commandName}`;
    getTelemetry().recordSlashCommand(commandName);

    const pluginCommand = _pluginRunner?.commands.find(commandName);
    if (pluginCommand) {
      try {
        await pluginCommand.command.run(
          parts.slice(1).join(" "),
          commandContext?.(app) ?? fallbackCommandContext(app, _acpClient),
        );
      } catch (err) {
        _pluginRunner?.recordError(pluginCommand.plugin, `Plugin command failed: ${pluginCommand.name}`, err);
      }
      return;
    }

    async function ensureSessionForSlashCommand(): Promise<boolean> {
      try {
        await ensureSessionForCommand(app);
        return true;
      } catch (err) {
        app.addBlock({
          type: "info",
          id: nextBlockId(),
          content: `Failed to start ACP session: ${err instanceof Error ? err.message : String(err)}`,
          variant: "error",
        });
        return false;
      }
    }
    const sessionOwnedCommand =
      !localSlashCommands(disabledNativeCommands).has(rawCmd) ||
      nativeSlashCommandRequiresSession(commandName, nativeCommandOptions);
    const activeThread = app.state.threads.find((thread) => thread.id === app.state.activeThreadId);
    if (_acpClient && sessionOwnedCommand) {
      if (app.state.connecting || activeThread?.status === "connecting") {
        await submitPromptToAgent(command, app);
        return;
      }
      if (!(await ensureSessionForSlashCommand())) return;
    }

    const agentAdvertisedCommand = isAgentAdvertisedSlashCommand(command, app.state);
    const disabledBuiltinCommand = isBuiltinSlashCommandDisabled(commandName, disabledNativeCommands);
    if (disabledBuiltinCommand) {
      await submitPromptToAgent(
        command,
        app,
        "in-place",
        agentAdvertisedCommand ? { suppressLocalEcho: true } : undefined,
      );
      return;
    }
    const builtinSkill = nativeCommandName ? findBuiltinSkill(nativeCommandName) : null;
    if (!shouldPreferNativeSlashCommand(commandName, app.state, disabledNativeCommands) && agentAdvertisedCommand) {
      await submitPromptToAgent(command, app, "in-place", { suppressLocalEcho: true });
      return;
    }

    if (builtinSkill) {
      if (runBuiltinSkillCommand) {
        await runBuiltinSkillCommand(
          app,
          builtinSkill,
          slashCommandUserMessage(command) ?? "",
          commandContext?.(app) ?? fallbackCommandContext(app, _acpClient),
        );
      } else {
        await submitPromptToAgent(command, app);
      }
      return;
    }

    switch (cmd) {
      case "/login": {
        if (!_acpClient) {
          app.addBlock({
            type: "info",
            id: nextBlockId(),
            content: "Login requires an ACP agent. Launch with --agent <name>.",
            variant: "warning",
          });
          break;
        }
        const methods = supportedAcpAuthMethods(app);
        if (methods.length === 0) {
          app.addBlock({
            type: "info",
            id: nextBlockId(),
            content: acpAuthMethodsUnavailableMessage(app.state.authMethods),
            variant: "warning",
          });
          break;
        }
        if (parts.length > 1) {
          const methodId = parts.slice(1).join(" ").trim();
          try {
            const method = await authenticateWithAcpMethod(app, _acpClient, methodId, runTerminalAuth);
            app.addBlock({
              type: "info",
              id: nextBlockId(),
              content: `Authenticated with ${method.name}.`,
              variant: "info",
            });
          } catch (err) {
            app.addBlock({
              type: "info",
              id: nextBlockId(),
              content: `Login failed: ${err instanceof Error ? err.message : String(err)}`,
              variant: "error",
            });
          }
          break;
        }
        if (methods.length === 1) {
          try {
            const method = await authenticateWithAcpMethod(app, _acpClient, methods[0].id, runTerminalAuth);
            app.addBlock({
              type: "info",
              id: nextBlockId(),
              content: `Authenticated with ${method.name}.`,
              variant: "info",
            });
          } catch (err) {
            app.addBlock({
              type: "info",
              id: nextBlockId(),
              content: `Login failed: ${err instanceof Error ? err.message : String(err)}`,
              variant: "error",
            });
          }
          break;
        }
        showSelectionOverlay(
          methods.map((method) => ({
            value: method,
            label: method.name,
            description: [method.id, method.description].filter(Boolean).join(" · "),
          })),
          SelectionMode.AUTH_METHOD,
          undefined,
          undefined,
          {
            onSelect: (item, selectedApp) => {
              const method = item.value as (typeof methods)[number];
              void authenticateWithAcpMethod(selectedApp, _acpClient, method.id, runTerminalAuth)
                .then((authenticatedMethod) =>
                  selectedApp.addBlock({
                    type: "info",
                    id: nextBlockId(),
                    content: `Authenticated with ${authenticatedMethod.name}.`,
                    variant: "info",
                  }),
                )
                .catch((err) =>
                  selectedApp.addBlock({
                    type: "info",
                    id: nextBlockId(),
                    content: `Login failed: ${err instanceof Error ? err.message : String(err)}`,
                    variant: "error",
                  }),
                );
            },
          },
        );
        break;
      }

      case "/logout": {
        if (!_acpClient) {
          app.addBlock({
            type: "info",
            id: nextBlockId(),
            content: "Logout requires an ACP agent. Launch with --agent <name>.",
            variant: "warning",
          });
          break;
        }
        try {
          await logoutAcpAuth(app, _acpClient);
          app.addBlock({
            type: "info",
            id: nextBlockId(),
            content: "Logged out.",
            variant: "info",
          });
        } catch (err) {
          app.addBlock({
            type: "info",
            id: nextBlockId(),
            content: `Logout failed: ${err instanceof Error ? err.message : String(err)}`,
            variant: "error",
          });
        }
        break;
      }

      case "/new":
      case "/thread":
      case "/worktree": {
        if (_acpClient) {
          try {
            await createThread(app, false, { title: parts.slice(1).join(" ") || undefined });
          } catch (e) {
            app.addBlock({
              type: "info",
              id: nextBlockId(),
              content: `Failed to create session: ${e}`,
              variant: "error",
            });
          }
        } else {
          app.addBlock({
            type: "info",
            id: nextBlockId(),
            content: "Local session creation has been removed. Launch with --agent <name>.",
            variant: "warning",
          });
        }
        break;
      }

      case "/fork": {
        if (!_acpClient) {
          app.addBlock({
            type: "info",
            id: nextBlockId(),
            content: "Session fork requires an ACP agent. Launch with --agent <name>.",
            variant: "warning",
          });
          break;
        }
        try {
          await forkThread(app);
        } catch (err) {
          app.addBlock({
            type: "info",
            id: nextBlockId(),
            content: `Failed to fork session: ${err instanceof Error ? err.message : String(err)}`,
            variant: "error",
          });
        }
        break;
      }

      case "/tree": {
        // TODO: Waiting on the ACP spec to support forking conversations at arbitrary points before enabling forks/branches here.
        showToast(
          "Conversation tree is incomplete: it is currently read-only and cannot fork or branch from a selected point.",
          "warning",
          6000,
        );
        const items = conversationTreeItems(app.state.blocks);
        if (items.length === 0) {
          app.addBlock({
            type: "info",
            id: nextBlockId(),
            content: "No conversation entries",
            variant: "info",
          });
          break;
        }
        showSelectionOverlay(
          items,
          SelectionMode.TREE,
          { labelMinWidth: 24, labelMaxWidth: 160, descriptionMaxWidth: 0, viewportReservedWidth: 4 },
          items.length - 1,
        );
        break;
      }

      case "/subagents": {
        const items = subagentListItems(app.state.blocks);
        if (items.length === 0) {
          app.addBlock({
            type: "info",
            id: nextBlockId(),
            content: "No subagents yet.",
            variant: "info",
          });
          break;
        }
        showSelectionOverlay(items, SelectionMode.SUBAGENT, SUBAGENT_PICKER_LAYOUT, 0, subagentPickerBehavior());
        break;
      }

      case "/children": {
        const items = childListItems(app.state.threads, app.state.activeThreadId);
        if (items.length === 0) {
          app.addBlock({
            type: "info",
            id: nextBlockId(),
            content: "No child sessions yet.",
            variant: "info",
          });
          break;
        }
        showSelectionOverlay(
          items,
          SelectionMode.CHILD,
          CHILD_PICKER_LAYOUT,
          0,
          childPickerBehavior(selectThread, (error) =>
            showToast(
              `Failed to open child session: ${error instanceof Error ? error.message : String(error)}`,
              "error",
            ),
          ),
        );
        break;
      }

      case "/threads": {
        setShowThreadSidebar(true);
        setSidebarFocused(true);
        hideOverlay();
        setSidebarFocusedIndex(-2);
        break;
      }

      case "/copy": {
        // Find the last assistant content block
        const blocks = app.state.blocks;
        for (let i = blocks.length - 1; i >= 0; i--) {
          if (blocks[i].type === "content") {
            copyToClipboard((blocks[i] as ContentBlock).content);
            showToast("Copied to clipboard");
            return;
          }
        }
        showToast("No assistant response to copy", "warning");
        break;
      }

      case "/edit": {
        await openPromptInExternalEditor(command.slice(parts[0].length).trimStart());
        break;
      }

      case "/diff": {
        hideOverlay();
        setSidebarFocused(false);
        clearDiffOverlayRequest();
        setFileChangesModalOpen(true);
        break;
      }

      case "/export": {
        const thread = app.state.threads.find((item) => item.id === app.state.activeThreadId && !item.archived);
        if (!thread) {
          app.addBlock({
            type: "info",
            id: nextBlockId(),
            content: "No active thread to export.",
            variant: "warning",
          });
          break;
        }
        const filePath = relayExportFilePath(app.state.cwd);
        try {
          const snapshot = snapshotThreadConversation({
            thread,
            blocks: app.state.blocks,
            sessionId: _acpClient?.sessionId ?? thread.sessionId,
          });
          writeFileSync(filePath, formatRelayConversationMarkdown(snapshot), "utf-8");
          app.addBlock({
            type: "info",
            id: nextBlockId(),
            content: `Exported conversation to ${filePath}`,
            variant: "info",
          });
        } catch (err) {
          app.addBlock({
            type: "info",
            id: nextBlockId(),
            content: `Export failed: ${err instanceof Error ? err.message : String(err)}`,
            variant: "error",
          });
        }
        break;
      }

      case "/mode": {
        if (!_acpClient) {
          app.addBlock({
            type: "info",
            id: nextBlockId(),
            content: "Mode selection requires an ACP agent. Launch with --agent <name>.",
            variant: "warning",
          });
          break;
        }
        const sessionClient = acpClient() ?? _acpClient;
        if (parts.length > 1) {
          const modeId = parts.slice(1).join(" ");
          try {
            await sessionClient.setSessionMode(modeId);
            app.setState("modeId", modeId);
            emitPluginEvent({ type: "mode:change", modeId });
            app.addBlock({
              type: "info",
              id: nextBlockId(),
              content: `Switched to mode: ${modeId}`,
              variant: "info",
            });
          } catch (err) {
            app.addBlock({
              type: "info",
              id: nextBlockId(),
              content: `Failed to set mode: ${err}`,
              variant: "error",
            });
          }
        } else {
          const items: ListItem<SessionModeOption>[] = app.state.availableModes.map((mode) => ({
            value: mode,
            label: mode.id,
            description: [mode.name, mode.description].filter(Boolean).join(" · "),
            active: mode.id === app.state.modeId,
          }));
          if (items.length === 0) {
            app.addBlock({
              type: "info",
              id: nextBlockId(),
              content: "This ACP agent did not advertise any session modes.",
              variant: "warning",
            });
          } else {
            showSelectionOverlay(items, SelectionMode.MODE, undefined, undefined, {
              onSelect: (item, selectedApp) => {
                const mode = item.value as SessionModeOption;
                const client = acpClient();
                selectedApp.setState("modeId", mode.id);
                void client
                  ?.setSessionMode(mode.id)
                  .then(() => emitPluginEvent({ type: "mode:change", modeId: mode.id }))
                  .catch((err) =>
                    selectedApp.addBlock({
                      type: "info",
                      id: nextBlockId(),
                      content: `Failed to set mode: ${err}`,
                      variant: "error",
                    }),
                  );
              },
            });
          }
        }
        break;
      }

      case "/thinking":
      case "/effort": {
        if (!_acpClient) {
          app.addBlock({
            type: "info",
            id: nextBlockId(),
            content: "Reasoning effort selection requires an ACP agent. Launch with --agent <name>.",
            variant: "warning",
          });
          break;
        }
        if (parts.length > 1) {
          const thinkingLevel = parseThinkingLevel(parts.slice(1).join(" "));
          if (!thinkingLevel) {
            app.addBlock({
              type: "info",
              id: nextBlockId(),
              content: `Usage: ${cmd === "/effort" ? "/effort" : "/thinking"} <value>`,
              variant: "warning",
            });
            break;
          }
          try {
            await switchSessionThinkingLevel(app, thinkingLevel);
            app.addBlock({
              type: "info",
              id: nextBlockId(),
              content: `Reasoning effort: ${reasoningEffortValueLabel(thinkingLevel, app.state.availableThinkingLevels)}`,
              variant: "info",
            });
          } catch (err) {
            app.addBlock({
              type: "info",
              id: nextBlockId(),
              content: `Failed to set reasoning effort: ${err}`,
              variant: "error",
            });
          }
        } else {
          showThinkingLevelSelection(app);
        }
        break;
      }

      case "/models":
      case "/model": {
        if (!_acpClient) {
          app.addBlock({
            type: "info",
            id: nextBlockId(),
            content: "Model selection requires an ACP agent. Launch with --agent <name>.",
            variant: "warning",
          });
          break;
        }
        if (parts.length > 1) {
          const newModelId = parts.slice(1).join(" ");
          try {
            await switchSessionModel(app, newModelId);
            const effort = reasoningEffortCaption(app.state.thinkingLevel, app.state.availableThinkingLevels);
            app.addBlock({
              type: "info",
              id: nextBlockId(),
              content: [`Switched to model: ${newModelId}`, effort].filter(Boolean).join(" · "),
              variant: "info",
            });
          } catch (err) {
            app.addBlock({
              type: "info",
              id: nextBlockId(),
              content: `Failed to set model: ${err}`,
              variant: "error",
            });
          }
        } else {
          const effort = reasoningEffortCaption(app.state.thinkingLevel, app.state.availableThinkingLevels);
          const items: ListItem<SessionModelOption>[] = app.state.availableModels.map((model) => ({
            value: model,
            label: model.modelId,
            description: [model.name, model.description, effort].filter(Boolean).join(" · "),
            active: model.modelId === app.state.modelId,
          }));
          if (items.length === 0) {
            app.addBlock({
              type: "info",
              id: nextBlockId(),
              content: "This ACP agent did not advertise any switchable models.",
              variant: "warning",
            });
          } else {
            let switchingModel = false;
            showSelectionOverlay(items, SelectionMode.MODEL, undefined, undefined, {
              closeOnSelect: false,
              onSelect: (item, selectedApp) => {
                if (switchingModel) return;
                switchingModel = true;
                const model = item.value as SessionModelOption;
                void switchSessionModel(selectedApp, model.modelId)
                  .then(() => {
                    if (selectedApp.state.availableThinkingLevels.length === 0) hideOverlay();
                    showThinkingLevelSelection(selectedApp);
                  })
                  .catch((err) => {
                    hideOverlay();
                    selectedApp.addBlock({
                      type: "info",
                      id: nextBlockId(),
                      content: `Failed to set model: ${err}`,
                      variant: "error",
                    });
                  });
              },
            });
          }
        }
        break;
      }

      case "/handoff": {
        if (runNativeHandoffCommand) {
          await runNativeHandoffCommand(
            app,
            parts.slice(1).join(" "),
            commandContext?.(app) ?? fallbackCommandContext(app, _acpClient),
          );
        } else {
          await submitPromptToAgent(command, app);
        }
        break;
      }

      case "/settings": {
        openSettingsOverlay();
        break;
      }

      case "/mcp": {
        app.addBlock({
          type: "info",
          id: nextBlockId(),
          content: _pluginRunner ? formatMcpStatus(_pluginRunner.mcp.status()) : mcpNoServersMessage(),
          variant: "plain",
        });
        break;
      }

      case "/plugins": {
        openPluginsOverlay();
        break;
      }

      case "/yoloo": {
        const threadId = app.state.activeThreadId;
        const enabled = !store.threadYoloEnabled.has(threadId);
        if (enabled) store.threadYoloEnabled.add(threadId);
        else {
          store.threadYoloEnabled.delete(threadId);
          store.threadYoloLaunchEnabled.delete(threadId);
        }
        app.addBlock({
          type: "info",
          id: nextBlockId(),
          content: enabled
            ? "/yoloo enabled: All requests, including unsafe commands, are auto-approved."
            : "/yoloo disabled: Permission requests will require approval.",
          variant: enabled ? "warning" : "info",
        });
        break;
      }

      case "/reload": {
        try {
          await _reloadPlugins?.("reload");
          const diagnosticCount = pluginRunner()?.diagnostics.length ?? 0;
          app.addBlock({
            type: "info",
            id: nextBlockId(),
            content:
              diagnosticCount > 0
                ? `Reloaded Relay plugins with ${diagnosticCount} diagnostic${diagnosticCount === 1 ? "" : "s"}. Open /plugins for details.`
                : "Reloaded Relay plugins",
            variant: diagnosticCount > 0 ? "warning" : "info",
          });
        } catch (err) {
          app.addBlock({
            type: "info",
            id: nextBlockId(),
            content: `Plugin reload failed: ${err}`,
            variant: "error",
          });
        }
        break;
      }

      case "/resume": {
        if (parts.length > 1) {
          const sessionId = parts.slice(1).join(" ").trim();
          if (!sessionId) {
            app.addBlock({
              type: "info",
              id: nextBlockId(),
              content: "Usage: /resume [session-id]",
              variant: "warning",
            });
            break;
          }
          if (!_acpClient) {
            app.addBlock({
              type: "info",
              id: nextBlockId(),
              content: "Session resume requires an ACP agent. Launch with --agent <name>.",
              variant: "warning",
            });
            break;
          }
          if (!_acpClient.supportsSessionLoad() && !_acpClient.supportsSessionResume?.()) {
            app.addBlock({
              type: "info",
              id: nextBlockId(),
              content: "This ACP agent did not advertise session/load or session/resume.",
              variant: "warning",
            });
            break;
          }
          await loadSession(sessionId, app, _acpClient, _activeAgentName);
        } else {
          if (!_acpClient) {
            app.addBlock({
              type: "info",
              id: nextBlockId(),
              content: "Session resume requires an ACP agent. Launch with --agent <name>.",
              variant: "warning",
            });
            break;
          }
          if (
            !_acpClient.supportsSessionList() ||
            (!_acpClient.supportsSessionLoad() && !_acpClient.supportsSessionResume?.())
          ) {
            app.addBlock({
              type: "info",
              id: nextBlockId(),
              content: "This ACP agent did not advertise session/list and session/load or session/resume.",
              variant: "warning",
            });
            break;
          }
          await openResumePicker(app, _acpClient);
        }
        break;
      }

      case "/exit":
        if (_exitRenderer) void shutdownAndExit(_exitRenderer);
        break;

      default:
        await submitPromptToAgent(command, app);
    }
  };
}
