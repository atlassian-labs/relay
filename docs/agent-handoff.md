# Agent handoff orchestration

This document describes the ACP-backed child-thread handoff system. It covers the machine-readable handoff protocol emitted by an agent, the Relay orchestration state machine, child session creation, and parent/child communication. For using child sessions and `/handoff`, see [Child Sessions and Live Collaboration](child-sessions.md).

## Scope and terminology

Relay remains an ACP client. It does not run a local agent or local tool layer. A handoff creates another Relay thread and connects that thread to an ACP session. The session may be a fork of the parent session or a new session with sanitized/generated context.

There are two related but distinct workflows:

- **Native user handoff:** the existing `/handoff <goal>` slash command. Relay forks a scratch session, asks the agent to generate an opening prompt, deletes/closes the scratch session, and creates a new user-visible thread.
- **Agent handoff orchestration:** an assistant emits `/handoff` followed by one JSON object. Relay parses and executes the command, creates a first-class child relation, and routes lifecycle messages between the child and its parent.

Both workflows use the persistent handoff-link UI so related sessions can be opened from either transcript.

## End-to-end flow

1. An ACP turn finishes in `submit-controller.ts`.
2. `app-root.tsx` forwards the `CompletedAssistantTurn` to `agent-handoff-controller.ts`.
3. The controller parses the complete assistant text with `parseHandoffAssistantResponse`.
   - Ordinary assistant text is passed to `orchestrator.completeTurn` so a child's ordinary answer completes its child run.
   - Invalid `/handoff` text produces a warning and a structured failure response.
   - A valid command is executed by `handoff-orchestrator.ts`.
4. The operation result is persisted and, unless the operation is a waiting or `complete` operation, delivered back to the originating thread as a `system-reminder: Relay handoff response ...` turn.
5. Child completion, wait resolution, and restart recovery are delivered as system-reminder turns or queued messages through the same prompt-submission path.

The orchestration controller uses the normal thread/session controllers for ACP clients, transcript blocks, prompt queues, permissions, notifications, and status updates. It does not bypass ACP to execute work itself.

## Assistant protocol

The protocol prefix must be the complete trimmed assistant response prefix, followed by one JSON object:

```text
/handoff
{"version":1,"request_id":"auth-review-1","op":"create","instructions":"Review the authentication flow","fork_turns":"3"}
```

`version` is optional when parsing for compatibility; new commands should send `1`. `request_id` is required and must match `[A-Za-z0-9][A-Za-z0-9._:-]{0,63}`. The parser rejects unknown fields, duplicate top-level fields, malformed JSON, oversized payloads, and text that is not exactly a `/handoff` command. Multiline commands are accepted.

### Operations

| Operation   | Meaning                                                                                         |
| ----------- | ----------------------------------------------------------------------------------------------- |
| `create`    | Create a direct child, optionally start its opening turn, and return its child/thread metadata. |
| `start`     | Start a previously created child whose `create` used `start:false`.                             |
| `list`      | List direct children of the current thread.                                                     |
| `status`    | Return status for all or selected direct children.                                              |
| `send`      | Send guidance into a currently running direct child, or from a child to its parent.             |
| `followup`  | Queue or submit another turn to a direct child, or send a follow-up turn to the parent.         |
| `wait`      | Wait for selected direct children to reach terminal states.                                     |
| `interrupt` | Cancel a direct child and mark it interrupted.                                                  |
| `complete`  | Explicitly report a child result to its parent.                                                 |

`send` and `followup` address `target` using a direct child ID. A child may use `target:"parent"` to address its immediate parent. Sibling, ancestor, and unrelated-thread addressing is rejected.

### Create options

```json
{
  "version": 1,
  "request_id": "spawn-auth-review",
  "op": "create",
  "name": "Auth review",
  "instructions": "Inspect authentication and report concrete issues.",
  "agent": "alta",
  "model": "fast",
  "thinking_level": "medium",
  "mode": "code",
  "fork_turns": "3",
  "workspace": "worktree",
  "start": true,
  "notify": true,
  "yoloo": false
}
```

