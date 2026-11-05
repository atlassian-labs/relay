import { describe, expect, test } from "bun:test";

import { createNativeModalController } from "../../../src/ui/app/native-modal-controller";

describe("createNativeModalController", () => {
  test("keeps native modals mutually exclusive", () => {
    const modals = createNativeModalController();

    modals.open("token-usage");
    expect(modals.current()).toBe("token-usage");

    modals.open("shortcut-reference");
    expect(modals.current()).toBe("shortcut-reference");
    expect(modals.isOpen("token-usage")).toBe(false);
  });

  test("only closes the expected modal when an id is provided", () => {
    const modals = createNativeModalController();
    modals.open("connection-error");

    modals.close("token-usage");
    expect(modals.current()).toBe("connection-error");

    modals.close("connection-error");
    expect(modals.current()).toBeNull();
  });

  test("toggles one modal without opening overlapping state", () => {
    const modals = createNativeModalController();

    modals.toggle("token-usage");
    expect(modals.current()).toBe("token-usage");

    modals.toggle("shortcut-reference");
    expect(modals.current()).toBe("shortcut-reference");

    modals.toggle("shortcut-reference");
    expect(modals.current()).toBeNull();
  });
});
