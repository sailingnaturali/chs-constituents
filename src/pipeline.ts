import { IwlsClient, fetchProjectedSeries, type ObservedEvent } from "./client.js";
import { fit, type FittedConstituent } from "./fit.js";
import { currentEvents, type CurrentEvent } from "./events.js";
import { createTidePredictor } from "@neaps/tide-predictor";
import { validate, tier, type Tier, type ValidationResult } from "./validate.js";

/**
 * The constituent basis. Fixed rather than auto-selected: we fit published
 * predictions, so there is no noise floor to prune against, and a stable basis
 * makes bundles comparable across runs.
 *
 * Rayleigh wants ≥183 days to separate K1/P1 and S2/K2, ≥206 for N2/NU2 and
 * 2N2/MU2, and a full year for S2/T2 — `fit` reports which pairs a given series
 * cannot resolve.
 */
export const BASIS = [
  "M2", "S2", "N2", "K2", "K1", "O1", "P1", "Q1",
  "M4", "MS4", "MN4", "2N2", "MU2", "NU2", "L2", "T2",
  "J1", "MM", "MSF", "MF", "M6", "S4", "M3",
];

/** Below this the constituent is noise in the output bundle. */
const MIN_AMPLITUDE = 0.003;

export interface StationRef {
  id: string;
  label: string;
}

export interface FittedStation {
  id: string;
  name: string;
  type: "harmonic";
  source: "chs-derived";
  floodDirection: number;
  ebbDirection: number;
  offset: number;
  constituents: FittedConstituent[];
  rms: number;
  trainingDays: number;
  validation?: ValidationResult;
  tier?: Tier;
}

export interface FitStationOptions {
  start: Date;
  days: number;
  validateFrom?: Date;
  validateDays?: number;
  onProgress?: (message: string) => void;
}

const slug = (label: string) =>
  "chs-" + label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/**
 * Fetch, fit, and optionally validate one station.
 *
 * Returns null when the series is too sparse to be worth fitting — a station
 * with holes produces a plausible-looking bundle entry that is quietly wrong,
 * which is worse than a missing one.
 */
export async function fitStation(
  client: IwlsClient,
  station: StationRef,
  { start, days, validateFrom, validateDays = 7, onProgress = () => {} }: FitStationOptions,
): Promise<FittedStation | null> {
  const meta = await client.metadata(station.id);
  const samples = await fetchProjectedSeries(
    client,
    station.id,
    meta.floodDirection,
    start,
    days,
  );

  // wcsp1 is 15-minute sampled, so ~96 samples/day.
  const minimum = Math.floor(days * 96 * 0.6);
  if (samples.length < minimum) {
    onProgress(`  SKIP: only ${samples.length} samples (need ${minimum})`);
    return null;
  }

  const result = fit(samples, { constituents: BASIS });
  const constituents = result.constituents.filter((c) => c.amplitude > MIN_AMPLITUDE);

  if (result.unseparable.length) {
    const worst = result.unseparable[0];
    onProgress(
      `  note: ${result.unseparable.length} unseparable pair(s) at ${days}d, worst ` +
        `${worst.constituents.join("/")} needs ${worst.requiredDays}d`,
    );
  }
  onProgress(`  ${constituents.length} constituents, RMS ${result.rms.toFixed(3)} kn`);

  const fitted: FittedStation = {
    id: slug(station.label),
    name: station.label,
    type: "harmonic",
    source: "chs-derived",
    floodDirection: meta.floodDirection,
    ebbDirection: meta.ebbDirection,
    offset: result.offset,
    constituents,
    rms: result.rms,
    trainingDays: days,
  };

  if (validateFrom) {
    const end = new Date(validateFrom.getTime() + validateDays * 86_400_000);
    const observed: ObservedEvent[] = await client.events(station.id, validateFrom, end);
    const predicted: CurrentEvent[] = currentEvents(constituents, {
      start: validateFrom,
      end,
      offset: result.offset,
    });
    // The direction test needs velocity at arbitrary instants, not only at
    // turning points, so it reads the predictor directly.
    const predictor = createTidePredictor(constituents);
    const velocityAt = (time: Date) =>
      predictor.getWaterLevelAtTime({ time }).level + result.offset;

    fitted.validation = validate(predicted, observed, velocityAt);
    fitted.tier = tier(fitted.validation);
    onProgress(
      `  ${fitted.tier}: median ${fitted.validation.median} min, ` +
        `slack ${fitted.validation.slackMedian} min, ` +
        `${fitted.validation.wrongSign}/${fitted.validation.extrema} wrong sign`,
    );
  }

  return fitted;
}
