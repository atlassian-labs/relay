import * as path from "node:path";
import { existsSync, readFileSync } from "../platform/fs";

export interface WebAssets {
  readonly indexHtml: string;
  readonly stylesCss: string;
  readonly clientJs: string;
}

async function bundleClient(entrypoint: string): Promise<string> {
  const result = await Bun.build({
    entrypoints: [entrypoint],
    target: "browser",
    format: "esm",
    minify: false,
    sourcemap: "inline",
    write: false,
  } as Parameters<typeof Bun.build>[0]);
  if (!result.success) {
    const messages = result.logs.map((log) => log.message).join("\n");
    // effect-shape-allow: web asset bundling is a Bun/browser build boundary.
    throw new Error(`failed to bundle Relay web client${messages ? `:\n${messages}` : ""}`);
  }
  const output = result.outputs.find((file) => file.kind === "entry-point") ?? result.outputs[0];
  // effect-shape-allow: web asset bundling is a Bun/browser build boundary.
  if (!output) throw new Error("failed to bundle Relay web client: no output produced");
  return output.text();
}

// effect-shape-allow: web assets are loaded once at the Bun server boundary.
export async function loadWebAssets(): Promise<WebAssets> {
  const staticDir = path.join(import.meta.dir, "static");
  const clientEntry = path.join(import.meta.dir, "client", "main.ts");
  const clientJsPath = path.join(staticDir, "client.js");

  return {
    indexHtml: readFileSync(path.join(staticDir, "index.html"), "utf8"),
    stylesCss: readFileSync(path.join(staticDir, "styles.css"), "utf8"),
    clientJs: existsSync(clientEntry) ? await bundleClient(clientEntry) : readFileSync(clientJsPath, "utf8"),
  };
}
