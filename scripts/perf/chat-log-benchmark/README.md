# Chat Log Benchmark

This benchmark measures Relay's chat-log rendering behavior with deterministic long-session fixtures. It records mount and frame timings, input-to-frame latency, renderer diagnostics, CPU activity, retained payload sizes, renderable counts, and process RSS.

The benchmark is a comparison tool rather than a pass/fail performance test. Save its JSON output before and after a change, then compare results produced with the same options, source state, machine, and runtime environment.

## Run the Benchmark

Run commands from the repository root with the pinned Bun runtime:

```bash
bun run bench:chat-log --quick --output /tmp/chat-log-benchmark.json
```

`--quick` uses one process and reduced fixture and sample sizes. It is useful for smoke testing the harness, but it is not a substitute for the default measurement protocol.

Run the default protocol with:

```bash
bun run bench:chat-log --output /tmp/chat-log-benchmark.json
```

By default, the parent runs every registered scenario in three fresh processes. Select one or more scenarios by repeating `--scenario`:

```bash
bun run bench:chat-log \
  --scenario short-blocks-200 \
  --scenario short-blocks-2000 \
  --output /tmp/chat-log-growth.json
```

Without `--output`, the benchmark writes JSON to standard output and progress messages to standard error:

```bash
bun run bench:chat-log --quick > /tmp/chat-log-benchmark.json
```

Run the following command for the current flags, defaults, and scenario names. The option parser and scenario registry are the source of truth.

```bash
bun run bench:chat-log --help
```

## How It Works

The public entrypoint parses parent options and records the current source provenance. The parent then starts a fresh Bun process for each scenario run. Each child constructs its fixture, mounts the actual Relay chat-log UI through OpenTUI's test renderer, collects measurements, and returns one JSON result.

The parent validates every child result at the process boundary, checks that the source did not change during the run, aggregates samples across processes, adds environment metadata, and writes the final output.

Fresh child processes isolate run-level RSS and CPU measurements. Diagnostic instrumentation runs in a separate pass so that prototype instrumentation does not contaminate the primary timing samples.

## Directory Structure

The directory hierarchy expresses the allowed dependency direction:

```text
index.ts
  -> parent/
       -> protocol/
       --spawns--> child/index.tsx
                     -> child/scenario/
                          -> protocol/
```

- `protocol/` owns shared options, scenario identifiers, serialized result contracts, settings, statistics, source provenance, and child-result validation. It does not depend on parent or child implementation modules.
- `parent/` owns multi-process orchestration, child lifecycle management, metadata, and result aggregation. It refers to the child executable by path rather than importing the child implementation.
- `child/` owns Relay configuration and one measured scenario run. Its `scenario/` subtree owns deterministic fixtures, UI mounting, mutations, renderer instrumentation, and measurement collection.
- `index.ts` is the public package-script entrypoint. `child/index.tsx` is an internal subprocess entrypoint.

`test/perf/chat-log-benchmark/dependency-direction.test.ts` enforces the parent, child, and protocol import boundaries.

## Output Contract

The final JSON contains raw child runs, per-scenario summaries, growth comparisons when the required scenarios are present, source provenance, benchmark parameters, and runtime metadata.

The contract is owned by:

- `protocol/result.ts` for TypeScript result types and the output schema version.
- `protocol/parse-run-result.ts` for strict runtime validation of child results.
- `test/perf/chat-log-benchmark/assert-result-contract.ts` for the complete parent-output contract test.

Source provenance includes the commit and a hash of tracked changes. The parent passes that provenance to every child and verifies it again after all runs, preventing a benchmark from silently combining results from different source states.

## Development

Run the focused tests after changing the harness:

```bash
bun test test/perf/chat-log-benchmark test/perf/chat-log-fixtures.test.ts
```

Run a quick executable smoke test when changing entrypoints, argument forwarding, scenario execution, or output handling:

```bash
bun run bench:chat-log --quick --output /tmp/chat-log-benchmark.json
```

Before committing benchmark changes, run the repository check:

```bash
bun run check
```

When adding a scenario, register its identifier in `protocol/scenario.ts`, implement its deterministic fixture in `child/scenario/fixtures.ts`, and add focused fixture and protocol coverage. Keep measurement behavior in the child subtree and aggregation behavior in the parent subtree.
