import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { buildBundle, NOTE } from "../src/build.js";
import * as pipeline from "../src/pipeline.js";
import * as derived from "../src/derived.js";
import { IwlsClient } from "../src/client.js";

afterEach(() => vi.restoreAllMocks());

// The real registry always carries the Malibu derived gate, so every buildBundle
// runs the derived phase. Isolate the current-station tests from it by default;
// the derived test below opts back in with a controlled spec.
beforeEach(() => vi.spyOn(derived, "derivedGates").mockReturnValue([]));

describe("buildBundle", () => {
  it("fits resolved stations, carries the NOTE, and reports progress", async () => {
    vi.spyOn(IwlsClient.prototype, "stations").mockResolvedValue([
      { id: "abc", officialName: "Somewhere New", latitude: 0, longitude: 0, operating: true },
    ] as never);
    vi.spyOn(pipeline, "fitStation").mockResolvedValue({
      id: "somewhere-new", name: "Somewhere New", type: "harmonic",
      floodDirection: 100, ebbDirection: 280, offset: 0, constituents: [],
    } as never);
    const progress: string[] = [];

    const bundle = await buildBundle({ cacheDir: ".cache-test", onProgress: (m) => progress.push(m) });

    expect((bundle as { note: string }).note).toBe(NOTE);
    expect((bundle as { stations: unknown[] }).stations).toHaveLength(1);
    expect(progress.some((m) => m.includes("Somewhere New"))).toBe(true);
  });

  it("records dropped stations in the bundle so coverage is auditable", async () => {
    vi.spyOn(IwlsClient.prototype, "stations").mockResolvedValue([
      { id: "a", officialName: "Fits", latitude: 0, longitude: 0, operating: true },
      { id: "b", officialName: "Sparse", latitude: 0, longitude: 0, operating: true },
      { id: "c", officialName: "Breaks", latitude: 0, longitude: 0, operating: true },
    ] as never);
    vi.spyOn(pipeline, "fitStation")
      .mockResolvedValueOnce({
        id: "fits", name: "Fits", type: "harmonic",
        floodDirection: 100, ebbDirection: 280, offset: 0, constituents: [],
      } as never)
      .mockResolvedValueOnce(null as never)
      .mockRejectedValueOnce(new Error("HTTP 500"));

    const bundle = await buildBundle({ cacheDir: ".cache-test" });

    expect((bundle as { skipped: unknown }).skipped).toEqual([
      { label: "Sparse", reason: "insufficient samples" },
      { label: "Breaks", reason: "HTTP 500" },
    ]);
    expect((bundle as { stations: unknown[] }).stations).toHaveLength(1);
  });

  it("omits skipped entirely on a clean run", async () => {
    vi.spyOn(IwlsClient.prototype, "stations").mockResolvedValue([
      { id: "a", officialName: "Fits", latitude: 0, longitude: 0, operating: true },
    ] as never);
    vi.spyOn(pipeline, "fitStation").mockResolvedValue({
      id: "fits", name: "Fits", type: "harmonic",
      floodDirection: 100, ebbDirection: 280, offset: 0, constituents: [],
    } as never);

    const bundle = await buildBundle({ cacheDir: ".cache-test" });
    expect("skipped" in bundle).toBe(false);
  });

  it("throws when nothing fits, so a caller won't overwrite good output", async () => {
    vi.spyOn(IwlsClient.prototype, "stations").mockResolvedValue([
      { id: "abc", officialName: "Somewhere New", latitude: 0, longitude: 0, operating: true },
    ] as never);
    vi.spyOn(pipeline, "fitStation").mockResolvedValue(null as never);
    await expect(buildBundle({ cacheDir: ".cache-test" })).rejects.toThrow(/No stations were fitted/);
  });

  it("fits a derived gate's reference tide port and emits the derived-slack record", async () => {
    vi.spyOn(IwlsClient.prototype, "stations").mockResolvedValue([
      { id: "cur", officialName: "Dodd Narrows", latitude: 0, longitude: 0, operating: true },
    ] as never);
    vi.spyOn(pipeline, "fitStation").mockResolvedValue({
      id: "chs-dodd-narrows", name: "Dodd Narrows", type: "harmonic",
      floodDirection: 100, ebbDirection: 280, offset: 0, constituents: [],
    } as never);
    (derived.derivedGates as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        key: "chs-malibu-rapids", name: "Malibu Rapids",
        referenceKey: "chs-point-atkinson", referenceName: "Point Atkinson",
        hwLagMinutes: 25, lwLagMinutes: 35,
      },
    ]);
    vi.spyOn(IwlsClient.prototype, "tideStations").mockResolvedValue([
      { id: "iwls-pa", officialName: "Point Atkinson", latitude: 49.3, longitude: -123.2, operating: true },
    ] as never);
    const fitTide = vi.spyOn(pipeline, "fitTideStation").mockResolvedValue({
      id: "chs-point-atkinson", name: "Point Atkinson", type: "tide-harmonic", source: "chs-derived",
      offset: 3.0, constituents: [{ name: "M2", amplitude: 1, phase: 0 }], rms: 0.02, trainingDays: 210,
    } as never);

    const bundle = await buildBundle({ cacheDir: ".cache-test" });
    const stations = (bundle as { stations: Record<string, unknown>[] }).stations;

    // The reference tide port is fitted from its LIVE IWLS id, keyed by the registry key.
    expect(fitTide).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: "iwls-pa", key: "chs-point-atkinson", label: "Point Atkinson" }),
      expect.anything(),
    );
    expect(stations).toContainEqual(expect.objectContaining({ id: "chs-point-atkinson", type: "tide-harmonic" }));
    // The derived-slack record carries the reference + lags and NO constituents/speed.
    expect(stations).toContainEqual({
      id: "chs-malibu-rapids", name: "Malibu Rapids", type: "derived-slack", source: "tide-derived",
      reference: "chs-point-atkinson", hwLagMinutes: 25, lwLagMinutes: 35,
    });
  });
});
