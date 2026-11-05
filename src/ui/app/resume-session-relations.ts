import { threadSessionRelations, type ThreadInfo } from "../../core/threads";
import type { ResumeSessionRelation } from "./resume-hierarchy";

/** Native parent/child relationships projected onto provider ACP session IDs. */
export function nativeChildSessionRelations(threads: readonly ThreadInfo[]): ResumeSessionRelation[] {
  return threadSessionRelations(threads);
}
