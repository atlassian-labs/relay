export function composeUserBashContext(
  text: string,
  pendingResults: Array<{ command: string; output: string; exitCode: number | undefined }>,
): string {
  if (pendingResults.length === 0) return text;
  const bashSection = pendingResults
    .map((result) => {
      let entry = `$ ${result.command}\n${result.output.trimEnd()}`;
      if (result.exitCode !== undefined && result.exitCode !== 0) entry += `\n(exit ${result.exitCode})`;
      return entry;
    })
    .join("\n\n");
  return `${text}\n---\nThe user ran the following commands and wants you to see their output:\n\n${bashSection}`;
}

export * as SubmitUtil from "./submit";
