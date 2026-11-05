import * as fs from "node:fs";
import * as path from "node:path";
import { runParent } from "./parent/run-parent";
import { parseParentOptions } from "./protocol/options";

function writeOutput(output: unknown, outputPath: string | undefined): void {
  const json = `${JSON.stringify(output, null, 2)}
`;
  if (!outputPath) {
    process.stdout.write(json);
    return;
  }
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  fs.writeFileSync(outputPath, json);
  console.error(`wrote ${outputPath}`);
}

async function main(): Promise<void> {
  const options = parseParentOptions(process.argv.slice(2));
  writeOutput(await runParent(options), options.outputPath);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    console.error(message);
    process.exit(1);
  });
}
