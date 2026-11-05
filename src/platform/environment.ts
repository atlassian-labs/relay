/**
 * Exposes the current process environment through a narrow, injectable boundary.
 *
 * @returns The process environment as a read-only string record.
 */
export function runtimeEnvironment(): Readonly<Record<string, string | undefined>> {
  return process.env;
}
