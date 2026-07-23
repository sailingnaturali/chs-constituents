import { describe, it, expect, vi, afterEach } from "vitest";
import { buildBundle, NOTE } from "../src/build.js";
import * as pipeline from "../src/pipeline.js";
import { IwlsClient } from "../src/client.js";

afterEach(() => vi.restoreAllMocks());

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
});
