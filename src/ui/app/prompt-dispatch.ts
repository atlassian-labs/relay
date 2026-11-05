export type PromptDispatchReservation = symbol;

const promptDispatchReservationsByThreadId = new Map<string, PromptDispatchReservation>();
let queueIdCounter = 0;

export function nextQueueId(): string {
  queueIdCounter += 1;
  return `queue-${queueIdCounter}`;
}

export function reservePromptDispatch(threadId: string): PromptDispatchReservation | null {
  if (promptDispatchReservationsByThreadId.has(threadId)) return null;
  const reservation = Symbol(threadId);
  promptDispatchReservationsByThreadId.set(threadId, reservation);
  return reservation;
}

export function releasePromptDispatch(threadId: string, reservation: PromptDispatchReservation): void {
  if (promptDispatchReservationsByThreadId.get(threadId) === reservation) {
    promptDispatchReservationsByThreadId.delete(threadId);
  }
}

export function releaseCurrentPromptDispatch(threadId: string): void {
  promptDispatchReservationsByThreadId.delete(threadId);
}

export function isPromptDispatchReserved(threadId: string): boolean {
  return promptDispatchReservationsByThreadId.has(threadId);
}

export function resetPromptDispatchState(): void {
  promptDispatchReservationsByThreadId.clear();
  queueIdCounter = 0;
}
