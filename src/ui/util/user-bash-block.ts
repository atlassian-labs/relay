import { nextBlockId, type UserBashBlock } from "../state";

export function createUserBashBlock(command: string, excludeFromContext: boolean): UserBashBlock {
  return {
    type: "user-bash",
    id: nextBlockId(),
    command,
    output: "",
    exitCode: undefined,
    status: "running",
    excludeFromContext,
  };
}

export function userBashHeader(excludeFromContext: boolean): string {
  return excludeFromContext ? "[bash] local" : "[bash] context";
}

export function userBashPreview(command: string, excludeFromContext: boolean): string {
  return `${userBashHeader(excludeFromContext)} — $ ${command}`;
}

export function appendUserBashOutput(current: UserBashBlock | undefined, chunk: string): Partial<UserBashBlock> {
  return { output: `${current?.output ?? ""}${chunk}` };
}

export function finalizeUserBashBlock(
  output: string,
  exitCode: number | undefined,
  cancelled: boolean,
): Partial<UserBashBlock> {
  return {
    output,
    exitCode,
    status: cancelled ? "error" : "done",
  };
}

export * as UserBashBlockUtil from "./user-bash-block";
