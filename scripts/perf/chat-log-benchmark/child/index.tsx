import { parseChildOptions } from "../protocol/options";
import type { SourceProvenance } from "../protocol/result";
import { SOURCE_PROVENANCE_ENV, assertSourceProvenance } from "../protocol/source-provenance";
import { runScenario } from "./scenario/run-scenario";

async function main(): Promise<void> {
  const options = parseChildOptions(process.argv.slice(2));
  const expectedSourceText = process.env[SOURCE_PROVENANCE_ENV];
  const expectedSource = expectedSourceText ? (JSON.parse(expectedSourceText) as SourceProvenance) : null;
  if (expectedSource) assertSourceProvenance(expectedSource);
  const result = await runScenario(options);
  if (expectedSource) assertSourceProvenance(expectedSource);
  process.stdout.write(`${JSON.stringify(result, null, 2)}
`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    console.error(message);
    process.exit(1);
  });
}
