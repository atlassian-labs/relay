/**
 * Double-press Ctrl+C state machine.
 *
 * Owns the timer bookkeeping for the "press ctrl+c again to close/exit"
 * affordance so app-root's keyboard handler only decides *what* the second
 * press should do. Mirrors the other small controllers under `app/` that own
 * their own module-level state (toast, status indicators, diff overlay).
 */

import { hideStatusHint, showStatusHint } from "./status-indicators";

const DOUBLE_PRESS_THRESHOLD_MS = 2000;

let _lastCtrlCTime = 0;
let _ctrlCHintTimeout: ReturnType<typeof setTimeout> | null = null;
let _lastCtrlDTime = 0;
let _ctrlDHintTimeout: ReturnType<typeof setTimeout> | null = null;

/** True when `now` falls within the double-press window of the prior press. */
export function isCtrlCSecondPress(now: number): boolean {
  return now - _lastCtrlCTime < DOUBLE_PRESS_THRESHOLD_MS;
}

/**
 * Record a first press and show the transient hint. The hint auto-clears (and
 * the window resets) after the double-press threshold elapses.
 */
export function armCtrlCHint(now: number, suffix: string): void {
  _lastCtrlCTime = now;
  showStatusHint("ctrl+c", suffix);
  if (_ctrlCHintTimeout) clearTimeout(_ctrlCHintTimeout);
  _ctrlCHintTimeout = setTimeout(() => {
    hideStatusHint();
    _lastCtrlCTime = 0;
  }, DOUBLE_PRESS_THRESHOLD_MS);
}

/** Clear the double-press window, cancel the pending timer, and hide the hint. */
export function resetCtrlCState(): void {
  _lastCtrlCTime = 0;
  if (_ctrlCHintTimeout) {
    clearTimeout(_ctrlCHintTimeout);
    _ctrlCHintTimeout = null;
  }
  hideStatusHint();
}

export function isCtrlDSecondPress(now: number): boolean {
  return now - _lastCtrlDTime < DOUBLE_PRESS_THRESHOLD_MS;
}

export function armCtrlDHint(now: number, suffix: string): void {
  _lastCtrlDTime = now;
  showStatusHint("ctrl+d", suffix);
  if (_ctrlDHintTimeout) clearTimeout(_ctrlDHintTimeout);
  _ctrlDHintTimeout = setTimeout(() => {
    hideStatusHint();
    _lastCtrlDTime = 0;
  }, DOUBLE_PRESS_THRESHOLD_MS);
}

export function resetCtrlDState(): void {
  _lastCtrlDTime = 0;
  if (_ctrlDHintTimeout) {
    clearTimeout(_ctrlDHintTimeout);
    _ctrlDHintTimeout = null;
  }
  hideStatusHint();
}
