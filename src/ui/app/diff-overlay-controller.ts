import { createSignal } from "solid-js";
import { parseUnifiedDiff } from "../../core/diff-utils";
import type { Disposable, RelayDiffOverlayOptions, RelayPluginInfo } from "../../plugins";
import type { DiffOverlayAction, DiffOverlayCommand, DiffOverlayRequest } from "../component/diff-overlay";

export const [fileChangesModalOpen, setFileChangesModalOpen] = createSignal(false);
export const [diffOverlayRequest, setDiffOverlayRequest] = createSignal<DiffOverlayRequest | null>(null);
export const [diffOverlayCommand, setDiffOverlayCommand] = createSignal<DiffOverlayCommand | null>(null);

let diffOverlayCommandId = 0;
let diffOverlayRequestId = 0;
const pluginDiffOverlayOwners = new Map<number, string>();

export function sendDiffOverlayCommand(action: DiffOverlayAction): void {
  setDiffOverlayCommand({ id: ++diffOverlayCommandId, action });
}

export function clearDiffOverlayRequest(): void {
  const request = diffOverlayRequest();
  if (request) pluginDiffOverlayOwners.delete(request.id);
  setDiffOverlayRequest(null);
}

export function closeDiffOverlay(): void {
  clearDiffOverlayRequest();
  setFileChangesModalOpen(false);
}

export function setDiffOverlayOpen(updater: (value: boolean) => boolean): void {
  if (updater(fileChangesModalOpen())) setFileChangesModalOpen(true);
  else closeDiffOverlay();
}

function pluginDiffText(options: RelayDiffOverlayOptions): Promise<string> {
  if (options.diffText !== undefined) return Promise.resolve(options.diffText);
  return Promise.resolve(options.loadDiffText?.() ?? "");
}

export function openPluginDiffOverlay(plugin: RelayPluginInfo, options: RelayDiffOverlayOptions): Disposable {
  clearDiffOverlayRequest();
  const id = ++diffOverlayRequestId;
  pluginDiffOverlayOwners.set(id, plugin.id);
  setDiffOverlayRequest({
    id,
    title: options.title ?? "Diff",
    subtitle: options.subtitle ?? plugin.name,
    emptyMessage: options.emptyMessage ?? "No diff.",
    load: async () => parseUnifiedDiff(await pluginDiffText(options)),
  });
  setFileChangesModalOpen(true);
  return {
    dispose: () => {
      if (diffOverlayRequest()?.id === id) closeDiffOverlay();
      pluginDiffOverlayOwners.delete(id);
    },
  };
}

export function clearPluginDiffOverlay(plugin: RelayPluginInfo): void {
  const request = diffOverlayRequest();
  if (request && pluginDiffOverlayOwners.get(request.id) === plugin.id) closeDiffOverlay();
  for (const [id, ownerId] of pluginDiffOverlayOwners) {
    if (ownerId === plugin.id) pluginDiffOverlayOwners.delete(id);
  }
}
