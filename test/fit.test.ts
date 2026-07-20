import { describe, it, expect } from "vitest";
import { createTidePredictor } from "@neaps/tide-predictor";
import { fit, type Sample } from "../src/fit.js";

/**
 * A plausible Salish current station: a strong semidiurnal pair, the diurnals
 * that make PNW currents asymmetric, and the shallow-water overtide that skews
 * the flood. Amplitudes in knots.
 */
const TRUTH = [
  { name: "M2", amplitude: 2.41, phase: 128.4 },
  { name: "S2", amplitude: 0.62, phase: 151.9 },
  { name: "N2", amplitude: 0.48, phase: 104.2 },
  { name: "K1", amplitude: 1.13, phase: 289.7 },
  { name: "O1", amplitude: 0.67, phase: 271.3 },
  { name: "P1", amplitude: 0.35, phase: 285.1 },
  { name: "Q1", amplitude: 0.12, phase: 254.8 },
  { name: "M4", amplitude: 0.21, phase: 33.6 },
];

/** Sample neaps' own synthesis, the way CHS hands us predictions: every 15 min. */
function synthesise(days: number, stepMinutes = 15): Sample[] {
  const start = new Date("2026-01-01T00:00:00Z");
  const end = new Date(start.getTime() + days * 86_400_000);
  const timeline = createTidePredictor(TRUTH).getTimelinePrediction({
    start,
    end,
    timeFidelity: stepMinutes * 60,
  });
  return timeline.map((point) => ({ time: point.time, value: point.level }));
}

const names = TRUTH.map((c) => c.name);
const byName = (result: ReturnType<typeof fit>, name: string) =>
  result.constituents.find((c) => c.name === name)!;

describe("fit", () => {
  it("recovers the constituents it was synthesised from", () => {
    const result = fit(synthesise(365), { constituents: names });

    for (const truth of TRUTH) {
      const got = byName(result, truth.name);
      expect(got.amplitude).toBeCloseTo(truth.amplitude, 3);
      // Phase wraps, so compare the shortest angular distance.
      const delta = Math.abs(((got.phase - truth.phase + 540) % 360) - 180);
      expect(delta).toBeLessThan(0.1);
    }

    expect(result.offset).toBeCloseTo(0, 3);
    expect(result.rms).toBeLessThan(0.005);
  });

  it("separates P1 from K1 given a long enough series", () => {
    // P1 and K1 sit 0.082°/hr apart, so Rayleigh wants ~183 days. This is the
    // constraint that decides how much CHS data the pipeline must fetch, so it
    // gets a test rather than a comment.
    const result = fit(synthesise(200), { constituents: names });
    expect(result.unseparable).toEqual([]);
    expect(byName(result, "P1").amplitude).toBeCloseTo(0.35, 2);
    expect(byName(result, "K1").amplitude).toBeCloseTo(1.13, 2);
  });

  it("flags the pairs a short series cannot resolve", () => {
    const result = fit(synthesise(90), { constituents: names });
    expect(result.unseparable[0]).toEqual({
      constituents: ["K1", "P1"],
      requiredDays: 183,
    });
  });

  it("reports rather than refuses, because predictions are noise-free", () => {
    // 3 days cannot resolve most of this basis, but the fit still returns —
    // enforcement belongs to the pipeline's validation stage, not the solver.
    const result = fit(synthesise(3), { constituents: names });
    expect(result.unseparable.length).toBeGreaterThan(0);
    expect(byName(result, "M2").amplitude).toBeGreaterThan(0);
  });

  it("leaves the trend term off unless asked", () => {
    const samples = synthesise(90);
    expect(fit(samples, { constituents: names }).trend).toBeUndefined();
    // utide defaults this ON, which is the port's likeliest silent mismatch.
    const withTrend = fit(samples, { constituents: names, trend: true });
    expect(withTrend.trend).toBeCloseTo(0, 4);
  });

  it("recovers a mean offset", () => {
    const samples = synthesise(90).map((s) => ({ ...s, value: s.value + 0.4 }));
    const result = fit(samples, { constituents: names });
    expect(result.offset).toBeCloseTo(0.4, 3);
    expect(byName(result, "M2").amplitude).toBeCloseTo(2.41, 3);
  });

  it("rejects an unknown constituent by name", () => {
    expect(() => fit(synthesise(30), { constituents: ["M2", "NOPE"] })).toThrow(/NOPE/);
  });
});
