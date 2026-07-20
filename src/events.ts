import { createTidePredictor } from "@neaps/tide-predictor";
import type { FittedConstituent } from "./fit.js";

export type CurrentEventKind = "slack" | "maxFlood" | "maxEbb";

export interface CurrentEvent {
  time: Date;
  kind: CurrentEventKind;
  /** Signed along-axis velocity: positive floods, negative ebbs. Zero at slack. */
  speed: number;
}

export interface EventOptions {
  start: Date;
  end: Date;
  /** Mean flow along the axis, added to the harmonic sum. */
  offset?: number;
  /** Reconstruction step. One minute matches what CHS publishes. */
  stepSeconds?: number;
}

/**
 * Slack water and peak flood/ebb from fitted constituents.
 *
 * Currents differ from tides in what the user actually wants: not the extremes
 * but the *zero crossings*, because slack is when a pass is transitable. So we
 * reconstruct the signed along-axis velocity and read both off it, rather than
 * reusing a tide-extremes routine that only knows about turning points.
 */
export function currentEvents(
  constituents: FittedConstituent[],
  { start, end, offset = 0, stepSeconds = 60 }: EventOptions,
): CurrentEvent[] {
  const timeline = createTidePredictor(constituents).getTimelinePrediction({
    start,
    end,
    timeFidelity: stepSeconds,
  });

  const velocity = timeline.map((point) => point.level + offset);
  const events: CurrentEvent[] = [];

  // Slack: linear interpolation across the sign change, so resolution is not
  // capped by the reconstruction step.
  const crossings: number[] = [];
  for (let i = 1; i < velocity.length; i++) {
    if (velocity[i - 1] === 0 || Math.sign(velocity[i]) === Math.sign(velocity[i - 1])) continue;
    const span = velocity[i] - velocity[i - 1];
    const fraction = span === 0 ? 0 : -velocity[i - 1] / span;
    const before = timeline[i - 1].time.getTime();
    const after = timeline[i].time.getTime();
    events.push({
      time: new Date(before + fraction * (after - before)),
      kind: "slack",
      speed: 0,
    });
    crossings.push(i - 1);
  }

  // Exactly one peak lives between consecutive slacks; its sign says which way.
  // Only fully-bounded segments count: the partial cycles at each end of the
  // window peak at the boundary, and a boundary value is where the window was
  // cut, not a turning point. Widen the window to see those.
  for (let b = 0; b < crossings.length - 1; b++) {
    const lo = crossings[b];
    const hi = crossings[b + 1];
    if (hi - lo < 2) continue;
    let peakAt = lo;
    for (let i = lo; i < hi; i++) {
      if (Math.abs(velocity[i]) > Math.abs(velocity[peakAt])) peakAt = i;
    }
    events.push({
      time: timeline[peakAt].time,
      kind: velocity[peakAt] > 0 ? "maxFlood" : "maxEbb",
      speed: velocity[peakAt],
    });
  }

  return events.sort((a, b) => a.time.getTime() - b.time.getTime());
}
