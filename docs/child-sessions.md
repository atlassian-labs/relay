# Child Sessions and Live Collaboration

Relay supports two child-session entry points: agent-driven delegation through the live-session control plane, and the user-driven `/handoff` command in the TUI. This document covers both; `/handoff` is a client-side focused-thread feature, not agent-driven delegation.

A child is a normal Relay thread with its own agent session, not a background tool call. Sessions have one of two roles: a parent can create children, while a child cannot create additional sessions. The feature is available while the Relay TUI or web dashboard that owns the parent session is running.

For the underlying handoff protocol and orchestration internals, see [Agent handoff orchestration](agent-handoff.md).

## TUI child-session controls

From an active TUI thread, use `/handoff <goal>` to create a focused child. Relay uses a temporary ACP fork to prepare an opening prompt from the current conversation and goal, then starts a linked child without switching away from the parent. The child has an independent transcript and uses the parent's agent/session configuration and working directory; handoff does not expose the delegated-child worktree or history options.

Use `/children` to list direct children, their goal/title/name, and status. The status line also summarizes child counts and states. Select a child from the picker to open it. `/resume` projects parent/child links into its session hierarchy; the `L ` marker is visual, not a hierarchy keybinding. From a child, `ctrl+p` returns to the parent and opens its child picker.

Handoff completion updates the child's terminal status and result preview. It does not switch the active TUI thread or merge the child transcript; completion is available through Relay's parent inbox/continuation behavior and the child can be opened directly for its full response. Ordinary delegated children instead originate from the agent/control-plane workflow and support its task-type, worktree/history, and mailbox/steer/turn options.

## Configure task types and reminder keywords

Configure task types so Relay can recognize prompts that are good candidates for delegation. A task type defines:

- A description that helps the agent choose the right type for a child.
- One or more keywords or phrases that trigger the parent orchestration reminder.
- Optional agent, model, and thinking-level defaults for children started with that type.

For example:

```sh
relay task-type set review \
  --description "Focused code, security, or correctness review with findings reported to the parent" \
  --keyword "code review" \
  --keyword "security review" \
  --keyword "review these changes" \
  --thinking-level high

relay task-type set investigation \
  --description "Read-only investigation of an isolated question; report evidence and recommended next steps" \
  --keyword "investigate" \
  --keyword "root cause" \
  --keyword "trace the issue" \
  --thinking-level high

relay task-type set tests \
  --description "Implement or analyze tests in files that do not overlap with the parent session" \
  --keyword "add tests" \
  --keyword "test coverage" \
  --thinking-level medium
```

Select any built-in or configured Relay agent when a task should use a different runner, and use a model advertised by that agent when needed:

```sh
relay task-type set docs \
  --description "Write or review documentation without changing implementation files" \
  --keyword "write documentation" \
  --keyword "update the docs" \
  --agent <agent-name> \
  --model <model-id>
```

Agent, model, and thinking level are all optional. A task type with none of them is still useful for keyword reminders and task classification. Any configured value must be supported by the selected ACP agent when a child is started.

Manage the configured types with:

```sh
relay task-type list
relay task-type list --json
relay task-type remove tests
```

The commands write to `~/.config/relay/config.toml`. The equivalent TOML is:

```toml
[task_types.review]
description = "Focused code, security, or correctness review with findings reported to the parent"
keywords = ["code review", "security review", "review these changes"]
thinking_level = "high"

[task_types.docs]
description = "Write or review documentation without changing implementation files"
keywords = ["write documentation", "update the docs"]
agent = "<agent-name>"
model = "<model-id>"
```

### How keyword reminders work

Relay normalizes case and punctuation, then matches complete words or word sequences. For example, `security review` matches `Perform a security-review`, while `plan` does not match `planetary`. Prefer specific phrases such as `review these changes` over broad words such as `review` if you do not want the reminder on unrelated prompts.

