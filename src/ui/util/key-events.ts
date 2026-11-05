export const ENTER_KEY_NAMES = ["return", "kpenter", "enter"] as const;

export interface KeyModifierEvent {
  name?: string;
  option?: boolean;
  meta?: boolean;
  alt?: boolean;
}

export function isEnterKey(evt: Pick<KeyModifierEvent, "name">): boolean {
  return ENTER_KEY_NAMES.some((name) => evt.name === name);
}

export function hasOptionModifier(evt: Pick<KeyModifierEvent, "option" | "meta" | "alt">): boolean {
  return evt.option === true || evt.meta === true || evt.alt === true;
}
