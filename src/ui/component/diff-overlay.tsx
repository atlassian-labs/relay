import { createEffect, createMemo, createResource, createSignal, For, Match, Show, Switch } from "solid-js";
import { useSharedTerminalDimensions } from "../context/terminal-dimensions";
import type { ScrollBoxRenderable } from "@opentui/core";
import { getWorkingTreeDiff } from "../../core/git-diff";
import type { DiffFile } from "../../core/diff-utils";
import { computeDiffColors } from "../../config/themes";
import { runEffect } from "../../effect/runtime";
import { useApp } from "../state";
import { getColors, getSyntaxStyle } from "../context/theme";
import { truncateTextEnd } from "../util/format";
import {
  allExpandedDiffFileTreeDirectories,
  buildDiffFileTree,
  diffFileStatusSign,
  diffFileTreeParentDirectories,
  diffFileTreeRowPrefix,
  flattenDiffFileTree,
  orderedDiffFileTreeFileIndexes,
  toggleDiffFileTreeDirectory,
  type DiffFileTreeRow,
} from "./diff-file-tree";

const FILE_TREE_WIDTH = 32;
const MIN_SPLIT_WIDTH = 100;

export type DiffOverlayAction =
  | "scroll-up"
  | "scroll-down"
  | "page-up"
  | "page-down"
  | "scroll-top"
  | "scroll-bottom"
  | "previous-file"
  | "next-file"
  | "toggle-reviewed"
  | "toggle-view";

export type DiffOverlayCommand = {
  readonly id: number;
  readonly action: DiffOverlayAction;
};

export interface DiffOverlayRequest {
  readonly id: number;
  readonly title: string;
  readonly subtitle?: string;
  readonly emptyMessage?: string;
  load(): Promise<readonly DiffFile[]>;
}

type MouseLikeEvent = { stopPropagation?: () => void };

function filetype(path: string): string {
  const ext = path.split(".").pop();
  if (ext === "ts" || ext === "tsx" || ext === "js" || ext === "jsx") return "typescript";
  if (ext === "json") return "json";
  if (ext === "md") return "markdown";
  if (ext === "go") return "go";
  if (ext === "rs") return "rust";
  if (ext === "py") return "python";
  return "none";
}

function scrollRowIntoView(scroll: ScrollBoxRenderable | undefined, index: number): void {
  if (!scroll) return;
  if (index < scroll.scrollTop) {
    scroll.scrollTo(index);
    return;
  }
  if (index >= scroll.scrollTop + scroll.viewport.height) {
    scroll.scrollTo(index - scroll.viewport.height + 1);
  }
}

