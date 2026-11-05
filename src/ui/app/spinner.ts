import { createSignal } from "solid-js";
import { SPINNER_FRAMES, SPINNER_INTERVAL_MS, spinnerFrameAt } from "../util/spinner-frames";

const SPINNER_IDLE_MS = SPINNER_INTERVAL_MS * 3;

const [spinnerFrame, setSpinnerFrame] = createSignal(0);
let spinnerTimer: ReturnType<typeof setInterval> | undefined;
let lastReadAt = 0;

function stopSpinnerAnimation(): void {
  if (spinnerTimer !== undefined) clearInterval(spinnerTimer);
  spinnerTimer = undefined;
  setSpinnerFrame(0);
}

function ensureSpinnerAnimation(): void {
  if (spinnerTimer !== undefined) return;
  spinnerTimer = setInterval(() => {
    if (Date.now() - lastReadAt > SPINNER_IDLE_MS) {
      stopSpinnerAnimation();
      return;
    }
    setSpinnerFrame((frame) => (frame + 1) % SPINNER_FRAMES.length);
  }, SPINNER_INTERVAL_MS);
  spinnerTimer.unref?.();
}

/**
 * Starts animation only while a reactive consumer is reading spinner frames.
 * Once every visible spinner unsubscribes, the unreferenced timer tears itself
 * down instead of waking the process throughout an idle TUI session.
 */
export function getSpinnerChar(): string {
  lastReadAt = Date.now();
  ensureSpinnerAnimation();
  return spinnerFrameAt(spinnerFrame());
}
