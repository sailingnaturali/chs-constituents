import { describe, it, expect } from "vitest";
import { currentEvents } from "../src/events.js";

const start = new Date("2026-03-01T00:00:00Z");
const end = new Date("2026-03-04T00:00:00Z");
/** Pure M2: a clean reversing pass, slack every half period. */
const M2_ONLY = [{ name: "M2", amplitude: 4, phase: 0 }];

describe("currentEvents", () => {
  it("alternates slack, peak, slack, peak", () => {
    const events = currentEvents(M2_ONLY, { start, end });
    const kinds = events.map((e) => e.kind);
    for (let i = 1; i < kinds.length; i++) {
      const wasSlack = kinds[i - 1] === "slack";
      expect(kinds[i] === "slack").toBe(!wasSlack);
    }
    expect(new Set(kinds)).toEqual(new Set(["slack", "maxFlood", "maxEbb"]));
  });

  it("puts slack half an M2 period apart", () => {
    const slacks = currentEvents(M2_ONLY, { start, end }).filter((e) => e.kind === "slack");
    // M2 period is 12.4206 h, so reversals come every 6.2103 h.
    for (let i = 1; i < slacks.length; i++) {
      const hours = (slacks[i].time.getTime() - slacks[i - 1].time.getTime()) / 3_600_000;
      expect(hours).toBeCloseTo(6.2103, 2);
    }
  });

  it("interpolates slack finer than the reconstruction step", () => {
    // A one-minute grid would quantise slack to the minute; interpolation should
    // put these two runs within seconds of each other, not within a minute.
    const coarse = currentEvents(M2_ONLY, { start, end, stepSeconds: 300 });
    const fine = currentEvents(M2_ONLY, { start, end, stepSeconds: 60 });
    const drift = Math.abs(coarse[0].time.getTime() - fine[0].time.getTime()) / 1000;
    expect(drift).toBeLessThan(10);
  });

  it("signs peaks by direction, and reports the actual peak speed", () => {
    const events = currentEvents(M2_ONLY, { start, end });
    const flood = events.find((e) => e.kind === "maxFlood")!;
    const ebb = events.find((e) => e.kind === "maxEbb")!;
    expect(flood.speed).toBeGreaterThan(0);
    expect(ebb.speed).toBeLessThan(0);
    // Not exactly 4: the nodal factor modulates M2 by a few percent over the
    // 18.6-year cycle, so the peak is 4·f at this date.
    expect(Math.abs(flood.speed)).toBeGreaterThan(3.8);
    expect(Math.abs(flood.speed)).toBeLessThan(4.2);
    expect(Math.abs(ebb.speed)).toBeCloseTo(Math.abs(flood.speed), 2);
  });

  it("shifts slack when a mean flow offsets the axis", () => {
    // A pass with net outflow spends longer ebbing: slack count drops or moves.
    const centred = currentEvents(M2_ONLY, { start, end }).filter((e) => e.kind === "slack");
    const offset = currentEvents(M2_ONLY, { start, end, offset: 2 }).filter(
      (e) => e.kind === "slack",
    );
    expect(offset.length).toBe(centred.length);
    expect(offset[0].time.getTime()).not.toBe(centred[0].time.getTime());
    // With +2 kn on a 4 kn amplitude, flood runs long and ebb runs short —
    // the asymmetry every fast pass has, and the reason slack windows matter.
    const spans = offset
      .slice(1)
      .map((s, i) => (s.time.getTime() - offset[i].time.getTime()) / 3_600_000);
    expect(Math.max(...spans)).toBeGreaterThan(6.2103);
    expect(Math.min(...spans)).toBeLessThan(6.2103);
  });
});
