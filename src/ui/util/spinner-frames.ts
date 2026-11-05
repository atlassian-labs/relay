export const SPINNER_INTERVAL_MS = 80;
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export function spinnerFrameAt(index: number): string {
  return SPINNER_FRAMES[index] ?? SPINNER_FRAMES[0];
}
