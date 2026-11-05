import * as os from "node:os";
import * as path from "node:path";
import { getHomeEnv, getXdgConfigHome } from "./env";

export const CONFIG_DIR_NAME = "relay";
const LEGACY_CONFIG_DIR_NAME = ".relay";

function resolveHome(): string {
  const envHome = getHomeEnv();
  return envHome && path.isAbsolute(envHome) ? envHome : os.homedir();
}

export function getConfigDir(): string {
  const xdg = getXdgConfigHome();
  if (xdg && path.isAbsolute(xdg)) return path.join(xdg, CONFIG_DIR_NAME);
  return path.join(resolveHome(), ".config", CONFIG_DIR_NAME);
}

export function getCacheDir(): string {
  return path.join(getConfigDir(), "cache");
}

export function getLegacyConfigDir(): string {
  return path.join(resolveHome(), LEGACY_CONFIG_DIR_NAME);
}
