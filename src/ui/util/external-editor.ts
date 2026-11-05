/**
 * Open the prompt buffer in an external editor (vim, nano, $EDITOR, ...).
 *
 * Mirrors the F2 "open in editor" affordance from the acra-python rovo dev TUI
 * (see packages/cli-rovodev/src/rovodev/ui/components/chat_input_prompt.py).
 *
 * The caller is responsible for suspending the OpenTUI renderer before invoking
 * `openTextInExternalEditor` and resuming it afterwards. This module only
 * handles the temp-file write, child process spawn, and read-back.
 */
// effect-shape-allow: external editor uses node:child_process and node:fs directly.
import { spawn } from "node:child_process";
// effect-shape-allow: external editor uses node:fs directly for temp file handoff.
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  // effect-shape-allow: external editor uses node:fs directly for temp file handoff.
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ExternalEditorOptions {
  /** Initial text to seed the temp file with. */
  text: string;
  /** Optional override of the editor command. Falls back to $VISUAL, $EDITOR, then `vi`. */
  editorCommand?: string;
  /** Suffix for the temp file. Defaults to `.md` so editors enable markdown highlighting. */
  fileSuffix?: string;
}

export interface ExternalEditorResult {
  /** Final text after the editor exits (whitespace-trimmed at end). */
  text: string;
  /** True when the file mtime changed (the user actually saved). */
  changed: boolean;
  /** Editor process exit code, when available. */
  exitCode: number | null;
}

function resolveEditorCommand(explicit?: string): { shell: string; args: string[] } {
  // effect-shape-allow: editor selection is a platform boundary, mirrors $EDITOR semantics.
  const raw = explicit ?? process.env.VISUAL ?? process.env.EDITOR ?? "vi";
  // Editors are commonly configured as e.g. `vim -p` or `code --wait`. Honour
  // shell-style splitting on whitespace, but keep it simple: callers that need
  // fancy quoting should pass a single binary in editorCommand.
  const parts = raw.trim().split(/\s+/);
  if (parts.length === 0 || !parts[0]) return { shell: "vi", args: [] };
  return { shell: parts[0], args: parts.slice(1) };
}

interface TempHandoff {
  /** Absolute path to the temp file passed to the editor. */
  file: string;
  /** Absolute path to the temp directory wrapping the file. Must be removed on cleanup. */
  dir: string;
}

function createTempFile(suffix: string, initialText: string): TempHandoff {
  // effect-shape-allow: temp dir creation is a platform boundary for the editor handoff.
  const dir = mkdtempSync(join(tmpdir(), "relay-editor-"));
  const file = join(dir, `prompt${suffix}`);
  // Pre-create with the initial buffer contents so editors open with the draft.
  writeFileSync(file, initialText, { encoding: "utf-8" });
  return { file, dir };
}

function tryCleanup(handoff: TempHandoff): void {
  // Unlink the file first so even partial cleanup leaves no draft text on disk.
  try {
    if (existsSync(handoff.file)) unlinkSync(handoff.file);
  } catch {
    // Best-effort cleanup; ignore.
  }
  // Then remove the wrapping directory. rmSync with recursive=true tolerates
  // editors that drop swap files or backups (vim's .prompt.md.swp, etc.) so we
  // never leak the directory itself.
  try {
    rmSync(handoff.dir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup; ignore.
  }
}

function touchFd(file: string): void {
  // Make sure the file exists even if the editor refused to write.
  try {
    const fd = openSync(file, "a");
    closeSync(fd);
  } catch {
    // ignore
  }
}

/**
 * Open the given text in the user's $EDITOR and return the saved contents.
 *
 * The OpenTUI renderer MUST be suspended before this is called so the editor
 * has exclusive access to the terminal. The returned promise resolves after the
 * editor process exits.
 */
export function openTextInExternalEditor(options: ExternalEditorOptions): Promise<ExternalEditorResult> {
  const suffix = options.fileSuffix ?? ".md";
  const handoff = createTempFile(suffix, options.text);

  const { shell, args } = resolveEditorCommand(options.editorCommand);

  // effect-shape-allow: child_process spawn bridge needs a Promise boundary for the await caller.
  return new Promise<ExternalEditorResult>((resolve) => {
    let settled = false;
    const finish = (result: ExternalEditorResult) => {
      if (settled) return;
      settled = true;
      tryCleanup(handoff);
      resolve(result);
    };

    const proc = spawn(shell, [...args, handoff.file], {
      // Inherit the controlling TTY so the editor can take over the terminal.
      stdio: "inherit",
      env: {
        // effect-shape-allow: subprocess environment forwarding for external editor.
        ...process.env,
      },
    });

    proc.on("error", () => {
      // Editor failed to launch (e.g. binary missing). Return the original text
      // untouched so the caller can keep editing in the TUI.
      finish({ text: options.text, changed: false, exitCode: null });
    });

    proc.on("close", (code) => {
      touchFd(handoff.file);
      let nextText = options.text;
      let changed = false;
      try {
        const rawText = readFileSync(handoff.file, { encoding: "utf-8" });
        if (rawText !== options.text) {
          // Trim trailing whitespace/newlines that editors like vim add by
          // default; mirrors the acra-python behaviour.
          nextText = rawText.replace(/\s+$/u, "");
          changed = nextText !== options.text;
        }
      } catch {
        // ignore
      }
      finish({ text: nextText, changed, exitCode: typeof code === "number" ? code : null });
    });
  });
}