- `instructions` is the authoritative child task.
- `agent`, `model`, `thinking_level`, and `mode` are stored on the child thread. Explicit model/thinking selections are strict: if the selected agent does not advertise or accept them, child startup fails rather than silently falling back.
- `workspace` defaults to `inherit`; `worktree` creates a managed Relay worktree for the child.
- `start` defaults to `true`. `notify` defaults to `true` and controls parent completion notifications.
- `yoloo:true` requests task-scoped automatic permission approval for the opening turn. It is only accepted when Relay can find an explicit user authorization in the originating thread.

`fork_turns` controls inherited context:

| Value                   | Context behavior                                                                                                                    |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| omitted / `all`         | Fork the parent ACP session with `session/fork`; the child must use the parent agent. The forked session becomes the child session. |
| `none`                  | Create an independent child ACP session with only the instructions.                                                                 |
| positive integer string | Create an independent session with the last N eligible parent turns serialized as sanitized context.                                |

The legacy `context` field remains accepted as an alias: `exact` maps to `none`, `fork` maps to `all`, and `summary` maps to generated summary context. `fork_turns` and `context` cannot be combined.

For `fork_turns` as a positive integer, Relay selects completed user/assistant turns from provider-neutral transcript blocks. It excludes thinking, tool blocks, orchestration receipts, handoff commands, unfinished turns, and interrupted turns. Current-turn guidance is folded into its user turn. The resulting prompt is wrapped in `<relay_parent_context version="1">` and followed by an authoritative `<relay_child_task>` section. The selected context is capped at 64 KiB.

For legacy `summary`, Relay forks a scratch session, runs the existing handoff-summary prompt through ACP, captures only the agent message, then deletes or closes the scratch session. The generated prompt is used to open a new independent child session.

## Child creation and session lifecycle

`agent-handoff-controller.ts` adapts the protocol command to Relay's thread APIs:

1. Ensure the origin thread has an ACP session.
2. Resolve the opening prompt and context mode.
3. Create a non-selected child thread with the parent cwd, optional worktree, selected agent, and session preferences.
4. For `all`, pass the ACP fork session ID into the child thread. For other modes, create a new ACP session when the child is first started.
5. Persist a handoff link containing source/target thread IDs, session IDs, cwd, goal, agent, and a source user-message anchor.
6. Persist a `HandoffChildRecord` and start or queue the opening turn.

Thread startup is per-thread. `thread-controller.ts` resolves the configured agent for the child and builds ACP client options for that agent. For newly created sessions it applies the child's model, thinking level, and mode; an ACP-forked session retains the configuration supplied by the fork. Thread records persist these fields so a child can be restored and started with the same ACP configuration when a new session is created.

The default orchestration limits are:

- four active children globally;
- eight direct children per parent;
- maximum nesting depth two.

When a target thread is already running, or the active-child limit is reached, opening and follow-up messages are stored as pending messages. They drain when the target is idle and an active slot is available. Child threads are independently selectable and appear in the normal thread tree.

## Communication semantics

### Operation receipts

Most successful or failed operations produce a result such as:

```text
system-reminder: Relay handoff response {"version":1,"request_id":"...","op":"send","ok":true,...}
```

If the origin thread is running, the receipt is persisted as a pending message instead of interrupting the current turn. Otherwise Relay submits it as a new orchestration turn. System-reminder turns suppress the normal local user echo and are excluded from recent-context selection.

Operation records are keyed by `(originThreadId, request_id)`:

- repeating the same request with the same canonical command returns the original result without repeating side effects;
- reusing the request ID with a different payload returns `request_id_conflict`;
- an existing request without a stored result is reported as indeterminate.

### `send` versus `followup`

- `send` requires the target ACP thread to be running. It calls ACP active-turn input and renders an in-transcript user block with `delivery:"current-turn-guidance"`.
- `followup` represents a new turn. It submits immediately when the target is idle or queues a pending message when the target is running or capacity is exhausted.
- A follow-up to `parent` follows the same queueing rules, but is only allowed for the immediate child-parent relation.

