const UNSAFE_STARTUP_ERROR_TEXT =
  /https?:\/\/|\bBearer\s+\S+|(?:token|secret|password|authorization|cookie|api[_-]?key|access[_-]?key)/iu;
const STARTUP_ERROR_PREFIXES = [
  /^\[[^\]]+\]\s+(?:error|fatal error(?: in [^:]+)?):\s*/iu,
  /^(?:error|fatal(?: error)?(?: in [^:]+)?):\s*/iu,
] as const;
const STARTUP_HINT_PREFIX = /^hint:\s*/iu;
// oxlint-disable-next-line no-control-regex
const STDERR_CONTROL_SEQUENCE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])|\x07/gu;

function cleanLine(line: string): string {
  return line.replace(STDERR_CONTROL_SEQUENCE, "").trim();
}

function stripStartupErrorPrefix(line: string): string {
  let message = line;
  for (const prefix of STARTUP_ERROR_PREFIXES) message = message.replace(prefix, "");
  return message;
}

function startupErrorFromLine(line: string): string {
  const message = stripStartupErrorPrefix(line);
  if (message === line || message === "" || UNSAFE_STARTUP_ERROR_TEXT.test(message)) return "";
  return message;
}

function startupHintFromLine(line: string): string {
  const match = STARTUP_HINT_PREFIX.exec(line);
  if (!match) return "";

  const hint = line.slice(match[0].length).trim();
  if (hint === "" || UNSAFE_STARTUP_ERROR_TEXT.test(hint)) return "";
  return hint;
}

export function primaryStartupErrorFromStderr(raw: string): string {
  const lines = raw
    .split(/\r?\n/u)
    .map(cleanLine)
    .filter((line) => line.length > 0);

  for (const [index, line] of lines.entries()) {
    const message = startupErrorFromLine(line);
    if (!message) continue;

    const hint = startupHintFromLine(lines[index + 1] ?? "");
    if (!hint) return message;
    return message.includes(hint) ? message : `${message} ${hint}`;
  }

  return "";
}
