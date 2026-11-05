export interface ParsedSkillInvocation {
  name: string;
  location: string;
  content: string;
  userMessage: string | undefined;
}

export interface SkillInvocationDisplay {
  name: string;
  userMessage: string | undefined;
  complete: boolean;
}

interface SkillFrontmatter {
  name?: string;
  description?: string;
  userInvocable?: string;
  registerCmd?: string;
}

interface FrontmatterBlock {
  frontmatter: SkillFrontmatter;
  body: string;
  closed: boolean;
}

const WRAPPING_QUOTE_PAIRS = [
  { open: '"', close: '"' },
  { open: "'", close: "'" },
  { open: "“", close: "”" },
  { open: "‘", close: "’" },
];

function stripWrappingQuotes(value: string, depth = 0): string {
  const trimmed = value.trim();
  if (depth >= 4) return trimmed;
  const pair = WRAPPING_QUOTE_PAIRS.find((item) => trimmed.startsWith(item.open) && trimmed.endsWith(item.close));
  return pair ? stripWrappingQuotes(trimmed.slice(pair.open.length, -pair.close.length), depth + 1) : trimmed;
}

function normalizeFrontmatterScalar(value: string): string {
  return stripWrappingQuotes(value);
}

function displayNameFromSkillName(name: string | undefined): string | undefined {
  const normalized = name === undefined ? "" : normalizeFrontmatterScalar(name).replace(/^\/+/, "").trim();
  return normalized || undefined;
}

function skillNameToSlashCommandName(name: string): string | undefined {
  const commandName = normalizeFrontmatterScalar(name)
    .toLowerCase()
    .replace(/^\/+/, "")
    .replace(/[_\s]+/gu, "-")
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "");
  return commandName || undefined;
}

function parseFrontmatterLine(frontmatter: SkillFrontmatter, line: string): void {
  const sep = line.indexOf(":");
  if (sep === -1) return;
  const key = line.slice(0, sep).trim();
  const value = normalizeFrontmatterScalar(line.slice(sep + 1));
  switch (key) {
    case "name":
      frontmatter.name = value;
      break;
    case "description":
      frontmatter.description = value;
      break;
    case "user-invocable":
      frontmatter.userInvocable = value;
      break;
    case "register_cmd":
    case "register-cmd":
      frontmatter.registerCmd = value;
      break;
  }
}

function parseFrontmatterBlock(content: string, requireClosed: boolean): FrontmatterBlock | null {
  const normalized = content.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length === 0 || lines[0].trim() !== "---") return null;

  const frontmatter: SkillFrontmatter = {};
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === "---") {
      return {
        frontmatter,
        body: lines
          .slice(index + 1)
          .join("\n")
          .trim(),
        closed: true,
      };
    }
    parseFrontmatterLine(frontmatter, lines[index]);
  }

  if (requireClosed) return null;
  return { frontmatter, body: "", closed: false };
}

function hasSkillFrontmatter(frontmatter: SkillFrontmatter): boolean {
  return Boolean(frontmatter.name || frontmatter.userInvocable !== undefined || frontmatter.registerCmd !== undefined);
}

function parseWrappedSkillInvocationPrompt(text: string): ParsedSkillInvocation | null {
  const match = text.match(/^<skill name="([^"]+)" location="([^"]*)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/);
  if (!match) return null;
  return {
    name: displayNameFromSkillName(match[1]) ?? "skill",
    location: match[2],
    content: match[3],
    userMessage: match[4]?.trim() ? match[4] : undefined,
  };
}

function parseRawSlashSkillInvocationPrompt(text: string): ParsedSkillInvocation | null {
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length < 2) return null;

  const invocation = lines[0].match(/^\/([a-z0-9-]+)(?:[\t ]+(.*))?$/);
  if (!invocation) return null;

  const frontmatterStartIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (frontmatterStartIndex === -1) return null;

  const skillMarkdown = lines.slice(frontmatterStartIndex).join("\n");
  const block = parseFrontmatterBlock(skillMarkdown, true);
  if (!block || !hasSkillFrontmatter(block.frontmatter)) return null;

  const frontmatterCommandName = block.frontmatter.name
    ? skillNameToSlashCommandName(block.frontmatter.name)
    : undefined;
  if (frontmatterCommandName && frontmatterCommandName !== invocation[1]) return null;

  const userMessageLines = invocation[2] === undefined ? [] : [invocation[2]];
  userMessageLines.push(...lines.slice(1, frontmatterStartIndex));
  while (userMessageLines.length > 0 && userMessageLines[userMessageLines.length - 1]?.trim() === "") {
    userMessageLines.pop();
  }
  const userMessage = userMessageLines.join("\n");
  return {
    name: displayNameFromSkillName(block.frontmatter.name) ?? invocation[1],
    location: "",
    content: block.body,
    userMessage: userMessage.trim() ? userMessage : undefined,
  };
}

