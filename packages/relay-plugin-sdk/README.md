# @atlassian/relay-plugin-sdk

Runtime helpers and TypeScript types for Relay plugin authors. This package is the stable authoring entrypoint for plugins.

```sh
bun add @atlassian/relay-plugin-sdk
```

```ts
import { defineRelayPlugin, relayCard, type RelayPluginApi } from "@atlassian/relay-plugin-sdk";

export default defineRelayPlugin((relay: RelayPluginApi) => {
  relay.tools.registerRenderer({
    toolNames: ["example_tool"],
    renderResult: () => relayCard({ title: "Example", lines: ["Done"] }),
  });
});
```

Do not import from Relay `src/...` internals. The legacy `relay/plugin` entrypoint remains supported for existing plugins, but new plugin packages should use this SDK.

Full docs: [Relay Extensions](../../docs/extensions.md).
