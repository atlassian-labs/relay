export function getHomeEnv(): string | undefined {
  return process.env.HOME || process.env.USERPROFILE;
}

export function getXdgConfigHome(): string | undefined {
  return process.env.XDG_CONFIG_HOME;
}

export function currentEnv(): NodeJS.ProcessEnv {
  return process.env;
}

export function currentPlatform(): NodeJS.Platform {
  return process.platform;
}
