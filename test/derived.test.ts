import { describe, it, expect } from "vitest";
import { derivedGates } from "../src/derived.js";

// A derived gate has no current station of its own: slack is the reference tide
// port's high/low water shifted by a fixed lag. The registry entry carries a
// `derived` block naming the reference and the HW/LW lags.
const REGISTRY = {
  "chs-malibu-rapids": {
    name: "Malibu Rapids",
    provider: "chs",
    kind: "current",
    derived: { reference: "chs-point-atkinson", hwLagMinutes: 25, lwLagMinutes: 35 },
  },
  "chs-point-atkinson": { name: "Point Atkinson", provider: "chs", kind: "tide" },
  "chs-dodd-narrows": { name: "Dodd Narrows", provider: "chs", kind: "current" },
};

describe("derivedGates", () => {
  it("reads derived-gate specs and resolves the reference port's name", () => {
    expect(derivedGates(REGISTRY)).toEqual([
      {
        key: "chs-malibu-rapids",
        name: "Malibu Rapids",
        referenceKey: "chs-point-atkinson",
        referenceName: "Point Atkinson",
        hwLagMinutes: 25,
        lwLagMinutes: 35,
      },
    ]);
  });

  it("ignores non-derived entries", () => {
    expect(derivedGates({ "chs-dodd-narrows": REGISTRY["chs-dodd-narrows"] })).toEqual([]);
  });

  it("refuses a derived gate whose reference is missing from the registry", () => {
    expect(() =>
      derivedGates({
        "chs-x": { name: "X", provider: "chs", derived: { reference: "chs-nope", hwLagMinutes: 1, lwLagMinutes: 2 } },
      }),
    ).toThrow(/chs-nope/);
  });
});
