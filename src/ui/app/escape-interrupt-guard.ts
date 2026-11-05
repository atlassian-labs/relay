type PendingEscapeInterrupt = {
  readonly handle: ReturnType<typeof setTimeout>;
  readonly generation: number;
};

const ESCAPE_INTERRUPT_MOUSE_RECOVERY_WINDOW_MS = 75;

let pendingEscapeInterrupt: PendingEscapeInterrupt | null = null;
let pendingEscapeInterruptGeneration = 0;

export function cancelPendingAcpEscapeInterrupt(): void {
  if (!pendingEscapeInterrupt) return;
  pendingEscapeInterruptGeneration++;
  clearTimeout(pendingEscapeInterrupt.handle);
  pendingEscapeInterrupt = null;
}

export function scheduleAcpEscapeInterrupt(options: {
  readonly shouldInterrupt: () => boolean;
  readonly interrupt: () => Promise<boolean>;
}): void {
  cancelPendingAcpEscapeInterrupt();
  const generation = pendingEscapeInterruptGeneration;
  const handle = setTimeout(() => {
    if (pendingEscapeInterrupt?.generation !== generation) return;
    pendingEscapeInterrupt = null;
    if (!options.shouldInterrupt()) return;
    void options.interrupt().catch(() => undefined);
  }, ESCAPE_INTERRUPT_MOUSE_RECOVERY_WINDOW_MS);
  pendingEscapeInterrupt = { handle, generation };
}
