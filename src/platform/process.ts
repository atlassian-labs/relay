// effect-shape-allow: platform process adapter owns direct node:child_process access.
import {
  execFile,
  execFileSync,
  execSync,
  spawn,
  spawnSync,
  type ChildProcess,
  type ChildProcessByStdio,
  type ExecFileException,
} from "node:child_process";
import type { Readable, Writable } from "node:stream";

export { execFile, execFileSync, execSync, spawn, spawnSync };
export type { ChildProcess, ChildProcessByStdio, ExecFileException, Readable, Writable };
export type RelayChildProcess = ChildProcessByStdio<Writable, Readable, Readable>;
