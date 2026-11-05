import { readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";

export type Layer = "core" | "acp" | "platform" | "application";

export interface BoundaryViolation {
  readonly file: string;
  readonly line: number;
  readonly sourceLayer: Layer;
  readonly targetLayer: string;
  readonly specifier: string;
}

const FORBIDDEN_IMPORTS: Readonly<Record<Layer, ReadonlySet<string>>> = {
  core: new Set(["acp", "application", "config", "plugins", "ui", "web"]),
  acp: new Set(["application", "config", "plugins", "ui", "web"]),
  platform: new Set(["acp", "application", "config", "plugins", "ui", "web"]),
  application: new Set(["plugins", "ui", "web"]),
};

const IMPORT_RE = /(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/gu;

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const absolute = path.join(directory, entry);
    const stat = statSync(absolute);
    if (stat.isDirectory()) files.push(...sourceFiles(absolute));
    else if (/\.(?:ts|tsx)$/u.test(entry)) files.push(absolute);
  }
  return files;
}

function sourceLayer(relativeFile: string): Layer | null {
  const first = relativeFile.split(path.sep)[0];
  return first === "core" || first === "acp" || first === "platform" || first === "application" ? first : null;
}

function importedLayer(file: string, specifier: string, srcRoot: string): string | null {
  if (specifier.startsWith("@/")) return specifier.slice(2).split("/")[0] ?? null;
  if (!specifier.startsWith(".")) return null;
  const resolved = path.resolve(path.dirname(file), specifier);
  const relative = path.relative(srcRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return relative.split(path.sep)[0] ?? null;
}

function lineNumber(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

export function checkBoundaries(root = process.cwd()): BoundaryViolation[] {
  const srcRoot = path.join(root, "src");
  const violations: BoundaryViolation[] = [];

  for (const file of sourceFiles(srcRoot)) {
    const relativeFile = path.relative(srcRoot, file);
    const layer = sourceLayer(relativeFile);
    if (!layer) continue;
    const source = readFileSync(file, "utf8");
    IMPORT_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = IMPORT_RE.exec(source)) !== null) {
      const specifier = match[1];
      const target = importedLayer(file, specifier, srcRoot);
      if (!target || !FORBIDDEN_IMPORTS[layer].has(target)) continue;
      violations.push({
        file: relativeFile,
        line: lineNumber(source, match.index),
        sourceLayer: layer,
        targetLayer: target,
        specifier,
      });
    }
  }

  return violations;
}

if (import.meta.main) {
  const violations = checkBoundaries();
  if (violations.length > 0) {
    console.error("Architecture boundary violations found:\n");
    for (const violation of violations) {
      console.error(
        `${violation.file}:${violation.line} ${violation.sourceLayer} must not import ${violation.targetLayer} (${violation.specifier})`,
      );
    }
    process.exit(1);
  }
  console.log("Architecture boundary check passed");
}
