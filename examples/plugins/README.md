# Relay Plugin Examples

Copy any example into `~/.config/relay/plugins/<plugin-name>/index.ts`, enable plugins, then run `/reload` in Relay.

```toml
[plugins]
enabled = true
```

These examples are intentionally closer to real plugin workflows than tiny API samples. They focus on Relay-owned surfaces: UI, prompt workflow, local shell policy, ACP request policy, MCP orchestration, and autocomplete. Relay remains ACP-first; plugins should not implement a local agent runtime or agent-owned tools.

| Example                                                      | What it demonstrates                                                                                                                             |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`permission-safety-policy.ts`](permission-safety-policy.ts) | Local ACP permission policy: deny dangerous bash, auto-approve obvious read-only commands, leave the rest to Relay's approval UI.                |
| [`code-review-helper.ts`](code-review-helper.ts)             | A `/review-changes` workflow that opens Relay's diff UI, asks for confirmation, then submits a focused review prompt to the active ACP agent.    |
| [`mcp-manager.ts`](mcp-manager.ts)                           | Plugin MCP lifecycle management: register a server, inspect active vs pending MCP state, and prompt/restart when changes need a new ACP process. |
| [`fff-path-autocomplete.ts`](fff-path-autocomplete.ts)       | Override `@` path autocomplete with an async FFF-backed provider before Relay's built-in fd-backed provider runs.                                |

## Notes

- Plugins run inside the Relay process with local code execution privileges.
- Keep plugins defensive. Treat raw ACP updates, tool payloads, and shell output as unknown data.
- `fff-path-autocomplete.ts` expects `RELAY_FFF_COMMAND` or `fff-relay-files` to print repo-relative paths, one per line. Use it as a bridge pattern for `@ff-labs/fff-node` or your local FFF wrapper.
- After creating or editing a plugin, run `/reload` in Relay.
