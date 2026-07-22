#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { IwlsClient, type ChunkCache } from "./client.js";
import { fitStation, type FittedStation, type StationRef } from "./pipeline.js";
import { registryOverlay, stationsFromApi } from "./registry.js";
import { MATCH_WINDOW_MIN } from "./validate.js";

const NOTE =
  "Derived from CHS IWLS predictions for personal, non-commercial use. Contains " +
  "Canadian Hydrographic Service intellectual property; Crown copyright is retained " +
  "by His Majesty the King in Right of Canada. NOT FOR NAVIGATION. Do not " +
  "redistribute — see README.md.";

function fileCache(dir: string): ChunkCache {
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

function arg(argv: string[], name: string, fallback?: string): string | undefined {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : argv[at + 1];
}

/**
 * The station list to fit. Defaults to every live CHS current station from the
 * IWLS index, with names/keys overlaid from the shared registry; `--stations`
 * still takes a `{id,label}[]` file for stations the index or overlay misses.
 * `--only` filters by (overlaid) label substring.
 */
export async function resolveStations(
  client: IwlsClient,
  opts: { stationsFile?: string; only: string[] },
): Promise<StationRef[]> {
  let stations: StationRef[] = opts.stationsFile
    ? JSON.parse(await readFile(opts.stationsFile, "utf8"))
    : stationsFromApi(await client.stations(), registryOverlay());
  if (opts.only.length) {
    stations = stations.filter((s) => opts.only.some((w) => s.label.toLowerCase().includes(w)));
  }
  return stations;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  if (argv.includes("--help")) {
    console.log(
      `chs-constituents — fit tidal-current constituents from CHS IWLS predictions.

You must run this yourself; the output cannot be redistributed. See README.md.

  --stations <path>       JSON list of {id, label} to fit instead of the live
                          IWLS index (default: every live CHS current station,
                          names improved via @sailingnaturali/station-corrections)
  --output <path>         Bundle path (default: currents.json)
  --training-days <n>     Series length (default: 210 — see Rayleigh note in pipeline.ts)
  --training-start <date> UTC start, YYYY-MM-DD (default: 2025-07-01)
  --validate-from <date>  UTC date to begin out-of-sample validation
  --validate-days <n>     Validation window (default: 7)
  --cache-dir <path>      Where to cache fetched chunks (default: .cache)
  --request-interval <s>  Seconds between requests (default: 2.5)
  --only <text>           Only stations whose label contains this (repeatable)`,
    );
    return 0;
  }

  const stationsPath = arg(argv, "stations");
  const outputPath = arg(argv, "output", "currents.json")!;
  const trainingDays = Number(arg(argv, "training-days", "210"));
  const trainingStart = arg(argv, "training-start", "2025-07-01")!;
  const validateFrom = arg(argv, "validate-from");
  const validateDays = Number(arg(argv, "validate-days", "7"));
  const cacheDir = arg(argv, "cache-dir", ".cache")!;
  const requestInterval = Number(arg(argv, "request-interval", "2.5"));

  const only = argv.reduce<string[]>((acc, value, i) => {
    if (value === "--only") acc.push(argv[i + 1].toLowerCase());
    return acc;
  }, []);

  const client = new IwlsClient({
    cache: fileCache(cacheDir),
    requestIntervalMs: requestInterval * 1000,
    userAgent: "chs-constituents/1.0",
    onProgress: (message) => console.error(`  ${message}`),
  });

  const stations = await resolveStations(client, { stationsFile: stationsPath, only });
  if (!stations.length) {
    console.error(
      stationsPath
        ? `No stations in ${stationsPath}`
        : only.length
          ? "No stations matched --only"
          : "No current stations returned by IWLS (check network / api-iwls.dfo-mpo.gc.ca)",
    );
    return 1;
  }

  const start = new Date(`${trainingStart}T00:00:00Z`);
  const fitted: FittedStation[] = [];
  for (const station of stations) {
    console.error(`${station.label} …`);
    try {
      const result = await fitStation(client, station, {
        start,
        days: trainingDays,
        validateFrom: validateFrom ? new Date(`${validateFrom}T00:00:00Z`) : undefined,
        validateDays,
        onProgress: (message) => console.error(message),
      });
      if (result) fitted.push(result);
    } catch (error) {
      console.error(`  FAILED: ${(error as Error).message}`);
    }
  }

  const bundle: Record<string, unknown> = {
    note: NOTE,
    generated: new Date().toISOString().slice(0, 10),
    trainingDays,
    trainingStart,
  };
  if (validateFrom) {
    bundle.validationSource =
      `chs-constituents (automated), ${bundle.generated}, ` +
      `out-of-sample ${validateFrom}+${validateDays}d vs CHS wcp1-events`;
    bundle.validationNote =
      "median is the median absolute timing error over CHS extrema only, vs the " +
      `nearest same-kind predicted event (cap ${MATCH_WINDOW_MIN} min); slack timing ` +
      "is slackMedian, never pooled into the headline. Direction is tested as the " +
      "sign of modelled velocity at CHS extremum times. Tiers judge extremum timing.";
  }
  bundle.stations = fitted;

  if (!fitted.length) {
    console.error("No stations were fitted — leaving the existing output untouched");
    return 1;
  }

  await writeFile(outputPath, JSON.stringify(bundle, null, 2));
  console.error(`\nwrote ${outputPath} — ${fitted.length} stations`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code));
}
