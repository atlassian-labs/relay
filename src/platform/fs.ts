// effect-shape-allow: platform filesystem adapter owns direct node:fs access.
import {
  appendFileSync,
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
  rmSync,
  statSync,
  unwatchFile,
  watch,
  watchFile,
  type Dirent,
  type FSWatcher,
  type Stats,
  type WriteStream,
} from "node:fs";

export {
  appendFileSync,
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
  rmSync,
  statSync,
  unwatchFile,
  watch,
  watchFile,
};
export type { Dirent, FSWatcher, Stats, WriteStream };
