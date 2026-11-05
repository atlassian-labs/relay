import { describe, expect, test } from "bun:test";
import { ScrollBoxRenderable, type MouseEvent } from "@opentui/core";

import {
  handleChatRootMouseScroll,
  preserveStickyScrollBoundaryAfterMouseScroll,
} from "../../../src/ui/util/opentui-scrollbox";

type ScrollDirection = "up" | "down";

type ScrollEventFixture = {
  event: MouseEvent;
  defaultPrevented: () => boolean;
  propagationStopped: () => boolean;
};

function createScrollEvent(direction: ScrollDirection, target: MouseEvent["target"] = null): ScrollEventFixture {
  let prevented = false;
  let stopped = false;
  const event = {
    type: "scroll",
    button: 0,
    x: 20,
    y: 5,
    target,
    modifiers: { shift: false, alt: false, ctrl: false },
    scroll: { direction, delta: 1 },
    preventDefault: () => {
      prevented = true;
    },
    stopPropagation: () => {
      stopped = true;
    },
  } as unknown as MouseEvent;
  return {
    event,
    defaultPrevented: () => prevented,
    propagationStopped: () => stopped,
  };
}

function createScrollBox(options: {
  scrollTop: number;
  scrollHeight: number;
  viewportHeight?: number;
  stickyStart?: "bottom" | "top";
  onMouseEvent?: (event: MouseEvent) => void;
  onScrollTo?: (position: number) => void;
}): ScrollBoxRenderable {
  const box = {
    x: 0,
    width: 80,
    scrollTop: options.scrollTop,
    scrollHeight: options.scrollHeight,
    stickyScroll: true,
    stickyStart: options.stickyStart ?? "bottom",
    viewport: { height: options.viewportHeight ?? 10 },
    onMouseEvent: options.onMouseEvent ?? (() => {}),
    scrollTo: (position: number) => {
      box.scrollTop = position;
      options.onScrollTo?.(position);
    },
  };
  Object.setPrototypeOf(box, ScrollBoxRenderable.prototype);
  return box as unknown as ScrollBoxRenderable;
}

describe("OpenTUI scrollbox routing", () => {
  test("does not dispatch a no-op wheel down at sticky bottom through the root handler", () => {
    let dispatched = false;
    const scrollBox = createScrollBox({
      scrollTop: 90,
      scrollHeight: 100,
      onMouseEvent: () => {
        dispatched = true;
      },
    });
    const fixture = createScrollEvent("down");

    expect(handleChatRootMouseScroll(scrollBox, fixture.event)).toBe(false);

    expect(dispatched).toBe(false);
    expect(fixture.defaultPrevented()).toBe(false);
  });

  test("dispatches wheel events that can move the chat scrollbox", () => {
    let dispatched = false;
    const scrollBox = createScrollBox({
      scrollTop: 80,
      scrollHeight: 100,
      onMouseEvent: () => {
        dispatched = true;
      },
    });
    const fixture = createScrollEvent("down");

    expect(handleChatRootMouseScroll(scrollBox, fixture.event)).toBe(true);

    expect(dispatched).toBe(true);
    expect(fixture.defaultPrevented()).toBe(true);
  });

  test("falls through from a child scrollbox at its boundary to the chat scrollbox", async () => {
    let childDispatched = false;
    let chatDispatched = false;
    const restoredPositions: number[] = [];
    const chatScrollBox = createScrollBox({
      scrollTop: 80,
      scrollHeight: 100,
      onMouseEvent: () => {
        chatDispatched = true;
        chatScrollBox.scrollTop = 90;
      },
      onScrollTo: (position) => restoredPositions.push(position),
    });
    const childScrollBox = createScrollBox({
      scrollTop: 90,
      scrollHeight: 100,
      onMouseEvent: () => {
        childDispatched = true;
      },
    });
    const fixture = createScrollEvent("down", childScrollBox);

    expect(handleChatRootMouseScroll(chatScrollBox, fixture.event)).toBe(true);
    await Promise.resolve();

    expect(childDispatched).toBe(false);
    expect(chatDispatched).toBe(true);
    expect(fixture.defaultPrevented()).toBe(true);
    expect(restoredPositions).toEqual([90]);
  });

  test("does not fall through while a child scrollbox can still consume the wheel", () => {
    let chatDispatched = false;
    const chatScrollBox = createScrollBox({
      scrollTop: 80,
      scrollHeight: 100,
      onMouseEvent: () => {
        chatDispatched = true;
      },
    });
    const childScrollBox = createScrollBox({
      scrollTop: 80,
      scrollHeight: 100,
    });
    const fixture = createScrollEvent("down", childScrollBox);

    expect(handleChatRootMouseScroll(chatScrollBox, fixture.event)).toBe(false);

    expect(chatDispatched).toBe(false);
    expect(fixture.defaultPrevented()).toBe(false);
  });

  test("restores sticky bottom after a direct no-op scrollbox wheel event", async () => {
    const restoredPositions: number[] = [];
    const scrollBox = createScrollBox({
      scrollTop: 90,
      scrollHeight: 100,
      onScrollTo: (position) => restoredPositions.push(position),
    });
    const fixture = createScrollEvent("down");

    expect(preserveStickyScrollBoundaryAfterMouseScroll(scrollBox, fixture.event)).toBe(true);
    await Promise.resolve();

    expect(fixture.propagationStopped()).toBe(true);
    expect(restoredPositions).toEqual([90]);
  });

  test("does not restore sticky bottom when the wheel event can still scroll", async () => {
    const restoredPositions: number[] = [];
    const scrollBox = createScrollBox({
      scrollTop: 80,
      scrollHeight: 100,
      onScrollTo: (position) => restoredPositions.push(position),
    });
    const fixture = createScrollEvent("down");

    expect(preserveStickyScrollBoundaryAfterMouseScroll(scrollBox, fixture.event)).toBe(false);
    await Promise.resolve();

    expect(fixture.propagationStopped()).toBe(false);
    expect(restoredPositions).toEqual([]);
  });
});