function splitFilesystemSkillArguments(body: string): { content: string; userMessage: string | undefined } {
  const marker = "ARGUMENTS:";
  const lineMarker = `\n${marker}`;
  const markerIndex = body.lastIndexOf(lineMarker);
  if (markerIndex === -1) {
    if (!body.startsWith(marker)) return { content: body, userMessage: undefined };
    const rawLeadingArgs = body.slice(marker.length);
    const leadingArgs = rawLeadingArgs.startsWith(" ") ? rawLeadingArgs.slice(1) : rawLeadingArgs;
    return { content: "", userMessage: leadingArgs.trim() ? leadingArgs : undefined };
  }

  const content = body.slice(0, markerIndex).trim();
  const rawArgs = body.slice(markerIndex + lineMarker.length);
  const userMessage = rawArgs.startsWith(" ") ? rawArgs.slice(1) : rawArgs;
  return { content, userMessage: userMessage.trim() ? userMessage : undefined };
}

function parseFilesystemSkillInvocationPrompt(text: string): ParsedSkillInvocation | null {
  const block = parseFrontmatterBlock(text, true);
  if (!block || !hasSkillFrontmatter(block.frontmatter)) return null;

  const { content, userMessage } = splitFilesystemSkillArguments(block.body);
  return {
    name: displayNameFromSkillName(block.frontmatter.name) ?? "skill",
    location: "",
    content,
    userMessage,
  };
}

export function parseSkillInvocationPrompt(text: string): ParsedSkillInvocation | null {
  return (
    parseWrappedSkillInvocationPrompt(text) ??
    parseRawSlashSkillInvocationPrompt(text) ??
    parseFilesystemSkillInvocationPrompt(text)
  );
}

function partialWrappedSkillInvocationDisplay(text: string): SkillInvocationDisplay | null {
  const match = text.match(/^<skill(?:\s+name="([^"]*)")?/);
  if (!match) return null;
  return { name: displayNameFromSkillName(match[1]) ?? "skill", userMessage: undefined, complete: false };
}

function partialRawSlashSkillInvocationDisplay(text: string): SkillInvocationDisplay | null {
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const invocation = lines[0]?.match(/^\/([a-z0-9-]+)(?:[\t ]+(.*))?$/);
  if (!invocation) return null;
  const frontmatterStartIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (frontmatterStartIndex === -1) return null;

  const userMessageLines = invocation[2] === undefined ? [] : [invocation[2]];
  userMessageLines.push(...lines.slice(1, frontmatterStartIndex));
  while (userMessageLines.length > 0 && userMessageLines[userMessageLines.length - 1]?.trim() === "") {
    userMessageLines.pop();
  }
  const userMessage = userMessageLines.join("\n");
  return { name: invocation[1], userMessage: userMessage.trim() ? userMessage : undefined, complete: false };
}

function partialFilesystemSkillInvocationDisplay(text: string): SkillInvocationDisplay | null {
  const block = parseFrontmatterBlock(text, false);
  if (!block || !hasSkillFrontmatter(block.frontmatter)) return null;
  if (block.closed) return null;
  return {
    name: displayNameFromSkillName(block.frontmatter.name) ?? "skill",
    userMessage: undefined,
    complete: false,
  };
}

export function skillInvocationDisplay(
  text: string,
  options: { allowPartial?: boolean } = {},
): SkillInvocationDisplay | null {
  const complete = parseSkillInvocationPrompt(text);
  if (complete) {
    return { name: complete.name, userMessage: complete.userMessage, complete: true };
  }
  if (!options.allowPartial) return null;
  return (
    partialWrappedSkillInvocationDisplay(text) ??
    partialRawSlashSkillInvocationDisplay(text) ??
    partialFilesystemSkillInvocationDisplay(text)
  );
}

export function formatSkillInvocationPreview(text: string): string | null {
  const skill = skillInvocationDisplay(text);
  if (!skill) return null;
  const userMessage = skill.userMessage?.trim() ? skill.userMessage.replace(/\s+/g, " ").trim() : "";
  return `[skill] ${skill.name}${userMessage ? ` — ${userMessage}` : ""}`;
}
