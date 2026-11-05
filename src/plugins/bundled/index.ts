import type { RelayPluginFactory } from "../types";

export interface BundledRelayPlugin {
  readonly id: string;
  readonly name: string;
  readonly script: string;
  readonly factory: RelayPluginFactory;
  readonly description?: string;
  readonly author?: string;
}

export const BUNDLED_RELAY_PLUGINS: readonly BundledRelayPlugin[] = [];
