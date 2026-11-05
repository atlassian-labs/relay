import type { AcpClient, AcpClientCallbacks, AcpClientOptions } from "../../acp/client";
import type { ExternalEditorOptions, ExternalEditorResult } from "../util/external-editor";
import type { TerminalTitleOutput } from "../util/terminal-title";
import type { TranscriptRendererMode } from "../util/transcript-renderer-mode";

export interface AppProps {
  cwd: string;
  initialAgent: string;
  initialAcpCommand?: string;
  initialContinue: boolean;
  initialResume: boolean;
  initialResumeSessionId: string;
  initialDefaultRenderer: boolean;
  initialYolo?: boolean;
  initialPrompt?: string;
  /** Thinking level to apply on launch, overriding the agent's configured preferred thinking level. */
  initialThinkingLevel?: string;
  acpClientFactory?: (callbacks: AcpClientCallbacks, opts: AcpClientOptions) => AcpClient;
  externalEditor?: (options: ExternalEditorOptions) => Promise<ExternalEditorResult>;
  terminalTitleOutput?: TerminalTitleOutput;
  transcriptRendererMode?: TranscriptRendererMode;
}

export interface LaunchOptions {
  cwd?: string;
  agent?: string;
  defaultRenderer?: boolean;
  yolo?: boolean;
  resume?: boolean;
  resumeSessionId?: string;
  continueSession?: boolean;
  acpCommand?: string;
  initialPrompt?: string;
  /** Thinking level to apply on launch, overriding the agent's configured preferred thinking level. */
  thinkingLevel?: string;
  acpClientFactory?: (callbacks: AcpClientCallbacks, opts: AcpClientOptions) => AcpClient;
}
