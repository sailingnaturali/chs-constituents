import { describe, it, expect, vi, afterEach } from "vitest";
import { IwlsClient } from "../src/client.js";
import { fitTideStation } from "../src/pipeline.js";

afterEach(() => vi.restoreAllMocks());

// A synthetic 1-minute water-level series: M2 (period 12.42 h) + K1 (23.93 h)
// about a 3 m datum. fitTideStation must fetch wlp, decimate, fit, and label the
// result as a tide-harmonic fit with NO flood/ebb axis (a tide has none).
function syntheticWlp(days: number): Map<string, number> {
  const out = new Map<string, number>();
  const start = Date.UTC(2025, 6, 1);
  const m2 = (2 * Math.PI) / (12.4206 * 3600_000);
  const k1 = (2 * Math.PI) / (23.9345 * 3600_000);
  for (let m = 0; m < days * 1440; m++) {
    const t = start + m * 60_000;
    const level = 3.0 + 1.2 * Math.cos(m2 * (t - start)) + 0.5 * Math.cos(k1 * (t - start));
    out.set(new Date(t).toISOString().replace(/\.\d+Z$/, "Z"), level);
  }
  return out;
}

describe("fitTideStation", () => {
  it("fits a water-level series into a tide-harmonic record with no flood/ebb axis", async () => {
    const client = new IwlsClient({ requestIntervalMs: 0 });
    vi.spyOn(client, "series").mockResolvedValue(syntheticWlp(60));

    const fitted = await fitTideStation(
      client,
      { id: "iwls-pa", label: "Point Atkinson", key: "chs-point-atkinson" },
      { start: new Date("2025-07-01T00:00:00Z"), days: 60 },
    );

    expect(fitted).not.toBeNull();
    expect(fitted!.id).toBe("chs-point-atkinson");
    expect(fitted!.name).toBe("Point Atkinson");
    expect(fitted!.type).toBe("tide-harmonic");
    expect(fitted!.source).toBe("chs-derived");
    // A tide has no flood/ebb axis — those fields must be absent, not a fake 0.
    expect(fitted).not.toHaveProperty("floodDirection");
    expect(fitted).not.toHaveProperty("ebbDirection");
    // Datum recovered as the Z0 offset; the fit is tight against a clean series.
    expect(fitted!.offset).toBeCloseTo(3.0, 1);
    expect(fitted!.rms).toBeLessThan(0.05);
    // It fetched wlp (water level), not a current series.
    expect(client.series).toHaveBeenCalledWith("iwls-pa", "wlp", expect.any(Date), 60);
    // M2 amplitude ~1.2 m recovered.
    const m2 = fitted!.constituents.find((c) => c.name === "M2");
    expect(m2!.amplitude).toBeCloseTo(1.2, 1);
  });
});
