import { currentEnv } from "./platform/env";
import { readFileSync } from "./platform/fs";

declare const __RELAY_VERSION__: string | undefined;

function publishedVersion(value: string | undefined): string | null {
  const version = value?.trim();
  return version && version !== "dev" ? version : null;
}

function pinnedAtlasVersion(): string | null {
  // Build artifacts receive this value from scripts/build.ts. When it is defined,
  // including as "dev", the artifact must not depend on a runtime marker file.
  if (typeof __RELAY_VERSION__ !== "undefined") {
    return publishedVersion(__RELAY_VERSION__);
  }

  try {
    return publishedVersion(readFileSync(new URL("../.relay-version", import.meta.url), "utf8"));
  } catch {
    return null;
  }
}

const atlasPluginVersion = publishedVersion(currentEnv().RELAY_ATLAS_PLUGIN_VERSION);
// Every shim build passes its artifact version here, including public release
// archives that are not Atlas-managed.
const releaseShimVersion = publishedVersion(currentEnv().RELAY_RELEASE_VERSION);

// Only Atlas-managed installs can be upgraded by `atlas plugin upgrade`. Local
// launchers may still carry a published version, but updating Atlas does not
// replace their build.
export const IS_ATLAS_PLUGIN_INSTALL = atlasPluginVersion !== null;

// Shim installs receive their exact artifact version from the Go shim. Source and
// local installs use the Atlas version pinned in the repository.
export const VERSION = atlasPluginVersion ?? releaseShimVersion ?? pinnedAtlasVersion() ?? "dev";
export const VERSION_LABEL = VERSION === "dev" ? "relay dev" : `relay v${VERSION}`;
export const ACP_CLIENT_VERSION = VERSION;
