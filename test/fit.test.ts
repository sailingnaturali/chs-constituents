import { describe, it, expect } from "vitest";
import { createTidePredictor } from "@neaps/tide-predictor";
import { fit, type Sample } from "../src/fit.js";
import { IwlsClient } from "../src/client.js";
import { fitStation } from "../src/pipeline.js";

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

/**
 * A fitStation-ready stand-in for IwlsClient. Mirrors client.test.ts's
 * offlineClient: a real IwlsClient with `.get` replaced, so series()'s own
 * chunking/caching logic still runs and only the network call is faked. This
 * keeps working if IwlsClient's internals change, unlike a hand-rolled object
 * literal that duplicates its shape.
 *
 * `.get` serves both the metadata call and the wcsp1/wcdp1 data calls from
 * the same TRUTH tide predictor used above, evaluated over whatever date
 * range the request actually asks for (`series()` anchors chunks to the
 * epoch grid, not to a fixed date) - so fitStation always sees a full,
 * fittable series regardless of the `start`/`days` a test passes in.
 */
function fakeClient(): IwlsClient {
  const predictor = createTidePredictor(TRUTH);
  const client = new IwlsClient({ requestIntervalMs: 0 });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (client as any).get = async (path: string) => {
    if (path.includes("/metadata")) {
      return { floodDirection: 0, ebbDirection: 180, latitude: 0, longitude: 0 };
    }
    const code = /time-series-code=([^&]+)/.exec(path)![1];
    const from = new Date(/from=([^&]+)/.exec(path)![1]);
    const to = new Date(/to=([^&]+)/.exec(path)![1]);
    return predictor.getTimelinePrediction({ start: from, end: to, timeFidelity: 900 }).map((point) => ({
      eventDate: point.time.toISOString(),
      // floodDirection is 0 above, so wcdp1 only needs to carry the sign:
      // fetchProjectedSeries' cos(heading - floodDirection) then reconstructs
      // the signed wcsp1 value exactly from magnitude + heading.
      value: code === "wcsp1" ? Math.abs(point.level) : point.level >= 0 ? 0 : 180,
    }));
  };
  return client;
}

describe("fitStation station id", () => {
  const options = { start: new Date("2025-07-01T00:00:00Z"), days: 30 };

  it("uses the registry key as the fitted id when one is given", async () => {
    const station = { id: "63aef1866a2b9417c035030f", label: "Dodd Narrows", key: "chs-dodd-narrows" };
    const result = await fitStation(fakeClient(), station, options);
    expect(result?.id).toBe("chs-dodd-narrows");
    expect(result?.name).toBe("Dodd Narrows");
  });

  it("falls back to the derived slug for a station with no key", async () => {
    // A user-supplied --stations list has no registry key. This path must stay.
    const station = { id: "63aef1866a2b9417c035030f", label: "Dodd Narrows" };
    const result = await fitStation(fakeClient(), station, options);
    expect(result?.id).toBe("chs-dodd-narrows");
  });

  it("a renamed label cannot move a keyed station's id", async () => {
    // The point of the key: display name and public id are decoupled.
    const station = {
      id: "63aef1866a2b9417c035030f",
      label: "Dodd Narrows (north end)",
      key: "chs-dodd-narrows",
    };
    const result = await fitStation(fakeClient(), station, options);
    expect(result?.id).toBe("chs-dodd-narrows");
    expect(result?.name).toBe("Dodd Narrows (north end)");
  });
});