### Completion

A child can explicitly emit:

```text
/handoff {"version":1,"request_id":"done-1","op":"complete","status":"success","result":"Found two issues."}
```

This marks the child `completed` or `failed`, stores `latestResult`, disables task-scoped yoloo, notifies the parent when `notify` is enabled, resolves satisfied waits, and drains pending work. The `complete` operation itself does not receive a separate operation receipt; its parent notification is the result path.

If a child finishes an ordinary assistant turn instead, `completeTurn` derives the result from the full assistant text and marks it terminal using the ACP outcome (`completed`, `failed`, or `interrupted`). This makes ordinary child answers complete without requiring a final protocol command. A turn that emits another valid handoff command remains under orchestration control rather than being auto-completed.

Parent notifications use a system-reminder event:

```text
system-reminder: Relay child event {"version":1,"event":"child_completion","child_id":"...","status":"completed","result":"..."}
```

### Waiting and interruption

`wait` defaults to all direct children and defaults to `condition:"all"`; `condition:"any"` resolves when any selected child is terminal. A wait defaults to 30 seconds at orchestration time, while the parser permits a caller-supplied timeout up to five minutes. An unresolved wait returns an accepted `status:"waiting"` result. Satisfaction or timeout later delivers the final child summaries.

`interrupt` only accepts a direct child ID. Relay calls ACP cancellation, marks the child `interrupted`, disables its task-scoped yoloo, and notifies the parent. `scope:"all"` additionally removes queued messages for that child; the default turn scope only cancels the current turn.

## Persistence and restart recovery

The orchestration store is atomically written to:

```text
~/.config/relay/handoffs/orchestration.json
```

It contains versioned arrays of:

- child records and their parent/child thread relation;
- idempotent operation records;
- pending follow-up, receipt, and completion messages;
- active wait records.

The store normalizes older `exact`/`fork` context values to `none`/`all`. Handoff links are stored separately at `~/.config/relay/handoffs/links.json`, while thread/session metadata remains in the existing workspace thread store.

After the initial Relay thread is connected, `restore()`:

1. imports handoff links that predate orchestration as synthetic completed child records;
2. marks persisted `starting` or `running` children as `interrupted` with `Relay restarted during the child turn`;
3. notifies their parents when configured;
4. re-arms persisted wait timers and resolves waits that are already satisfied;
5. drains pending messages that can run immediately.

Running ACP clients are not assumed to survive a Relay restart. The persisted state therefore favors an explicit `interrupted`/`indeterminate` outcome over silently replaying work.

## Safety and task-scoped yoloo

`yoloo` is not inherited implicitly. A create or follow-up request must explicitly set `yoloo:true`, and Relay checks the latest meaningful user message for an explicit request such as `yoloo`, `auto-approve`, or permission-free wording. Otherwise the operation is rejected before a turn is submitted.

When authorized, Relay records a run ID in `threadHandoffYoloRuns`. The permission callback uses that set for the target thread, and the run is removed on normal completion, explicit completion, interruption, or child cleanup. The warning block shown in the child transcript makes the temporary policy visible. This is separate from the persistent `/yoloo` launch/thread setting.

## Main implementation map

- `src/core/handoff-protocol.ts` — wire format, validation, context normalization, canonical command hashing.
- `src/core/handoff-orchestration.ts` — persisted domain records, status/relationship helpers, wait predicates.
- `src/application/handoff-orchestrator.ts` — idempotent command execution, limits, queueing, receipts, notifications, waits, completion, and restore.
- `src/ui/app/agent-handoff-controller.ts` — ACP/thread adapter, child creation, context prompt construction, response handling, and manual-link reconciliation.
- `src/ui/app/handoff-context.ts` — recent-turn sanitization and bounded child opening prompts.
- `src/platform/handoff-orchestration-store.ts` — atomic file persistence and legacy normalization.
- `src/ui/app/thread-controller.ts` — per-thread ACP agent selection, client startup, session preferences, and child transcript adapters.
- `src/ui/app/submit-controller.ts` — completion callback and orchestration prompt source/queue integration.
- `src/core/handoffs.ts`, `src/ui/app/handoff.ts`, and chat rendering — persistent links and clickable source/target transcript navigation.

