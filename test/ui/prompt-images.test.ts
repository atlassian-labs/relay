import { describe, expect, test } from "bun:test";
import { promptImageAttachmentMarkers, promptImageMarkerSegments } from "../../src/ui/prompt-images";

describe("prompt image markers", () => {
  test("splits inline image markers without moving them", () => {
    const content = "look at [image #4 screen.png] and compare\nwith [image #5 clipboard.png] please";

    const segments = promptImageMarkerSegments(content);

    expect(segments).toEqual([
      { type: "text", text: "look at " },
      { type: "image", text: "[image #4 screen.png]", imageId: 4 },
      { type: "text", text: " and compare\nwith " },
      { type: "image", text: "[image #5 clipboard.png]", imageId: 5 },
      { type: "text", text: " please" },
    ]);
    expect(segments.map((segment) => segment.text).join("")).toBe(content);
  });

  test("deduplicates attachment markers by image id", () => {
    expect(promptImageAttachmentMarkers("[image #4 screen.png]\nagain [image #4 screen.png]")).toEqual([
      "[image #4 screen.png]",
    ]);
  });
});
