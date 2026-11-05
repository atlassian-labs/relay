import { useTerminalDimensions, type JSX } from "@opentui/solid";
import { createContext, useContext } from "solid-js";

export type TerminalDimensionsAccessor = ReturnType<typeof useTerminalDimensions>;

const TerminalDimensionsContext = createContext<TerminalDimensionsAccessor>();

/**
 * Shares OpenTUI's resize signal across the mounted application tree. Calling
 * useTerminalDimensions in every component registers one renderer listener per
 * call, while all consumers can safely derive from a single signal.
 */
export function TerminalDimensionsProvider(props: { children: JSX.Element }) {
  const dimensions = useTerminalDimensions();
  return <TerminalDimensionsContext.Provider value={dimensions}>{props.children}</TerminalDimensionsContext.Provider>;
}

/** Uses the application-wide signal, with a local signal for isolated component tests. */
export function useSharedTerminalDimensions(): TerminalDimensionsAccessor {
  const shared = useContext(TerminalDimensionsContext);
  return shared ?? useTerminalDimensions();
}