export function DiffOverlay(props: {
  open: () => boolean;
  onClose: () => void;
  command?: () => DiffOverlayCommand | null;
  request?: () => DiffOverlayRequest | null;
}) {
  const app = useApp();
  const colors = getColors();
  const dims = useSharedTerminalDimensions();
  const workingTreeRequest = (): DiffOverlayRequest => {
    const cwd = app.state.cwd;
    return {
      id: 0,
      title: "Diff",
      subtitle: "working tree",
      emptyMessage: "No working tree diff.",
      load: async () => await runEffect(getWorkingTreeDiff(cwd)),
    };
  };
  const activeRequest = () => (props.open() ? (props.request?.() ?? workingTreeRequest()) : null);
  const [diff] = createResource(activeRequest, async (request) => (request ? await request.load() : []));
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  const [view, setView] = createSignal<"unified" | "split">("unified");
  const [reviewed, setReviewed] = createSignal<ReadonlySet<string>>(new Set());
  const [expandedTreeNodes, setExpandedTreeNodes] = createSignal<ReadonlySet<number>>(new Set());
  let patchScroll: ScrollBoxRenderable | undefined;
  let fileTreeScroll: ScrollBoxRenderable | undefined;
  let lastCommandId = 0;
  let lastRequestId: number | null = null;

  const currentRequest = () => activeRequest();
  const title = () => currentRequest()?.title ?? "Diff";
  const subtitle = () => currentRequest()?.subtitle ?? "";
  const emptyMessage = () => currentRequest()?.emptyMessage ?? "No diff.";
  const loadError = () =>
    diff.error instanceof Error ? diff.error.message : String(diff.error ?? "Failed to load diff.");
  const contentWidth = () => Math.max(1, dims().width - 2);
  const fileTreeWidth = () => {
    const width = contentWidth();
    if (width < 40) return Math.max(1, Math.floor(width * 0.4));
    return Math.min(FILE_TREE_WIDTH, Math.max(18, Math.floor(width * 0.32)));
  };
  const files = () => diff() ?? [];
  const hasFilePane = () => !diff.loading && !diff.error && files().length > 0;
  const fileTree = createMemo(() => buildDiffFileTree(files()));
  const fileTreeRows = createMemo(() => flattenDiffFileTree(fileTree(), expandedTreeNodes()));
  const selectedFile = () => files()[selectedIndex()] ?? files()[0];
  const totalAdded = () => files().reduce((sum, file) => sum + file.additions, 0);
  const totalRemoved = () => files().reduce((sum, file) => sum + file.deletions, 0);
  const patchWidth = () => Math.max(1, contentWidth() - fileTreeWidth());
  const splitAvailable = () => patchWidth() >= MIN_SPLIT_WIDTH;
  const actualView = () => (splitAvailable() ? view() : "unified");
  const separatorLine = () => {
    const width = contentWidth();
    if (!hasFilePane()) return "─".repeat(width);
    const connectorIndex = Math.max(0, Math.min(width - 1, fileTreeWidth() - 1));
    return `${"─".repeat(connectorIndex)}┬${"─".repeat(width - connectorIndex - 1)}`;
  };
  const patchSeparatorLine = () => "─".repeat(patchWidth());
  const dc = () => computeDiffColors(colors);

  const scrollPageSize = () => Math.max(1, patchScroll?.viewport.height ?? dims().height - 4);
  const scrollPatchToTopSoon = () => requestAnimationFrame(() => patchScroll?.scrollTo(0));
  const selectFile = (index: number) => {
    const count = files().length;
    if (count === 0) return;
    setSelectedIndex(Math.max(0, Math.min(count - 1, index)));
    scrollPatchToTopSoon();
  };
  const moveFile = (offset: number) => {
    const fileIndexes = orderedDiffFileTreeFileIndexes(fileTreeRows());
    if (fileIndexes.length === 0) return;
    const currentPosition = fileIndexes.indexOf(selectedIndex());
    const basePosition = currentPosition === -1 ? (offset < 0 ? fileIndexes.length : -1) : currentPosition;
    const nextPosition = Math.max(0, Math.min(fileIndexes.length - 1, basePosition + offset));
    selectFile(fileIndexes[nextPosition]!);
  };
  const toggleTreeRow = (row: DiffFileTreeRow) => {
    if (row.fileIndex !== undefined) {
      selectFile(row.fileIndex);
      return;
    }
    setExpandedTreeNodes((current) => toggleDiffFileTreeDirectory(fileTree(), current, row.id));
  };

  const toggleReviewed = (path: string) => {
    setReviewed((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const toggleSelectedReviewed = () => {
    const file = selectedFile();
    if (file) toggleReviewed(file.path);
  };

  const handleCommand = (action: DiffOverlayAction) => {
    switch (action) {
      case "scroll-up":
        patchScroll?.scrollBy(-1);
        break;
      case "scroll-down":
        patchScroll?.scrollBy(1);
        break;
      case "page-up":
        patchScroll?.scrollBy(-scrollPageSize());
        break;
      case "page-down":
        patchScroll?.scrollBy(scrollPageSize());
        break;
      case "scroll-top":
        patchScroll?.scrollTo(0);
        break;
      case "scroll-bottom":
        patchScroll?.scrollTo(patchScroll.scrollHeight);
        break;
      case "previous-file":
        moveFile(-1);
        break;
      case "next-file":
        moveFile(1);
        break;
      case "toggle-reviewed":
        toggleSelectedReviewed();
        break;
      case "toggle-view":
        if (splitAvailable()) setView((value) => (value === "split" ? "unified" : "split"));
        break;
    }
  };

  createEffect(() => {
    const requestId = currentRequest()?.id ?? null;
    if (requestId === lastRequestId) return;
    lastRequestId = requestId;
    setSelectedIndex(0);
    setView("unified");
    setReviewed(new Set<string>());
    requestAnimationFrame(() => {
      patchScroll?.scrollTo(0);
      fileTreeScroll?.scrollTo(0);
    });
  });

  createEffect(() => {
    const count = files().length;
    if (count > 0 && selectedIndex() >= count) setSelectedIndex(count - 1);
  });

  createEffect(() => {
    setExpandedTreeNodes(allExpandedDiffFileTreeDirectories(fileTree()));
  });

  createEffect(() => {
    const parentDirectories = diffFileTreeParentDirectories(fileTree(), selectedIndex());
    if (parentDirectories.size === 0) return;
    setExpandedTreeNodes((current) => {
      const next = new Set(current);
      let changed = false;
      for (const id of parentDirectories) {
        if (!next.has(id)) {
          next.add(id);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  });

  createEffect(() => {
    const selectedRowIndex = fileTreeRows().findIndex((row) => row.fileIndex === selectedIndex());
    if (selectedRowIndex === -1) return;
    const scrollSelectedIntoView = () => scrollRowIntoView(fileTreeScroll, selectedRowIndex);
    scrollSelectedIntoView();
    requestAnimationFrame(scrollSelectedIntoView);
  });

  createEffect(() => {
    const command = props.command?.();
    if (!command || command.id === lastCommandId) return;
    lastCommandId = command.id;
    handleCommand(command.action);
  });

  const stopPropagation = (event: MouseLikeEvent) => event.stopPropagation?.();
  const close = (event: MouseLikeEvent) => {
    event.stopPropagation?.();
    props.onClose();
  };

  return (
    <Show when={props.open()}>
      <box
        position="absolute"
        zIndex={2500}
        left={0}
        top={0}
        width={dims().width}
        height={dims().height}
        backgroundColor={colors.bg}
        paddingLeft={1}
        paddingRight={1}
        flexDirection="column"
        onMouseDown={stopPropagation}
        onMouseUp={stopPropagation}
      >
        <box height={1} flexDirection="row">
          <text fg={colors.fg}>{title()}</text>
          <Show when={subtitle()}>{(value) => <text fg={colors.textMuted}> {value()}</text>}</Show>
          <box flexGrow={1} />
          <text fg={colors.textMuted}>
            {files().length} file{files().length === 1 ? "" : "s"}
          </text>
          <text fg={colors.diffAdded}> +{totalAdded()}</text>
          <text fg={colors.diffRemoved}> -{totalRemoved()}</text>
        </box>
        <box height={1}>
          <text fg={colors.border}>{separatorLine()}</text>
        </box>
        <box flexGrow={1} minHeight={0} flexDirection="row">
          <Switch>
            <Match when={diff.loading}>
              <box>
                <text fg={colors.textMuted}>Loading diff...</text>
              </box>
            </Match>
            <Match when={!diff.loading && diff.error}>
              <box>
                <text fg={colors.error}>{loadError()}</text>
              </box>
            </Match>
            <Match when={!diff.loading && files().length === 0}>
              <box>
                <text fg={colors.textMuted}>{emptyMessage()}</text>
              </box>
            </Match>
            <Match when={!diff.loading && files().length > 0}>
              <box
                width={fileTreeWidth()}
                flexDirection="column"
                border={["right"] as never}
                borderColor={colors.border}
              >
                <scrollbox
                  ref={(element: ScrollBoxRenderable) => (fileTreeScroll = element)}
                  flexGrow={1}
                  minHeight={0}
                  verticalScrollbarOptions={{ visible: false }}
                  horizontalScrollbarOptions={{ visible: false }}
                >
                  <For each={fileTreeRows()}>
                    {(row, index) => {
                      const file = () => (row.fileIndex === undefined ? undefined : files()[row.fileIndex]);
                      const active = () => row.fileIndex !== undefined && row.fileIndex === selectedIndex();
                      const isReviewed = () => {
                        const currentFile = file();
                        return currentFile !== undefined && reviewed().has(currentFile.path);
                      };
                      const prefix = () => diffFileTreeRowPrefix(fileTreeRows(), index(), row, expandedTreeNodes());
                      const status = () => {
                        const currentFile = file();
                        if (!currentFile) return "  ";
                        const marker = active() ? "›" : isReviewed() ? "✓" : " ";
                        return `${marker}${diffFileStatusSign(currentFile.status)}`;
                      };
                      const nameWidth = () => Math.max(1, fileTreeWidth() - prefix().length - 4);
                      const fg = () =>
                        active()
                          ? colors.accent
                          : row.kind === "directory" || isReviewed()
                            ? colors.textMuted
                            : colors.fg;
                      return (
                        <box height={1} width="100%" flexDirection="row" onMouseDown={() => toggleTreeRow(row)}>
                          <text fg={colors.textMuted} wrapMode="none" flexShrink={0}>
                            {prefix()}
                          </text>
                          <box flexGrow={1} minWidth={0}>
                            <text fg={fg()} wrapMode="none">
                              {truncateTextEnd(row.name, nameWidth())}
                            </text>
                          </box>
                          <text
                            fg={active() ? colors.accent : isReviewed() ? colors.textMuted : colors.fg}
                            wrapMode="none"
                            flexShrink={0}
                          >
                            {status()}
                          </text>
                        </box>
                      );
                    }}
                  </For>
                </scrollbox>
              </box>
              <box flexGrow={1} minWidth={0} flexDirection="column">
                <Show when={selectedFile()}>
                  {(file) => {
                    const isReviewed = () => reviewed().has(file().path);
                    return (
                      <>
                        <box height={1} paddingLeft={1} paddingRight={1} flexDirection="row">
                          <text fg={isReviewed() ? colors.textMuted : colors.fg} wrapMode="none">
                            {truncateTextEnd(file().path, Math.max(1, patchWidth() - 16))}
                          </text>
                          <box flexGrow={1} />
                          <text fg={isReviewed() ? colors.textMuted : colors.diffAdded}>+{file().additions}</text>
                          <text fg={isReviewed() ? colors.textMuted : colors.diffRemoved}> -{file().deletions}</text>
                        </box>
                        <box height={1}>
                          <text fg={colors.border} wrapMode="none">
                            {patchSeparatorLine()}
                          </text>
                        </box>
                        <scrollbox
                          ref={(element: ScrollBoxRenderable) => (patchScroll = element)}
                          flexGrow={1}
                          minHeight={0}
                          verticalScrollbarOptions={{ visible: false }}
                          horizontalScrollbarOptions={{ visible: false }}
                        >
                          <diff
                            diff={file().patch}
                            view={actualView()}
                            filetype={isReviewed() ? "none" : filetype(file().path)}
                            syntaxStyle={getSyntaxStyle()}
                            showLineNumbers={true}
                            width="100%"
                            wrapMode="char"
                            fg={isReviewed() ? colors.textMuted : colors.fg}
                            addedBg={isReviewed() ? colors.bg : dc().addedBg}
                            removedBg={isReviewed() ? colors.bg : dc().removedBg}
                            contextBg={colors.bg}
                            addedSignColor={isReviewed() ? colors.textMuted : dc().highlightAdded}
                            removedSignColor={isReviewed() ? colors.textMuted : dc().highlightRemoved}
                            lineNumberFg={dc().lineNumberFg}
                            lineNumberBg={colors.bg}
                            addedLineNumberBg={colors.bg}
                            removedLineNumberBg={colors.bg}
                          />
                        </scrollbox>
                      </>
                    );
                  }}
                </Show>
              </box>
            </Match>
          </Switch>
        </box>
        <box height={1} gap={2} flexDirection="row">
          <text onMouseDown={close} wrapMode="none">
            <span style={{ fg: colors.textLabel, bold: true } as never}>q/esc</span>
            <span style={{ fg: colors.textSubtle } as never}> close</span>
          </text>
          <text wrapMode="none">
            <span style={{ fg: colors.textLabel, bold: true } as never}>↑↓/jk</span>
            <span style={{ fg: colors.textSubtle } as never}> scroll</span>
          </text>
          <Show when={files().length > 0}>
            <text wrapMode="none">
              <span style={{ fg: colors.textLabel, bold: true } as never}>←→/n/p</span>
              <span style={{ fg: colors.textSubtle } as never}> file</span>
            </text>
            <text onMouseDown={toggleSelectedReviewed} wrapMode="none">
              <span style={{ fg: colors.textLabel, bold: true } as never}>m</span>
              <span style={{ fg: colors.textSubtle } as never}> reviewed</span>
            </text>
            <Show when={splitAvailable()}>
              <text onMouseDown={() => setView((value) => (value === "split" ? "unified" : "split"))} wrapMode="none">
                <span style={{ fg: colors.textLabel, bold: true } as never}>s</span>
                <span style={{ fg: colors.textSubtle } as never}> {actualView()}</span>
              </text>
            </Show>
          </Show>
          <box flexGrow={1} />
          <text fg={colors.textSubtle} onMouseDown={close} wrapMode="none">
            close
          </text>
        </box>
      </box>
    </Show>
  );
}
