import { describe, it, expect } from "vitest";
import { registryStations, mapRegistry } from "../src/registry.js";

// The full set of public ids the registry currently hands out, pinned so a
// future rename of a registry *key* (a breaking change for every consumer -
// it's the fitted station id) fails a test instead of shipping silently.
// Captured from the built loader, not typed from memory.
const EXPECTED_KEYS = [
  "chs-active-pass",
  "chs-arran-rapids",
  "chs-beazley-passage",
  "chs-blackney-passage",
  "chs-dent-rapids",
  "chs-dodd-narrows",
  "chs-first-narrows",
  "chs-gabriola-passage",
  "chs-gillard-passage",
  "chs-hole-in-the-wall",
  "chs-johnstone-strait-central",
  "chs-juan-de-fuca-east",
  "chs-porlier-pass",
  "chs-race-passage",
  "chs-sechelt-rapids",
  "chs-second-narrows",
  "chs-seymour-narrows",
  "chs-tillicum-bridge",
  "chs-weynton-passage",
];

describe("registryStations", () => {
  it("returns the bundled CHS gates as StationRefs", () => {
    const stations = registryStations();
    expect(stations.length).toBeGreaterThanOrEqual(19);
    const dodd = stations.find((s) => s.key === "chs-dodd-narrows");
    expect(dodd).toBeDefined();
    expect(dodd!.label).toBe("Dodd Narrows");
    // `id` is what the IWLS API is called with - the provider's own handle,
    // not the registry key.
    expect(dodd!.id).toBe("63aef1866a2b9417c035030f");
  });

  it("keeps the public ids stable - a registry key rename would break every consumer", () => {
    const keys = registryStations()
      .map((s) => s.key)
      .sort();
    expect(keys).toEqual(EXPECTED_KEYS);
  });

  it("only returns stations for the requested provider", () => {
    for (const station of registryStations("chs")) {
      expect(station.key!.startsWith("chs-")).toBe(true);
    }
    expect(registryStations("nonexistent")).toEqual([]);
  });

  it("every station has the three fields the pipeline needs", () => {
    for (const station of registryStations()) {
      expect(typeof station.id).toBe("string");
      expect(station.id.length).toBeGreaterThan(0);
      expect(typeof station.label).toBe("string");
      expect(station.label.length).toBeGreaterThan(0);
      expect(typeof station.key).toBe("string");
    }
  });

  it("refuses an entry with an empty key, name, or providerId rather than emitting a blank id", () => {
    // fitStation does `station.key ?? slug(station.label)` - `??` only skips
    // null/undefined, so an empty string sails past that fallback and would
    // otherwise come out as a blank or wrong fitted id. mapRegistry must
    // catch this at the source instead of shipping it quietly. Synthetic
    // data, not the real registry - the real one should never have this
    // shape, and this guard has to hold regardless of what it currently has.
    expect(() =>
      mapRegistry({ "": { name: "Dodd Narrows", provider: "chs", providerId: "abc123" } }, "chs"),
    ).toThrow(/empty/);
    expect(() =>
      mapRegistry({ "chs-dodd-narrows": { name: "", provider: "chs", providerId: "abc123" } }, "chs"),
    ).toThrow(/empty/);
    expect(() =>
      mapRegistry({ "chs-dodd-narrows": { name: "Dodd Narrows", provider: "chs", providerId: "" } }, "chs"),
    ).toThrow(/empty/);
  });
});
