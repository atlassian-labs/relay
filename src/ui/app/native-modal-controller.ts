import { createSignal } from "solid-js";

export type NativeModalId = "token-usage" | "shortcut-reference" | "connection-error";

export function createNativeModalController() {
  const [current, setCurrent] = createSignal<NativeModalId | null>(null);

  return {
    current,
    isOpen: (id: NativeModalId) => current() === id,
    open: (id: NativeModalId) => setCurrent(id),
    close: (id?: NativeModalId) => {
      if (id === undefined) {
        setCurrent(null);
        return;
      }
      setCurrent((active) => (active === id ? null : active));
    },
    toggle: (id: NativeModalId) => setCurrent((active) => (active === id ? null : id)),
  };
}

export type NativeModalController = ReturnType<typeof createNativeModalController>;
