import { createContext, useContext, type JSX } from "solid-js";

export function createSimpleContext<T>(options: { name: string; init: () => T }) {
  const Context = createContext<T>();

  function use(): T {
    const value = useContext(Context);
    if (value === undefined) {
      throw new Error(`${options.name} context is not available`); // effect-shape-allow: Solid context hook fails fast when provider wiring is invalid.
    }
    return value;
  }

  function provider(props: { children: JSX.Element }) {
    const value = options.init();
    return <Context.Provider value={value}>{props.children}</Context.Provider>;
  }

  return { use, provider, Context };
}
