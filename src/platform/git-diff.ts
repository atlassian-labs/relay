import { Effect } from "effect";
import { parseUnifiedDiff, type DiffFile } from "../core/diff-utils";

function readText(stream: ReadableStream<Uint8Array> | null): Effect.Effect<string> {
  if (!stream) return Effect.succeed("");
  return Effect.tryPromise(() => new Response(stream).text()).pipe(Effect.catch(() => Effect.succeed("")));
}

type GitTextOptions = {
  readonly allowedExitCodes?: readonly number[];
};

function gitText(cwd: string, args: readonly string[], options: GitTextOptions = {}): Effect.Effect<string> {
  return Effect.gen(function* () {
    let process: Bun.Subprocess<"ignore", "pipe", "pipe">;
    try {
      process = Bun.spawn(["git", ...args], {
        cwd,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch {
      return "";
    }

    const exitEffect = Effect.tryPromise(() => process.exited).pipe(Effect.catch(() => Effect.succeed(undefined)));
    const [stdout, , exitCode] = yield* Effect.all([readText(process.stdout), readText(process.stderr), exitEffect], {
      concurrency: "unbounded",
    });
    if (!(options.allowedExitCodes ?? [0]).includes(exitCode ?? -1)) return "";
    return stdout;
  });
}

function splitNulList(value: string): string[] {
  return value.split("\0").filter(Boolean);
}

function untrackedPatch(cwd: string, file: string): Effect.Effect<string> {
  return gitText(
    cwd,
    [
      "diff",
      "--no-index",
      "--no-ext-diff",
      "--unified=12",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "--",
      "/dev/null",
      file,
    ],
    { allowedExitCodes: [0, 1] },
  );
}

export function getWorkingTreeDiff(cwd: string): Effect.Effect<DiffFile[]> {
  return Effect.gen(function* () {
    const [trackedDiff, untrackedOutput] = yield* Effect.all(
      [
        gitText(cwd, ["diff", "--no-ext-diff", "--unified=12", "--src-prefix=a/", "--dst-prefix=b/"]),
        gitText(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]),
      ],
      { concurrency: "unbounded" },
    );
    const untrackedPatches = yield* Effect.all(
      splitNulList(untrackedOutput).map((file) => untrackedPatch(cwd, file)),
      { concurrency: "unbounded" },
    );
    return parseUnifiedDiff([trackedDiff, ...untrackedPatches].filter(Boolean).join("\n"));
  });
}
