import { afterEach, describe, expect, test } from "bun:test";
import { ScrollBoxRenderable, type MouseEvent } from "@opentui/core";

import {
  scheduleAcpEscapeInterrupt,
  cancelPendingAcpEscapeInterrupt,
} from "../../../src/ui/app/escape-interrupt-guard";
import {
  handleChatRootMouseScrollWithEscapeRecovery,
  preserveStickyScrollBoundaryAfterMouseScrollWithEscapeRecovery,
} from "../../../src/ui/app/scroll-escape-recovery";

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

async function waitPastEscapeRecoveryWindow(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 100));
}

function scheduleInterruptCounter(): { interrupts: () => number } {
  let interrupts = 0;
  scheduleAcpEscapeInterrupt({
    shouldInterrupt: () => true,
    interrupt: () => {
      interrupts++;
      return Promise.resolve(true);
    },
  });
  return { interrupts: () => interrupts };
}

describe("scroll Escape recovery", () => {
  afterEach(() => {
    cancelPendingAcpEscapeInterrupt();
  });

  test("keeps an intentional Escape interrupt when no recovered mouse scroll arrives", async () => {
    cancelPendingAcpEscapeInterrupt();
    const counter = scheduleInterruptCounter();

    await waitPastEscapeRecoveryWindow();

    expect(counter.interrupts()).toBe(1);
  });

  test("cancels a pending Escape interrupt from root chat mouse scroll recovery", async () => {
    cancelPendingAcpEscapeInterrupt();
    const counter = scheduleInterruptCounter();
    let dispatched = false;
    const scrollBox = createScrollBox({
      scrollTop: 80,
      scrollHeight: 100,
      onMouseEvent: () => {
        dispatched = true;
      },
    });
    const fixture = createScrollEvent("down");

    expect(handleChatRootMouseScrollWithEscapeRecovery(scrollBox, fixture.event)).toBe(true);
    await waitPastEscapeRecoveryWindow();

    expect(dispatched).toBe(true);
    expect(fixture.defaultPrevented()).toBe(true);
    expect(counter.interrupts()).toBe(0);
  });

  test("cancels a pending Escape interrupt from direct scrollbox recovery that stops propagation", async () => {
    cancelPendingAcpEscapeInterrupt();
    const counter = scheduleInterruptCounter();
    const restoredPositions: number[] = [];
    const scrollBox = createScrollBox({
      scrollTop: 90,
      scrollHeight: 100,
      onScrollTo: (position) => restoredPositions.push(position),
    });
    const fixture = createScrollEvent("down");

    expect(preserveStickyScrollBoundaryAfterMouseScrollWithEscapeRecovery(scrollBox, fixture.event)).toBe(true);
    await Promise.resolve();
    await waitPastEscapeRecoveryWindow();

    expect(fixture.propagationStopped()).toBe(true);
    expect(restoredPositions).toEqual([90]);
    expect(counter.interrupts()).toBe(0);
  });
});
