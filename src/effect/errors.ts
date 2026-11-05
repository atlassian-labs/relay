import { Data } from "effect";

export class RelayError extends Data.TaggedError("RelayError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class AcpConnectionClosedError extends Data.TaggedError("AcpConnectionClosedError")<{
  readonly message: string;
}> {}

export class AcpRequestError extends Data.TaggedError("AcpRequestError")<{
  readonly message: string;
  readonly code?: number;
  readonly data?: unknown;
}> {}

export class AcpUnsupportedMethodError extends Data.TaggedError("AcpUnsupportedMethodError")<{
  readonly method: string;
  readonly message?: string;
}> {}

export class AcpUnsupportedCapabilityError extends Data.TaggedError("AcpUnsupportedCapabilityError")<{
  readonly capability: string;
  readonly method?: string;
  readonly message?: string;
}> {}

export class AcpProtocolError extends Data.TaggedError("AcpProtocolError")<{
  readonly message: string;
  readonly data?: unknown;
  readonly cause?: unknown;
}> {}

export class AcpPromptTooLargeError extends Data.TaggedError("AcpPromptTooLargeError")<{
  readonly message: string;
  readonly totalBytes: number;
  readonly maxBytes: number;
}> {}

export class AcpClientNotConnectedError extends Data.TaggedError("AcpClientNotConnectedError")<{
  readonly operation: string;
}> {}

export class AcpNoActiveSessionError extends Data.TaggedError("AcpNoActiveSessionError")<{
  readonly operation: string;
}> {}

export class AcpLaunchCommandMissingError extends Data.TaggedError("AcpLaunchCommandMissingError")<{
  readonly message: string;
}> {}

export class ConfigOperationError extends Data.TaggedError("ConfigOperationError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class UserBashError extends Data.TaggedError("UserBashError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class NotificationError extends Data.TaggedError("NotificationError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export type RelayEffectError =
  | RelayError
  | AcpConnectionClosedError
  | AcpRequestError
  | AcpUnsupportedMethodError
  | AcpUnsupportedCapabilityError
  | AcpProtocolError
  | AcpClientNotConnectedError
  | AcpNoActiveSessionError
  | AcpLaunchCommandMissingError
  | ConfigOperationError
  | UserBashError
  | NotificationError;

export function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return String(error);
}
