---
name: relay-plugins
description: Create, modify, debug, and test Relay plugins and extensions. Use when a user asks to add Relay commands, keybindings, widgets, renderers, prompt hooks, settings, MCP integration, local policy, or other plugin behavior, whether as a local user plugin or a bundled plugin shipped through a plugin distribution repository.
disable-model-invocation: true
---

# Relay Plugins

Create plugins against Relay's public plugin SDK and validate them locally before considering distribution.

## Workflow

1. Read the bundled **Relay Extensions Reference** below before designing or changing a plugin.
2. Determine whether the requested plugin is local or bundled:
   - Default to a local user plugin under `${XDG_CONFIG_HOME:-$HOME/.config}/relay/plugins/<plugin-name>/`.
   - Treat requests containing "bundled", "built in", "ship with Relay", or equivalent language as plugin distribution repository work.
3. Inspect every existing plugin file that will be changed before editing it.
4. Prefer canonical TypeScript source. Use `@atlassian/relay-plugin-sdk`; do not import Relay `src/...` internals. Type exported factories and domain boundaries, validate unknown external data, and do not paper over migration errors with broad `any` types.
5. For package plugins, declare runtime libraries in `dependencies`, keep runtime assets package-relative, and avoid generated JavaScript entrypoints or a separate TypeScript compiler.
6. Keep Relay ACP-first. Plugins may customize Relay-owned UI, input, policy, MCP configuration, and workflow surfaces, but must not implement a second agent runtime or local agent tool layer.
7. Defer long-lived processes, sockets, watchers, timers, and servers until Relay or a workflow needs them. Clean them up idempotently on workflow close and `relay:shutdown`, including reload shutdown.
8. Before implementing a stateful widget, clarify its controls, repaint strategy, and lifetime. In particular, determine whether a turn-related surface closes on `turn:end` or remains open until the user closes it; ask when the request is ambiguous.
9. For interaction-driven widget state, replace the widget under the same `relay.ui.setWidget` key after each state change. Choose either widget `onKey` handling or enabled plugin keybindings for a surface rather than mixing both.
10. Add focused tests and meaningful type-checking. For stateful widgets, verify that interactions replace the widget and do not rely on calling `render()` directly as proof that Relay repaints.
11. After `/reload`, inspect `/plugins` and exercise every changed command, keybinding, renderer, or widget in Relay. If interactive validation is unavailable, state that limitation explicitly and do not claim the interaction was validated.

## Local Plugins First

Create and prove the plugin locally before proposing it for distribution:

```text
~/.config/relay/plugins/<plugin-name>/package.json
~/.config/relay/plugins/<plugin-name>/index.ts
```

Respect `XDG_CONFIG_HOME` when it is set. Use `/reload` after changes, then inspect `/plugins` for discovery errors, command conflicts, diagnostics, and MCP restart requirements. Exercise the plugin's command, keybinding, renderer, or widget in Relay as appropriate.

Do not create workspace-local `.relay/plugins` entries unless the user explicitly requests project plugin behavior and understands the trust implications.

## Bundled Plugins

Plugins shipped with Relay belong in a separate plugin distribution repository, not Relay's core repository. Ask the user which repository to use if it is not already configured.

Promote a plugin only after its local version works. Then:

1. Locate or clone the plugin distribution checkout.
2. Read its repository instructions.
3. Add the plugin as a TypeScript package under `plugins/<plugin-name>/`, with `index.ts` as its canonical source entrypoint.
4. Give the package explicit metadata, an `exports` entry for `./index.ts`, an `@atlassian/relay-plugin-sdk` dependency, and `relay.plugin: "index.ts"`.
5. Export the plugin factory from `plugins/index.ts` so Relay includes it in the bundled registry.
6. Add or update focused coverage under `test/plugins/`.
7. Run the affected test, `bun run typecheck`, and that repository's full check.
8. Run Relay's production build and exercise the plugin from that build.
9. Keep distribution-only assumptions out of the local version where possible.

Do not copy a bundled plugin into Relay's `src/plugins/bundled`; the build stages that directory from the plugin distribution repository. Do not add a separate plugin compiler: Bun compiles registered TypeScript factories into Relay's executable bundle, and the existing build stages package source and runtime assets.

## Safety and Compatibility

- Install only trusted plugin code; plugins execute inside the Relay process.
- Treat ACP and tool payloads as unknown data and validate before use.
- Return `null` from renderers when Relay should use its default rendering.
- Ignore unfamiliar optional fields and preserve forward compatibility where practical.
- Preserve unrelated user plugin files and settings.
- Never commit or push unless the user asks.
