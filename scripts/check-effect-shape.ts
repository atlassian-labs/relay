#!/usr/bin/env bun

import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, join } from "node:path";

export type EffectShapeRule = {
  readonly id: string;
  readonly description: string;
  readonly pattern: RegExp;
  readonly allowed: readonly RegExp[];
  readonly requiresAllowComment?: boolean;
};

export type EffectShapeViolation = {
  readonly file: string;
  readonly line: number;
  readonly rule: EffectShapeRule;
  readonly text: string;
};

export type EffectShapeCheckOptions = {
  readonly cwd?: string;
  readonly strictRoots?: readonly string[];
};

const defaultStrictRoots = ["src"];
const sourceExtensions = new Set([".ts", ".tsx"]);

const bridgeFiles = [/^src\/index\.ts$/, /^src\/effect\/runtime\.ts$/, /^src\/platform\//];

const explicitBridgeFiles = [
  /^src\/acp\/client\.ts$/,
  /^src\/core\/git-branch-watcher\.ts$/,
  /^src\/ui\/util\/clipboard\.ts$/,
  /^src\/ui\/util\/links\.ts$/,
  /^src\/ui\/context\/helper\.tsx$/,
  /^src\/ui\/state\.ts$/,
];

const uiBridgeFiles = [
  /^src\/ui\/app\.tsx$/,
  /^src\/ui\/app-root\.tsx$/,
  /^src\/ui\/app\//,
  /^src\/ui\/component\//,
  /^src\/ui\/ui\//,
  /^src\/ui\/util\/paste-textarea\.ts$/,
];

const pureLegacyFiles = [/^src\/config\/themes\.ts$/, /^src\/ui\/tool-renderers\//];

const rules: readonly EffectShapeRule[] = [
  {
    id: "effect-runner-boundary",
    description: "Effect runners are allowed only in runtime bridge files with an effect-shape-allow comment.",
    pattern: /\bEffect\.run(?:Promise|PromiseExit|Sync|SyncExit|Fork|Callback)\b|\bappRuntime\.runPromise(?:Exit)?\b/,
    allowed: [/^src\/effect\/runtime\.ts$/],
    requiresAllowComment: true,
  },
  {
    id: "no-new-promise",
    description: "Use Effect.async, Deferred, Queue, or Stream instead of raw new Promise in strict source.",
    pattern: /\bnew Promise\b/,
    allowed: [...bridgeFiles, ...uiBridgeFiles],
  },
  {
    id: "no-promise-concurrency",
    description: "Use Effect concurrency primitives instead of Promise.all/race/allSettled/any.",
    pattern: /\bPromise\.(?:all|race|allSettled|any)\b/,
    allowed: [...bridgeFiles, ...uiBridgeFiles],
  },
  {
    id: "no-effect-sync-async",
    description:
      "Do not hide async work inside Effect.sync; expose the async boundary as Effect.promise/callback with cleanup.",
    pattern: /\bEffect\.sync\s*\(\s*(?:async\b|\([^)]*\)\s*=>\s*[A-Za-z_$][\w$]*\()/,
    allowed: [...bridgeFiles],
  },
  {
    id: "no-effect-succeed-promise",
    description: "Do not succeed with a Promise; use Effect.promise or an Effect-native async primitive.",
    pattern: /\bEffect\.succeed\s*\([^)]*(?:Promise\.|new Promise\b|\w+Promise\b)/,
    allowed: [...bridgeFiles],
  },
  {
    id: "no-exported-async-service-method",
    description: "Export Effect-returning service methods instead of Promise-returning async APIs from strict source.",
    pattern: /\bexport\s+(?:async\s+function|const\s+\w+\s*=\s*async\b)/,
    allowed: [...bridgeFiles, ...uiBridgeFiles],
  },
  {
    id: "effect-async-requires-local-allow",
    description: "Effect.async callback bridges must carry a local cancellation/finalizer reason.",
    pattern: /\bEffect\.async\b/,
    allowed: [...bridgeFiles],
    requiresAllowComment: true,
  },
  {
    id: "no-effect-promise-in-strict-source",
    description:
      "Use Effect.tryPromise with tagged error mapping, Effect.async, or Stream.asyncScoped instead of Effect.promise.",
    pattern: /\bEffect\.promise\b/,
    allowed: [...bridgeFiles, ...uiBridgeFiles],
  },
  {
    id: "no-fire-and-forget-async-iife",
    description: "Use runUiEffect or supervised fibers instead of void async IIFEs.",
    pattern: /\bvoid\s*\(\s*async\s*\(\)/,
    allowed: [],
    requiresAllowComment: true,
  },
  {
    id: "no-direct-process-env",
    description: "Use an Effect platform/config boundary instead of direct process.env in app code.",
    pattern: /\bprocess\.env\b|\bBun\.env\b/,
    allowed: bridgeFiles,
  },
  {
    id: "no-direct-platform-time",
    description: "Use Effect Clock/Schedule at effectful boundaries instead of direct wall-clock/timers.",
    pattern: /\bDate\.now\b|\bnew Date\s*\(|\bsetTimeout\b|\bsetInterval\b|\bMath\.random\b|\brandomUUID\b/,
    allowed: [...bridgeFiles, ...uiBridgeFiles, /^src\/config\/index\.ts$/],
  },
  {
    id: "no-direct-node-io",
    description: "Node fs/child_process IO belongs in platform adapters or approved legacy pure modules.",
    pattern: /from\s+["'](?:node:)?(?:fs|child_process)["']|require\(["'](?:node:)?child_process["']\)/,
    allowed: [...bridgeFiles, /^src\/config\/index\.ts$/, /^src\/skills\.ts$/],
  },
  {
    id: "no-explicit-any",
    description: "Use unknown plus boundary decoding/type guards instead of any.",
    pattern: /\bany\b/,
    allowed: [...uiBridgeFiles, ...pureLegacyFiles, /^src\/core\/git-branch-watcher\.ts$/],
  },
  {
    id: "no-throw-in-effect-tier",
    description: "Return typed Effect failures instead of throwing from app-owned effectful code.",
    pattern: /\bthrow\s+new\b|\bthrow\s+[A-Za-z_]/,
    allowed: [...bridgeFiles, ...explicitBridgeFiles, ...uiBridgeFiles, ...pureLegacyFiles, /^src\/config\/index\.ts$/],
    requiresAllowComment: true,
  },
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) return walk(path);
    return sourceExtensions.has(path.slice(path.lastIndexOf("."))) ? [path] : [];
  });
}

function hasAllowComment(lines: readonly string[], index: number): boolean {
  if (/^\s*\/\/\s*effect-shape-allow:\s*\S/.test(lines[index - 1] ?? "")) return true;
  return /\S.*\/\/\s*effect-shape-allow:\s*\S/.test(lines[index] ?? "");
}

function isAllowed(file: string, rule: EffectShapeRule, lines: readonly string[], index: number): boolean {
  if (hasAllowComment(lines, index)) return true;
  if (rule.requiresAllowComment) return false;
  return rule.allowed.some((allowed) => allowed.test(file));
}

function toCheckPath(cwd: string, file: string): string {
  return relative(cwd, file).replaceAll("\\", "/");
}

export function checkEffectShape(options: EffectShapeCheckOptions = {}): EffectShapeViolation[] {
  const cwd = options.cwd ?? process.cwd();
  const strictRoots = options.strictRoots ?? defaultStrictRoots;

  return strictRoots
    .map((root) => join(cwd, root))
    .flatMap(walk)
    .flatMap((absoluteFile) => {
      const file = toCheckPath(cwd, absoluteFile);
      const lines = readFileSync(absoluteFile, "utf8").split("\n");
      return lines.flatMap((text, index) =>
        rules
          .filter((rule) => rule.pattern.test(text) && !isAllowed(file, rule, lines, index))
          .map((rule): EffectShapeViolation => ({ file, line: index + 1, rule, text: text.trim() })),
      );
    });
}

export function checkNewEffectShapeViolations(options: EffectShapeCheckOptions = {}): EffectShapeViolation[] {
  return checkEffectShape(options);
}

export function formatEffectShapeViolations(violations: readonly EffectShapeViolation[]): string {
  const lines = ["Effect shape violations found:", ""];
  for (const violation of violations) {
    lines.push(`${violation.file}:${violation.line} ${violation.rule.id}`);
    lines.push(`  ${violation.rule.description}`);
    lines.push(`  ${violation.text}`, "");
  }
  return lines.join("\n");
}

if (import.meta.main) {
  const violations = checkNewEffectShapeViolations();

  if (violations.length > 0) {
    console.error(formatEffectShapeViolations(violations));
    process.exit(1);
  }

  console.log("Effect shape check passed");
}
