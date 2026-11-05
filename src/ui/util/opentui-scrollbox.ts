import { ScrollBoxRenderable, type BaseRenderable, type MouseEvent } from "@opentui/core";

type VerticalScrollDirection = "up" | "down";

type ScrollBoxWithMouseHandler = ScrollBoxRenderable & {
  onMouseEvent: (event: MouseEvent) => void;
};

type EditorViewport = {
  height: number;
};

type EditorViewScrollMetrics = {
  getTotalVirtualLineCount?: () => number;
  getViewport?: () => EditorViewport;
};

type EditBufferScrollOwner = BaseRenderable & {
  scrollY: number;
  virtualLineCount: number;
  x: number;
  y: number;
  width: number;
  height: number;
  editorView?: EditorViewScrollMetrics;
};

export interface ChatRootScrollOptions {
  blocked?: () => boolean;
  localScrollOwners?: () => readonly unknown[];
}

function verticalScrollDirection(event: MouseEvent): VerticalScrollDirection | null {
  if (event.type !== "scroll") return null;
  if (event.modifiers.shift) return null;
  const direction = event.scroll?.direction;
  return direction === "up" || direction === "down" ? direction : null;
}

function nearestScrollBox(target: BaseRenderable | null): ScrollBoxRenderable | null {
  let current = target;
  while (current) {
    if (current instanceof ScrollBoxRenderable) return current;
    current = current.parent;
  }
  return null;
}

function isEditBufferScrollOwner(value: unknown): value is EditBufferScrollOwner {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<EditBufferScrollOwner>;
  return (
    typeof candidate.scrollY === "number" &&
    typeof candidate.virtualLineCount === "number" &&
    typeof candidate.x === "number" &&
    typeof candidate.y === "number" &&
    typeof candidate.width === "number" &&
    typeof candidate.height === "number"
  );
}

function nearestEditBufferScrollOwner(target: BaseRenderable | null): EditBufferScrollOwner | null {
  let current = target;
  while (current) {
    if (isEditBufferScrollOwner(current)) return current;
    current = current.parent;
  }
  return null;
}

function editBufferTotalVirtualLineCount(owner: EditBufferScrollOwner): number {
  return owner.editorView?.getTotalVirtualLineCount?.() ?? owner.virtualLineCount;
}

function editBufferViewportHeight(owner: EditBufferScrollOwner): number {
  return owner.editorView?.getViewport?.().height ?? owner.height;
}

function editBufferCanScroll(owner: EditBufferScrollOwner, direction: VerticalScrollDirection): boolean {
  const maxScrollY = Math.max(0, editBufferTotalVirtualLineCount(owner) - editBufferViewportHeight(owner));
  if (maxScrollY <= 0) return false;
  return direction === "up" ? owner.scrollY > 0 : owner.scrollY < maxScrollY;
}

function isInsideRenderableBounds(owner: EditBufferScrollOwner, event: MouseEvent): boolean {
  const right = owner.x + owner.width;
  const bottom = owner.y + owner.height;
  return event.x >= owner.x && event.x < right && event.y >= owner.y && event.y < bottom;
}

function localScrollOwnerCanConsume(
  event: MouseEvent,
  direction: VerticalScrollDirection,
  options: ChatRootScrollOptions,
): boolean {
  const owners = options.localScrollOwners?.() ?? [];
  return owners.some(
    (owner) =>
      isEditBufferScrollOwner(owner) && isInsideRenderableBounds(owner, event) && editBufferCanScroll(owner, direction),
  );
}

function isInsideChatColumn(scrollBox: ScrollBoxRenderable, event: MouseEvent): boolean {
  const left = scrollBox.x;
  const right = left + scrollBox.width;
  return event.x >= left && event.x < right;
}

function maxVerticalScroll(scrollBox: ScrollBoxRenderable): number {
  return Math.max(0, scrollBox.scrollHeight - scrollBox.viewport.height);
}

function scrollBoxCanScrollVertically(scrollBox: ScrollBoxRenderable, direction: VerticalScrollDirection): boolean {
  const maxScrollTop = maxVerticalScroll(scrollBox);
  if (maxScrollTop <= 0) return false;
  return direction === "up" ? scrollBox.scrollTop > 0 : scrollBox.scrollTop < maxScrollTop;
}

function isAtStickyVerticalBoundary(scrollBox: ScrollBoxRenderable, direction: VerticalScrollDirection): boolean {
  if (!scrollBox.stickyScroll) return false;
  if (direction === "up") return scrollBox.stickyStart === "top" && scrollBox.scrollTop <= 0;
  return scrollBox.stickyStart === "bottom" && scrollBox.scrollTop >= maxVerticalScroll(scrollBox);
}

function restoreStickyScrollBoundaryAfterWheel(
  scrollBox: ScrollBoxRenderable,
  direction: VerticalScrollDirection,
): void {
  if (!isAtStickyVerticalBoundary(scrollBox, direction)) return;
  const restorePosition = direction === "up" ? 0 : maxVerticalScroll(scrollBox);
  queueMicrotask(() => scrollBox.scrollTo(restorePosition));
}

function dispatchWheelToScrollBox(scrollBox: ScrollBoxRenderable, event: MouseEvent): void {
  (scrollBox as ScrollBoxWithMouseHandler).onMouseEvent(event);
}

export function preserveStickyScrollBoundaryAfterMouseScroll(
  scrollBox: ScrollBoxRenderable | null,
  event: MouseEvent,
): boolean {
  const direction = verticalScrollDirection(event);
  if (!direction || !scrollBox || !isAtStickyVerticalBoundary(scrollBox, direction)) return false;

  restoreStickyScrollBoundaryAfterWheel(scrollBox, direction);
  event.stopPropagation();
  return true;
}

export function handleChatRootMouseScroll(
  scrollBox: ScrollBoxRenderable | null,
  event: MouseEvent,
  options: ChatRootScrollOptions = {},
): boolean {
  const direction = verticalScrollDirection(event);
  if (!direction) return false;
  if (!scrollBox || options.blocked?.()) return false;
  if (!isInsideChatColumn(scrollBox, event)) return false;

  const target = event.target;
  const targetScrollBox = nearestScrollBox(target);
  if (targetScrollBox === scrollBox) return false;
  if (targetScrollBox && scrollBoxCanScrollVertically(targetScrollBox, direction)) return false;
  if (localScrollOwnerCanConsume(event, direction, options)) return false;

  const editBufferOwner = nearestEditBufferScrollOwner(target);
  if (editBufferOwner && editBufferCanScroll(editBufferOwner, direction)) return false;
  if (!scrollBoxCanScrollVertically(scrollBox, direction)) return false;

  dispatchWheelToScrollBox(scrollBox, event);
  restoreStickyScrollBoundaryAfterWheel(scrollBox, direction);
  event.preventDefault();
  return true;
}
