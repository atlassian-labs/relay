export type TimerHandle = ReturnType<typeof setTimeout>;

export function nowMs(): number {
  return Date.now();
}

export function setTimer(callback: () => void, delayMs: number): TimerHandle {
  return setTimeout(callback, delayMs);
}

export function setRecurringTimer(callback: () => void, delayMs: number): TimerHandle {
  return setInterval(callback, delayMs);
}

export function nextEventLoopTurn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export function clearTimer(timer: TimerHandle): void {
  clearTimeout(timer);
}

export function isoNow(): string {
  return new Date().toISOString();
}

export function isoFromEpochMs(epochMs: number): string {
  return new Date(epochMs).toISOString();
}
