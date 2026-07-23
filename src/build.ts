// Node-only build orchestration: resolve the live station list, fit each, and
// assemble the bundle. Deliberately OUT of the browser-safe root export
// (src/index.ts reaches no node builtins) — this touches fs, cache and network.
// signalk-currents imports it via the "./build" subpath to run the fit in-process.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { IwlsClient, type ChunkCache } from "./client.js";
import { fitStation, fitTideStation, type FittedStation, type StationRef } from "./pipeline.js";
import { normalizeName, registryOverlay, stationsFromApi } from "./registry.js";
import { derivedGates, derivedSlackRecord, type DerivedSlackRecord } from "./derived.js";
import { MATCH_WINDOW_MIN } from "./validate.js";

export const NOTE =
  "Derived from CHS IWLS predictions for personal, non-commercial use. Contains " +
  "Canadian Hydrographic Service intellectual property; Crown copyright is retained " +
  "by His Majesty the King in Right of Canada. NOT FOR NAVIGATION. Do not " +
  "redistribute — see README.md.";

export function fileCache(dir: string): ChunkCache {
  return {
    async read(key) {
      try {
        return await readFile(join(dir, key), "utf8");
      } catch {
        return null;
      }
    },
    async write(key, value) {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, key), value);
    },
  };
}

/**
 * The station list to fit. Defaults to every live CHS current station from the
 * IWLS index, names/keys overlaid from the shared registry; `stationsFile` takes
 * a `{id,label}[]` file instead; `only` filters by overlaid-label substring.
 */
export async function resolveStations(
  client: IwlsClient,
  opts: { stationsFile?: string; only: string[] },
): Promise<StationRef[]> {
  let stations: StationRef[];
  if (opts.stationsFile) {
    stations = JSON.parse(await readFile(opts.stationsFile, "utf8"));
  } else {
    const overlay = registryOverlay();
    stations = stationsFromApi(await client.stations(), overlay);
    // The curated key<->station link is a name match now. Warn on any curated
    // gate that matched no live station, so an IWLS rename (or an edited
    // registry name) surfaces here instead of silently rekeying the gate to
    // slug(officialName) for every downstream consumer.
    const matchedKeys = new Set(stations.map((s) => s.key).filter(Boolean));
    for (const { key } of overlay.values()) {
      if (!matchedKeys.has(key)) {
        console.error(`registry gate ${key} found no live IWLS station (name drift?)`);
      }
    }
  }
  if (!stations.length) {
    throw new Error(
      opts.stationsFile
        ? `No stations in ${opts.stationsFile}`
        : "No current stations returned by IWLS (check network / api-iwls.dfo-mpo.gc.ca)",
    );
  }
  if (opts.only.length) {
    stations = stations.filter((s) => opts.only.some((w) => s.label.toLowerCase().includes(w)));
    if (!stations.length) throw new Error("No stations matched --only");
  }
  return stations;
}

export interface BuildBundleOptions {
  stationsFile?: string;
  only?: string[];
  trainingDays?: number;
  trainingStart?: string;
  validateFrom?: string;
  validateDays?: number;
  cacheDir?: string;
  requestIntervalMs?: number;
  userAgent?: string;
  onProgress?: (message: string) => void;
}

export async function buildBundle(opts: BuildBundleOptions = {}): Promise<Record<string, unknown>> {
  const {
    stationsFile, only = [],
    trainingDays = 210, trainingStart = "2025-07-01",
    validateFrom, validateDays = 7,
    cacheDir = ".cache", requestIntervalMs = 2500,
    userAgent = "chs-constituents/1.0", onProgress = () => {},
  } = opts;

  const client = new IwlsClient({
    cache: fileCache(cacheDir),
    requestIntervalMs,
    userAgent,
    onProgress: (message) => onProgress(`  ${message}`),
  });

  const stations = await resolveStations(client, { stationsFile, only });

  const start = new Date(`${trainingStart}T00:00:00Z`);
  const fitted: FittedStation[] = [];
  // Dropped stations go in the bundle, not just stderr — coverage stays
  // auditable after the run (the built JSON is the only surviving artifact).
  const skipped: { label: string; key?: string; reason: string }[] = [];
  for (const [i, station] of stations.entries()) {
    onProgress(`[${i + 1}/${stations.length}] ${station.label} …`);
    try {
      const result = await fitStation(client, station, {
        start,
        days: trainingDays,
        validateFrom: validateFrom ? new Date(`${validateFrom}T00:00:00Z`) : undefined,
        validateDays,
        onProgress: (message) => onProgress(message),
      });
      if (result) fitted.push(result);
      else skipped.push({ label: station.label, ...(station.key && { key: station.key }), reason: "insufficient samples" });
    } catch (error) {
      onProgress(`  FAILED: ${(error as Error).message}`);
      skipped.push({ label: station.label, ...(station.key && { key: station.key }), reason: (error as Error).message });
    }
  }

  // Derived gates (Malibu Rapids): passes with no current station of their own.
  // Fit each gate's reference tide port once (a water-level fit) and emit a
  // derived-slack record pointing at it; a consumer predicts that tide offline
  // and derives slack from its HW/LW + the lags.
  const gates = derivedGates();
  const derivedRecords: DerivedSlackRecord[] = [];
  if (gates.length) {
    const tideByName = new Map(
      (await client.tideStations()).map((s) => [normalizeName(s.officialName), s]),
    );
    const fittedRefs = new Set(fitted.map((s) => s.id));
    for (const gate of gates) {
      if (!fittedRefs.has(gate.referenceKey)) {
        const live = tideByName.get(normalizeName(gate.referenceName));
        if (!live) {
          onProgress(`derived gate ${gate.key}: no live IWLS tide station for ${gate.referenceName}`);
          skipped.push({ label: gate.referenceName, key: gate.referenceKey, reason: "no live IWLS tide station" });
          continue;
        }
        onProgress(`derived reference ${gate.referenceName} (${gate.key}) …`);
        try {
          const ref = await fitTideStation(
            client,
            { id: live.id, label: gate.referenceName, key: gate.referenceKey },
            { start, days: trainingDays, onProgress },
          );
          if (!ref) {
            skipped.push({ label: gate.referenceName, key: gate.referenceKey, reason: "insufficient water-level samples" });
            continue;
          }
          fitted.push(ref);
          fittedRefs.add(gate.referenceKey);
        } catch (error) {
          onProgress(`  FAILED: ${(error as Error).message}`);
          skipped.push({ label: gate.referenceName, key: gate.referenceKey, reason: (error as Error).message });
          continue;
        }
      }
      derivedRecords.push(derivedSlackRecord(gate));
    }
  }

  if (!fitted.length) throw new Error("No stations were fitted");

  const generated = new Date().toISOString().slice(0, 10);
  const bundle: Record<string, unknown> = { note: NOTE, generated, trainingDays, trainingStart };
  if (validateFrom) {
    bundle.validationSource =
      `chs-constituents (automated), ${generated}, ` +
      `out-of-sample ${validateFrom}+${validateDays}d vs CHS wcp1-events`;
    bundle.validationNote =
      "median is the median absolute timing error over CHS extrema only, vs the " +
      `nearest same-kind predicted event (cap ${MATCH_WINDOW_MIN} min); slack timing ` +
      "is slackMedian, never pooled into the headline. Direction is tested as the " +
      "sign of modelled velocity at CHS extremum times. Tiers judge extremum timing.";
  }
  if (skipped.length) bundle.skipped = skipped;
  bundle.stations = [...fitted, ...derivedRecords];
  return bundle;
}