Focused coverage lives in `test/core/handoff-protocol.test.ts`, `test/application/handoff-orchestrator.test.ts`, `test/platform/handoff-orchestration-store.test.ts`, and `test/ui/app/handoff-context.test.ts`.

## Native user handoff

Relay handoff is a **client-side TUI feature**. The user invokes it to start a focused child thread from the current conversation. It uses Relay's child-session and live-session infrastructure, but it is not an agent-facing orchestration workflow: the agent does not decide to delegate the work or invoke handoff on the user's behalf.

## Start a handoff

In an active TUI thread, enter:

```text
/handoff <new thread goal>
```

For example:

```text
/handoff update the authentication documentation without changing code
```

The parent turn must be idle. If the goal is missing, there is no active thread/session, or the ACP agent does not support `session/fork`, Relay reports a warning or error instead of creating the child.

## What Relay does

When the command is accepted, Relay:

1. Temporarily forks the current ACP session.
2. Uses that temporary session to draft an exact opening prompt for the new goal, based on relevant current-conversation context.
3. Deletes the temporary session when supported, or closes it as a fallback.
4. Creates a separate child thread with the generated opening prompt and starts its ACP turn.

The new thread is a normal independently resumable Relay thread. It is linked to the source with a `handoff` relationship and retains the goal for display in the child picker. Handoff-created children use the parent's agent/session configuration and working directory; the current implementation does not provide a handoff-specific worktree or history option.

The source thread remains selected and usable. Starting a handoff does not switch the TUI to the child, and the child does not replace or merge the source transcript. Relay shows a short `Handoff started` notification after the child has been submitted.

The temporary ACP fork is used only to prepare the opening prompt. This is different from agent-driven delegation through Relay's live-session control plane. Mailbox, steer, and turn delivery, as well as `relay wait`, `relay cancel`, and `relay inspect session`, are separate control-plane interfaces and are not required to invoke or use `/handoff` from the TUI.

## Monitor and open the child

From the parent thread:

- `/children` opens a picker of direct child threads. Each entry shows the handoff goal when available, the child title, its Relay name/ID, and its status.
- The status line summarizes direct children as `starting`, `running`, `done`, `failed`, `interrupted`, or `idle`, and includes `/children` as the way to view them.
- Select a child in the picker to make its thread active and read its independent transcript.

When a child finishes, Relay records its terminal status and latest result preview on the child relationship. A completion event is also kept in the parent's collaboration inbox for a later parent turn or continuation; the TUI does not automatically switch threads or treat the child response as the handoff itself.

## Resume and navigate

`/resume` lists resumable ACP sessions when the active agent supports the required session capabilities. Native parent/child links are projected into that picker, so linked sessions can appear as an indented hierarchy with an `L ` visual prefix. This is display-only; there is no separate `L` hierarchy keybinding.

From an active child thread, `ctrl+p` returns to its parent and opens the parent's child picker. `/threads` can also be used to open the thread sidebar and select another Relay thread.

## Handoff versus an ordinary child

Both forms create ordinary Relay child threads with independent ACP sessions and transcripts. The difference is how they are started:

- `/handoff` is user-driven TUI context transfer. Relay asks a temporary ACP fork to produce a focused opening prompt from the current conversation, then starts the child without changing the active parent thread.
- An ordinary delegated child is created through the separate live-session orchestration workflow, such as an agent or control-plane caller using `relay start session`. That workflow can use task types, explicit history/worktree options, and mailbox/steer/turn coordination.

Handoff should therefore be understood as a TUI command for opening a focused new thread, not as an agent orchestration or delegation protocol.
