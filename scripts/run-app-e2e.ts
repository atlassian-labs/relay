import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const testDir = "./test/ui/app-e2e";

function decodeStringLiteral(value: string): string {
  return JSON.parse(`"${value}"`) as string;
}

function testNamesInFile(testFile: string): string[] {
  const source = readFileSync(testFile, "utf8");
  return [...source.matchAll(/(?:^|\n)\s*test\("((?:\\.|[^"\\])+)"/g)].map((match) => decodeStringLiteral(match[1]));
}

const testFiles = readdirSync(testDir)
  .filter((entry) => entry.endsWith(".test.tsx"))
  .sort()
  .map((entry) => join(testDir, entry));

if (testFiles.length === 0) {
  console.error(`Expected app E2E test files in ${testDir}; found none`);
  process.exit(1);
}

const testCounts = testFiles.map((testFile) => ({ testFile, count: testNamesInFile(testFile).length }));
const totalTests = testCounts.reduce((sum, entry) => sum + entry.count, 0);

if (totalTests < 15) {
  console.error(`Expected at least 15 app E2E tests in ${testDir}; found ${totalTests}`);
  process.exit(1);
}

for (const { testFile, count } of testCounts) {
  if (count === 0) {
    console.error(`Expected app E2E tests in ${testFile}; found none`);
    process.exit(1);
  }
}

// Bun 1.3.x can crash in CI when the plugin-heavy frame-capture tests run in
// one long native OpenTUI process. Keep each focused file in its own bounded
// process while preserving deterministic file order.
for (const [fileIndex, { testFile, count }] of testCounts.entries()) {
  console.log(`[app-e2e] running file ${fileIndex + 1}/${testFiles.length} ${testFile} (${count} tests)`);

  // Frame-capture tests render real terminal output and are several times slower
  // on shared CI runners than locally, so Bun's 5s default times them out at
  // random. Keep a generous ceiling that still catches a genuine hang.
  const result = spawnSync(process.execPath, ["test", "--timeout=60000", testFile], {
    stdio: "inherit",
    env: process.env,
  });

  if (result.signal) {
    console.error(`[app-e2e] ${testFile} terminated by ${result.signal}`);
    process.exit(1);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