When a parent prompt matches at least one configured keyword, Relay injects the root orchestration reminder. Relay also injects it when the prompt explicitly requests Relay child sessions or control-plane orchestration, including `relay start session`, even if no task type keyword matches. The reminder contains the current session identity, instructions for bounded delegation, and all matching task types. It makes delegation optional, prohibits duplicate parent/child work, and directs a blocked parent to end its turn for automatic delivery or use a bounded wait rather than poll. Other non-matching parent prompts do not receive it. Child sessions do not receive orchestration system reminders; Relay publishes their terminal response automatically.

The task type used by `relay start session --task-type` supplies agent, model, and thinking-level defaults. Explicit `--agent`, `--model`, or `--thinking-level` options on `start session` override those defaults.

When no agent is selected, the child inherits its parent's agent. When the inherited agent is unchanged, omitted model and thinking-level settings inherit the parent's current session values. If a different agent is selected, omitted model and thinking level use that agent's defaults because model and reasoning options are agent-specific.

To customize the reminder, create `~/.config/relay/prompts/child-session-collaboration.md`. It supports these placeholders:

- `{{session_json}}`: the current session name, `role: "parent"`, and a null parent identity.
- `{{matched_task_types_json}}`: matching task types, settings, and keywords.

Copy the current built-in template when customizing it and retain its `<child_session_collaboration version="5">` declaration. Overrides that declare an older version are ignored so obsolete orchestration rules cannot silently replace current lifecycle semantics. An empty override still disables the collaboration reminder. See [Relay Configuration](configuration.md#prompt-overrides) for prompt override behavior.

## Start a child session

From an agent running in a Relay-managed session:

```sh
relay start session \
  "Review the authentication changes. Do not edit files. Return prioritized findings in your final response." \
  --name review-otter \
  --task-type review
```

Relay automatically treats the current parent session as the parent. A child session is rejected if it attempts to start another session, including when it supplies `--parent` to target a different session. When running the command from an ordinary shell instead, identify a live parent explicitly:

```sh
relay start session "Investigate the failing parser tests" \
  --name trace-raven \
  --parent build-beacon \
  --task-type investigation

# Direct overrides take precedence over the task type and parent.
relay start session "Review the protocol boundary" \
  --name review-raven \
  --agent <agent-name> \
  --model <model-id>
```

Session names must be short, unique two-part names such as `review-otter`. A child is created without switching the parent's active thread, so the parent can keep working. A parent may have at most three non-terminal children; wait for or cancel existing work before admitting more.

### Context and workspace options

By default, the child receives only its task. Add the smallest useful amount of sanitized parent conversation history when the task is not self-contained:

```sh
# No parent history; this is the default and usually the most reliable option.
relay start session "Review src/auth.ts" --name review-otter --history none

# Include the latest two parent turns.
relay start session "Continue the API investigation" --name trace-raven --history recent:2

# Include all available parent turns, up to Relay's context-size limit.
relay start session "Summarize the full discussion" --name map-heron --history all
```

Thinking blocks, tool details, interrupted output, and an unfinished parent response are not copied as completed assistant history. Prefer a precise task over large inherited history.

Parent and child share the same working directory by default. Their edits are immediately visible to each other, so assign non-overlapping files or make one task read-only. Use `--worktree` for isolated edits:

```sh
relay start session "Implement the parser refactor and report the commit" \
  --name fix-willow \
  --worktree
```

Worktree changes are not merged automatically; the parent must inspect and integrate them explicitly.

## Inspect live sessions

List sessions across running Relay instances to discover names and basic state:

```sh
relay list sessions
relay list sessions --json
```

The table includes each session's short name, activity (`connecting`, `running`, or `idle`), parent/child role, relation, title, and working directory. JSON output also includes identifiers, role, parent relation, task status, selected task type, model, thinking level, and latest result metadata when available.

Use the short session name for subsequent commands. If the same name is active in multiple Relay instances, Relay rejects the ambiguous target.

## Inspect child progress

A parent can request a sanitized snapshot of a direct child's recent conversation turns:

```sh
relay inspect session review-otter --history recent:3
relay inspect session review-otter --history recent:3 --json
```

The default is `recent:3`. The selector has the same `none`, `all`, and `recent:N` forms used when starting a child. Inspection reuses the child-context sanitizer: it includes user prompts, steering updates, and finalized assistant responses while excluding thinking, tool, info, plugin, and bash blocks. An active turn does not expose unfinished assistant output. Relay limits the sanitized result to 64 KiB; request fewer turns if the result is too large.

Parent agents may inspect only themselves and their direct children. A user running the command from an ordinary shell may inspect any session owned by the local Relay instance. Prefer occasional snapshots over continuous polling.

Relay delivers a direct child's terminal result automatically. When the result must arrive inside the current active turn, wait for the child to reach `done`, `failed`, or `interrupted` without polling:

```sh
relay wait review-otter
relay wait review-otter --timeout 12 --json
relay wait # wait for whichever direct child completes next
```

Waits default to 45 seconds and are bounded to 10–120 seconds. Allow at least 60 seconds in the enclosing shell tool for the default wait so Relay can return its normal timeout result before the shell wrapper expires. A timeout is a normal result and does not cancel the child. Cancel a running direct child explicitly with:

```sh
relay cancel review-otter
```

Cancellation is idempotent and records the child as interrupted.

## Send messages in both directions

Parents can message their direct children and other parent sessions. Children can message only their own parent; child-to-child messages and access to another parent's children are rejected.

```sh
relay message review-otter "Also check whether token refresh is covered"
relay message build-beacon "Review complete: two high-priority findings in src/auth.ts"
```

Relay labels agent-to-agent messages with their source, for example `[parent: build-beacon]`, `[child: review-otter]`, or `[peer: plan-heron]`, so the receiving agent knows who sent them.

Delivery modes are:

- Default (`mailbox`): store the message in the collaboration inbox without starting a turn. Direct parent-child messages also steer an active recipient immediately, and child events wake `relay wait`; parent-peer messages remain pending until the recipient's next natural turn.
- `--steer`: require delivery into the active turn. The command fails if the target is idle or cannot accept steering.
- `--turn`: explicitly create or queue a separate follow-up turn.

```sh
relay message review-otter "Save this for your next turn"
relay message review-otter "Stop editing; return findings only" --steer
relay message review-otter "After the review, summarize suggested tests" --turn
printf '%s\n' "Long message from stdin" | relay message review-otter -
```

Add `--json` for machine-readable delivery results. Relay rejects messages sent to the sender's own session.

A child's terminal state and complete final response are captured automatically. If the parent is active and supports steering, Relay delivers the result into that turn immediately. If the parent is idle, Relay starts a dedicated continuation; if steering is unavailable or rejected, Relay queues that continuation after the active turn. An explicit `relay wait` keeps its acknowledgement handshake: Relay injects the full response exactly once in the next continuation, and the parent should end the acknowledged turn with only `Awaiting Relay continuation.` A child should use `relay message <parent-name> ...` only for clarification, blockers, or an explicitly requested intermediate update. List and inspection remain diagnostic operations rather than progress polling mechanisms.

## Recommended workflow

1. Define a small set of task types for repeatable, independent work such as review, investigation, tests, and documentation.
2. Choose specific keywords that reflect prompts where parallelism is genuinely useful.
3. When the root reminder appears, split only bounded work with clear ownership and little coordination cost.
4. Give the child a self-contained task, constraints, and expected deliverable.
5. Do not perform delegated work yourself. Continue only useful, explicitly non-overlapping parent work.
6. Continue independent work or end the parent turn and let Relay deliver the result automatically. Use `relay wait` only when the current active turn must remain blocked for it; do not shell-loop over list or inspect.
7. Send clarification with `--steer`, a mailbox update by default, or an explicit follow-up with `--turn`.
8. Integrate and verify the terminal result before answering the user.

Avoid creating children for tiny sequential steps, assigning overlapping edits in a shared workspace, passing all history by default, or assuming a completed child automatically messages or merges its work.
