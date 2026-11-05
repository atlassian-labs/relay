# Chat Log Benchmark Agent Guidance

This directory contains a measurement harness for Relay's chat-log UI. Read `README.md` before changing its behavior or structure.

## Preserve the Process Boundary

Keep dependencies directed toward `protocol/`:

- `protocol/` must not import from `parent/`, `child/`, or `test/`.
- `parent/` must not import child implementation modules. It must start the child entrypoint as a fresh process.
- `child/` must not import from `parent/`.
- The public `index.ts` may depend on parent orchestration and protocol options, not child implementation modules.
- Tests may import benchmark modules; executable benchmark code must not depend on test-owned helpers.

`test/perf/chat-log-benchmark/dependency-direction.test.ts` enforces the parent, child, and protocol edges. Keep executable-to-test ownership pointed in the correct direction during review. Update the ownership model deliberately rather than weakening the test to permit a convenient cross-boundary import.

## Preserve Measurement Fidelity

Treat measurement ordering and lifecycle cleanup as behavior, not incidental implementation detail.

- Keep primary timing samples free from renderable prototype instrumentation. Diagnostic instrumentation belongs in its separate scenario pass.
- Keep each parent run in a fresh child process so CPU and RSS measurements retain their current isolation.
- Preserve renderer pause, start, idle, listener removal, destroy, fixture cleanup, and Relay config reset paths.
- Keep deterministic fixture construction in `child/scenario/fixtures.ts`.
- Keep renderer and input measurement mechanics in `child/scenario/renderer-measurements.ts`.
- Keep multi-process aggregation and metadata construction in `parent/`.

Do not move work across a measured boundary without checking whether the change alters what a timer, CPU interval, or RSS sample includes.

## Preserve the Wire Contract

Child stdout is a process-boundary protocol. Do not replace strict parsing with a TypeScript assertion.

When changing a serialized child result:

1. Update the types in `protocol/result.ts`.
2. Update strict runtime validation in `protocol/parse-run-result.ts`.
3. Update the output contract coverage under `test/perf/chat-log-benchmark/`.
4. Decide explicitly whether `BENCHMARK_SCHEMA_VERSION` should change.
5. Compare before-and-after JSON structure when the intended change is only organizational.

Keep progress and diagnostic messages on stderr. Stdout must remain valid JSON when the parent has not supplied `--output`.

## Options and Scenarios

The public command is `bun run bench:chat-log`. Keep `package.json`, `protocol/options.ts`, and the README consistent when changing public flags or invocation paths.

The child entrypoint is internal. Parent-only controls must not leak into child options, and child-only controls must not become public parent options. Preserve focused tests for parent-to-child argument and environment translation.

Register scenario identifiers and shared scenario DTOs in `protocol/scenario.ts`. Build scenario data in `child/scenario/fixtures.ts`. Do not duplicate the current scenario list in documentation; direct readers to `bun run bench:chat-log --help`.

## Verification

Run the changed test file while iterating. Before completing a benchmark change, run:

```bash
bun test test/perf/chat-log-benchmark test/perf/chat-log-fixtures.test.ts
bun run bench:chat-log --quick --output /tmp/chat-log-benchmark.json
bun run check
```

For a behavior-preserving refactor, compare the child and parent JSON key structure and stable fields against a pre-change run. Do not compare timing values for equality.

Keep generated benchmark output outside the repository unless a task explicitly requires a checked-in fixture or artifact.
