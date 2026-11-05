import type { useApp } from "../state";

type TurnTimerApp = Pick<ReturnType<typeof useApp>, "setState">;

let turnStartedAt: number | null = null;
// effect-shape-allow: legacy turn elapsed timer handle is disposed by stopTurnTimer.
let elapsedTimer: ReturnType<typeof setInterval> | null = null;

export function startTurnTimer(app: TurnTimerApp): void {
  stopTurnTimer();
  // effect-shape-allow: turn timing remains a UI status display until the app shell moves to Effect Clock.
  turnStartedAt = Date.now();
  app.setState("generationSeconds", 0);
  app.setState("elapsedSeconds", 0);
  // effect-shape-allow: legacy turn elapsed UI timer is disposed by stopTurnTimer.
  elapsedTimer = setInterval(() => {
    if (turnStartedAt === null) return;
    // effect-shape-allow: turn timing remains a UI status display until the app shell moves to Effect Clock.
    const elapsed = (Date.now() - turnStartedAt) / 1000;
    app.setState("generationSeconds", elapsed);
    app.setState("elapsedSeconds", elapsed);
  }, 250);
}

export function finishTurnTimer(app: TurnTimerApp): void {
  if (turnStartedAt !== null) {
    // effect-shape-allow: turn timing remains a UI status display until the app shell moves to Effect Clock.
    const elapsed = (Date.now() - turnStartedAt) / 1000;
    app.setState("generationSeconds", elapsed);
    app.setState("elapsedSeconds", elapsed);
  }
  stopTurnTimer();
}

export function stopTurnTimer(): void {
  if (elapsedTimer) {
    clearInterval(elapsedTimer);
    elapsedTimer = null;
  }
  turnStartedAt = null;
}
