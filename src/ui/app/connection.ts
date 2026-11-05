import type { AcpClient } from "../../acp/client";
import { getRelayLogPath } from "../../logging/logger";

export function formatConnectionFailure(agentName: string, error: unknown, client?: AcpClient | null): string {
  const paths = client?.diagnosticLogPaths?.();
  const relayLogPath = paths?.relay ?? getRelayLogPath();
  const lines = [`Failed to connect to ${agentName} agent: ${error instanceof Error ? error.message : String(error)}`];
  if (relayLogPath) lines.push(`Relay log: ${relayLogPath}`);
  if (paths?.stderr) lines.push(`Agent stderr log: ${paths.stderr}`);
  return lines.join("\n");
}
