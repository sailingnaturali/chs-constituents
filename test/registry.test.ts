import { describe, it, expect } from "vitest";
import { normalizeName, registryOverlay, stationsFromApi } from "../src/registry.js";

describe("normalizeName", () => {
  it("folds case, punctuation and spacing so provider names match curated ones", () => {
    expect(normalizeName("DODD NARROWS")).toBe("dodd narrows");
    expect(normalizeName("Hole in the Wall")).toBe("hole in the wall");
    expect(normalizeName("Juan de Fuca - East")).toBe("juan de fuca east");
  });
});

describe("registryOverlay", () => {
  it("keys entries by normalized name and reads no id at all", () => {
    // No providerId field anywhere — proves the overlay is forward-compatible
    // with the registry dropping providerId in Phase 2.
    const overlay = registryOverlay(
      { "chs-dodd-narrows": { name: "Dodd Narrows", provider: "chs" } },
      "chs",
    );
    expect(overlay.get("dodd narrows")).toEqual({ key: "chs-dodd-narrows", label: "Dodd Narrows" });
  });

  it("only includes the requested provider", () => {
    const overlay = registryOverlay(
      { "chs-x": { name: "X", provider: "chs" }, "noaa-y": { name: "Y", provider: "noaa" } },
      "chs",
    );
    expect([...overlay.keys()]).toEqual(["x"]);
  });

  it("refuses an entry with an empty key or name", () => {
    expect(() => registryOverlay({ "": { name: "X", provider: "chs" } })).toThrow(/empty/);
    expect(() => registryOverlay({ "chs-x": { name: "", provider: "chs" } })).toThrow(/empty/);
  });

  it("includes the real bundled CHS gates (guards a silent rename)", () => {
    const overlay = registryOverlay();
    expect(overlay.get("dodd narrows")?.key).toBe("chs-dodd-narrows");
    expect(overlay.size).toBeGreaterThanOrEqual(19);
  });
});

describe("stationsFromApi", () => {
  const overlay = registryOverlay(
    { "chs-dodd-narrows": { name: "Dodd Narrows", provider: "chs" } },
    "chs",
  );

  it("takes id from the live station, key+label from the overlay when the name matches", () => {
    const refs = stationsFromApi(
      [{ id: "63aef1866a2b9417c035030f", officialName: "DODD NARROWS", latitude: 49.1, longitude: -123.8, operating: true }],
      overlay,
    );
    expect(refs).toEqual([{ id: "63aef1866a2b9417c035030f", label: "Dodd Narrows", key: "chs-dodd-narrows" }]);
  });

  it("falls back to the official name and no key when unmatched (pipeline slugs it)", () => {
    const refs = stationsFromApi(
      [{ id: "abc", officialName: "Somewhere New", latitude: 0, longitude: 0, operating: true }],
      overlay,
    );
    expect(refs).toEqual([{ id: "abc", label: "Somewhere New" }]);
  });
});
