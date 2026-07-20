import type { ObservedEvent } from "./client.js";
import type { CurrentEvent } from "./events.js";

/**
 * A same-kind event further than this from its counterpart is a different tidal
 * cycle, not a match. Without the cap a badly-timed station scores well by
 * accidentally pairing with the next cycle's event.
 */
export const MATCH_WINDOW_MIN = 180;

/**
 * Fraction of extrema with the wrong sign above which the flood axis is judged
 * reversed. Deliberately high: a genuinely reversed axis disagrees at nearly
 * EVERY extremum, because the error is systematic. Partial disagreement means
 * something else — usually timing error at a weak, slow-reversing station, where
 * a large slack error spends long windows on the wrong side of zero. Juan de
 * Fuca East was false-quarantined at 0.20 (7/27) when its axis is correct and
 * documented.
 */
export const FLIP_QUARANTINE = 0.6;

const TIERS: [number, Tier][] = [
  [5, "high"],
  [20, "medium"],
  [35, "low"],
];

export type Tier = "high" | "medium" | "low" | "quarantine";

export interface ValidationResult {
  /** Median absolute timing error over extrema, in minutes. The headline. */
  median: number | null;
  max: number | null;
  /** Slack timing, kept apart from the headline — see below. */
  slackMedian: number | null;
  wrongSign: number;
  extrema: number;
  matched: number;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length / 2;
  return sorted.length % 2
    ? sorted[Math.floor(mid)]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Compare predicted events against CHS's own published events, out of sample.
 *
 * Three measures, deliberately kept apart:
 *
 * - TIMING — distance to the nearest predicted event *of the same kind*,
 *   extrema only. This is the headline and what the tier judges. Max is
 *   inflated by CHS's own continuous-vs-event disagreement (15–30 min at
 *   complex narrows), a property of the source data rather than of the fit.
 *
 * - SLACK TIMING — same matching, slack only, reported separately and never
 *   pooled into the headline. At weak, slow-reversing stations the zero
 *   crossing is hypersensitive to small level errors (Juan de Fuca East runs
 *   ~17 min on extrema and far worse on slacks), and pooling once produced a
 *   median no extrema-only harness could reproduce.
 *
 * - DIRECTION — the sign of modelled velocity at the moment CHS reports maximum
 *   flood or ebb. This is the only sound flip test. Comparing against the
 *   nearest predicted event of *any* kind conflates bad timing with a reversed
 *   axis, and false-quarantined three good stations.
 */
export function validate(
  predicted: CurrentEvent[],
  observed: ObservedEvent[],
  velocityAt: (time: Date) => number,
  significant = 0.75,
): ValidationResult {
  if (!predicted.length) {
    return { median: null, max: null, slackMedian: null, wrongSign: 0, extrema: 0, matched: 0 };
  }

  const deltas: number[] = [];
  const slackDeltas: number[] = [];

  for (const event of observed) {
    // Slacks always count; extrema only when the current is actually running.
    if (event.kind !== "slack" && Math.abs(event.speed) < significant) continue;
    const at = Date.parse(event.time);
    let best = Infinity;
    for (const candidate of predicted) {
      if (candidate.kind !== event.kind) continue;
      best = Math.min(best, Math.abs(candidate.time.getTime() - at) / 60_000);
    }
    if (best <= MATCH_WINDOW_MIN) {
      (event.kind === "slack" ? slackDeltas : deltas).push(best);
    }
  }

  const extrema = observed.filter((e) => e.kind !== "slack");
  let wrongSign = 0;
  for (const event of extrema) {
    const modelled = velocityAt(new Date(event.time));
    if (
      (event.kind === "maxFlood" && modelled < 0) ||
      (event.kind === "maxEbb" && modelled > 0)
    ) {
      wrongSign++;
    }
  }

  const timing = median(deltas);
  return {
    median: timing === null ? null : Math.round(timing * 10) / 10,
    max: deltas.length ? Math.round(Math.max(...deltas) * 10) / 10 : null,
    slackMedian: (() => {
      const value = median(slackDeltas);
      return value === null ? null : Math.round(value * 10) / 10;
    })(),
    wrongSign,
    extrema: extrema.length,
    matched: deltas.length + slackDeltas.length,
  };
}

/**
 * Assign a confidence tier.
 *
 * A reversed axis outranks good timing: a current predicted backwards is worse
 * than one predicted late, because the crew acts on direction.
 */
export function tier(result: ValidationResult): Tier {
  if (result.median === null) return "quarantine";
  if (result.extrema && result.wrongSign / result.extrema >= FLIP_QUARANTINE) return "quarantine";
  for (const [threshold, name] of TIERS) {
    if (result.median <= threshold) return name;
  }
  return "quarantine";
}
