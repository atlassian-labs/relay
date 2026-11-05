import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkBoundaries } from "../../scripts/check-boundaries";

const tempRoots: string[] = [];

function fixture(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "relay-boundaries-"));
  tempRoots.push(root);
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = join(root, relativePath);
    mkdirSync(join(absolutePath, ".."), { recursive: true });
    writeFileSync(absolutePath, content);
  }
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("architecture boundary checker", () => {
  test("allows dependencies toward core and platform", () => {
    const root = fixture({
      "src/core/model.ts": "export interface Model { id: string }\n",
      "src/platform/store.ts": 'import type { Model } from "../core/model";\nexport type Stored = Model;\n',
      "src/acp/client.ts": 'import type { Model } from "../core/model";\nexport type ClientModel = Model;\n',
      "src/application/run.ts": 'import type { ClientModel } from "../acp/client";\nexport type Run = ClientModel;\n',
    });

    expect(checkBoundaries(root)).toEqual([]);
  });

  test("reports inward layers importing presentation or application layers", () => {
    const root = fixture({
      "src/core/model.ts": 'import type { Screen } from "../ui/screen";\nexport type Model = Screen;\n',
      "src/acp/client.ts": 'export { run } from "../application/run";\n',
      "src/application/run.ts": "export const run = true;\n",
      "src/ui/screen.ts": "export interface Screen { id: string }\n",
    });

    const violations = checkBoundaries(root);
    expect(violations).toHaveLength(2);
    expect(violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ file: join("core", "model.ts"), sourceLayer: "core", targetLayer: "ui" }),
        expect.objectContaining({
          file: join("acp", "client.ts"),
          sourceLayer: "acp",
          targetLayer: "application",
        }),
      ]),
    );
  });
});
