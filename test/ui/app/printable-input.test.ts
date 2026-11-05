import { describe, expect, test } from "bun:test";

import {
  isSgrMouseReportInput,
  isSgrMouseReportPrefix,
  isSgrMouseReportSequence,
  printableInputFromEvent,
  stripLeadingSgrMouseReportSequences,
  stripSgrMouseReportSequences,
} from "../../../src/ui/app/printable-input";

const ESC_CSI = "\u001b[";
const C1_CSI = "\u009b";

describe("SGR mouse report printable input filtering", () => {
  test("recognizes prefixes of split bare SGR mouse report tails", () => {
    for (const prefix of ["<", "<6", "<64", "<64;", "<64;150", "<64;150;", "<64;150;30"]) {
      expect(isSgrMouseReportPrefix(prefix)).toBe(true);
    }
    for (const nonPrefix of ["", "<;", "<64;;", "<64;150;30M", "<64;150;30Q", "plain"]) {
      expect(isSgrMouseReportPrefix(nonPrefix)).toBe(false);
    }
  });

  test("recognizes complete leaked SGR mouse reports", () => {
    const reports = [
      "<65;181;34M",
      "<0;1;2m",
      `${ESC_CSI}<64;150;30M`,
      `${C1_CSI}<32;77;21M`,
      "<65;181;34M<64;150;30M<64;157;22M",
      `${ESC_CSI}<65;181;34M${C1_CSI}<64;150;30M<0;1;2m`,
    ];

    for (const report of reports) {
      expect(isSgrMouseReportSequence(report)).toBe(true);
      expect(isSgrMouseReportInput({ sequence: report })).toBe(true);
      expect(printableInputFromEvent({ sequence: report })).toBeNull();
    }
    expect(printableInputFromEvent({ sequence: "<0;1;2m", name: "m" })).toBeNull();
  });

  test("strips SGR mouse reports while preserving adjacent printable text", () => {
    const input = `before<65;181;34M${ESC_CSI}<64;150;30Mmiddle${C1_CSI}<0;1;2mafter`;

    expect(stripSgrMouseReportSequences(input)).toEqual({ text: "beforemiddleafter", stripped: true });
    expect(isSgrMouseReportSequence(input)).toBe(false);
    expect(isSgrMouseReportInput({ sequence: input })).toBe(true);
    expect(printableInputFromEvent({ sequence: input })).toBe("beforemiddleafter");
  });

  test("strips only leading SGR mouse reports for split-tail reconstruction", () => {
    expect(stripLeadingSgrMouseReportSequences("<65;181;34M<64;150;30Mkept")).toEqual({
      text: "kept",
      stripped: true,
    });
    expect(stripLeadingSgrMouseReportSequences("?<65;181;34Mkept")).toEqual({
      text: "?<65;181;34Mkept",
      stripped: false,
    });
  });

  test("does not classify incomplete or invalid mouse-report lookalikes", () => {
    const lookalikes = ["<65;181;34", "<65;181M", "<65;181;34Q", "<65;181;-34M", "<65;181;34 M", "plain text"];

    for (const lookalike of lookalikes) {
      expect(isSgrMouseReportInput({ sequence: lookalike })).toBe(false);
      expect(stripSgrMouseReportSequences(lookalike)).toEqual({ text: lookalike, stripped: false });
      expect(printableInputFromEvent({ sequence: lookalike })).toBe(lookalike);
    }
  });

  test("respects modifier-key suppression after stripping mouse reports", () => {
    expect(printableInputFromEvent({ sequence: "<65;181;34Mtext", ctrl: true })).toBeNull();
    expect(printableInputFromEvent({ sequence: "<65;181;34Mtext", meta: true })).toBeNull();
    expect(printableInputFromEvent({ sequence: "<65;181;34Mtext", option: true })).toBeNull();
    expect(printableInputFromEvent({ sequence: "<65;181;34Mtext", alt: true })).toBeNull();
  });
});
