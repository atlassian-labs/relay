import type { MouseEvent, ScrollBoxRenderable } from "@opentui/core";
import {
  handleChatRootMouseScroll,
  preserveStickyScrollBoundaryAfterMouseScroll,
  type ChatRootScrollOptions,
} from "../util/opentui-scrollbox";
import { cancelPendingAcpEscapeInterrupt } from "./escape-interrupt-guard";

export function preserveStickyScrollBoundaryAfterMouseScrollWithEscapeRecovery(
  scrollBox: ScrollBoxRenderable | null,
  event: MouseEvent,
): boolean {
  cancelPendingAcpEscapeInterrupt();
  return preserveStickyScrollBoundaryAfterMouseScroll(scrollBox, event);
}

export function handleChatRootMouseScrollWithEscapeRecovery(
  scrollBox: ScrollBoxRenderable | null,
  event: MouseEvent,
  options: ChatRootScrollOptions = {},
): boolean {
  cancelPendingAcpEscapeInterrupt();
  return handleChatRootMouseScroll(scrollBox, event, options);
}
