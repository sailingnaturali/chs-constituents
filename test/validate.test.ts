import { describe, it, expect } from "vitest";
import { validate, tier } from "../src/validate.js";
import type { CurrentEvent } from "../src/events.js";
import type { ObservedEvent } from "../src/client.js";

const at = (minutes: number) => new Date(Date.UTC(2026, 0, 1) + minutes * 60_000);
const iso = (minutes: number) => at(minutes).toISOString().replace(/\.\d+Z$/, "Z");

const predicted: CurrentEvent[] = [
  { time: at(0), kind: "slack", speed: 0 },
  { time: at(180), kind: "maxFlood", speed: 4 },
  { time: at(360), kind: "slack", speed: 0 },
  { time: at(540), kind: "maxEbb", speed: -4 },
];

/** Modelled velocity that agrees with `predicted`: flood early, ebb late. */
const rightWay = (time: Date) =>
  (time.getTime() - at(0).getTime()) / 60_000 < 360 ? 4 : -4;
const backwards = (time: Date) => -rightWay(time);

describe("validate", () => {
  it("measures extremum timing against the same kind of event", () => {
    const observed: ObservedEvent[] = [
      { time: iso(190), kind: "maxFlood", speed: 4 },
      { time: iso(550), kind: "maxEbb", speed: -4 },
    ];
    const result = validate(predicted, observed, rightWay);
    expect(result.median).toBe(10);
    expect(result.wrongSign).toBe(0);
  });

  it("keeps slack timing out of the headline", () => {
    // A station can be tight on extrema and loose on slack; pooling them once
    // produced a median no extrema-only harness could reproduce.
    const observed: ObservedEvent[] = [
      { time: iso(182), kind: "maxFlood", speed: 4 },
      { time: iso(60), kind: "slack", speed: 0 },
    ];
    const result = validate(predicted, observed, rightWay);
    expect(result.median).toBe(2);
    expect(result.slackMedian).toBe(60);
  });

  it("ignores extrema where the current is barely running", () => {
    const observed: ObservedEvent[] = [
      { time: iso(300), kind: "maxFlood", speed: 0.1 },
      { time: iso(185), kind: "maxFlood", speed: 4 },
    ];
    expect(validate(predicted, observed, rightWay).median).toBe(5);
  });

  it("does not match across tidal cycles", () => {
    // Beyond the window it is a different cycle, not a late prediction.
    const observed: ObservedEvent[] = [{ time: iso(600), kind: "maxFlood", speed: 4 }];
    const result = validate(predicted, observed, rightWay);
    expect(result.median).toBeNull();
    expect(result.matched).toBe(0);
  });

  it("detects a reversed axis from velocity sign, not from event proximity", () => {
    const observed: ObservedEvent[] = [
      { time: iso(180), kind: "maxFlood", speed: 4 },
      { time: iso(540), kind: "maxEbb", speed: -4 },
    ];
    expect(validate(predicted, observed, rightWay).wrongSign).toBe(0);
    expect(validate(predicted, observed, backwards).wrongSign).toBe(2);
  });
});

describe("tier", () => {
  const base = { max: null, slackMedian: null, wrongSign: 0, extrema: 10, matched: 10 };

  it("grades on extremum timing", () => {
    expect(tier({ ...base, median: 3 })).toBe("high");
    expect(tier({ ...base, median: 12 })).toBe("medium");
    expect(tier({ ...base, median: 30 })).toBe("low");
    expect(tier({ ...base, median: 40 })).toBe("quarantine");
  });

  it("quarantines a reversed axis however good the timing", () => {
    // A current predicted backwards is worse than one predicted late: the crew
    // acts on direction.
    expect(tier({ ...base, median: 1, wrongSign: 7 })).toBe("quarantine");
  });

  it("tolerates partial sign disagreement, which means timing not reversal", () => {
    // Juan de Fuca East was false-quarantined at 2/10 when its axis is correct.
    expect(tier({ ...base, median: 1, wrongSign: 2 })).toBe("high");
  });

  it("quarantines a station it could not measure", () => {
    expect(tier({ ...base, median: null })).toBe("quarantine");
  });
});
