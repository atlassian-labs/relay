/**
 * Public entrypoint for the Relay TUI app.
 *
 * The implementation lives in smaller app modules so imports can keep using
 * `src/ui/app` without pulling all application wiring into this facade.
 */

export { App, previewFromBlocks } from "./app-root";
export { launchTUI } from "./app/launch";
export type { AppProps, LaunchOptions } from "./app/types";
