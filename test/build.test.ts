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

  it("throws when nothing fits, so a caller won't overwrite good output", async () => {
    vi.spyOn(IwlsClient.prototype, "stations").mockResolvedValue([
      { id: "abc", officialName: "Somewhere New", latitude: 0, longitude: 0, operating: true },
    ] as never);
    vi.spyOn(pipeline, "fitStation").mockResolvedValue(null as never);
    await expect(buildBundle({ cacheDir: ".cache-test" })).rejects.toThrow(/No stations were fitted/);
  });
});
