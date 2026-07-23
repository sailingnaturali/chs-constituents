#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { buildBundle } from "./build.js";

// Re-exported so the Phase 1 test (test/resolve-stations.test.ts) keeps importing
// it from "./cli.js" while the implementation now lives in build.ts.
export { resolveStations } from "./build.js";

function arg(argv: string[], name: string, fallback?: string): string | undefined {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : argv[at + 1];
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
  --user-agent <string>   User-Agent header (default: chs-constituents/1.0;
                          CHS sometimes refuses non-browser UAs — see README)
  --only <text>           Only stations whose label contains this (repeatable)`,
    );
    return 0;
  }

  const outputPath = arg(argv, "output", "currents.json")!;
  const only = argv.reduce<string[]>((acc, value, i) => {
    if (value === "--only") acc.push(argv[i + 1].toLowerCase());
    return acc;
  }, []);

  let bundle: Record<string, unknown>;
  try {
    bundle = await buildBundle({
      stationsFile: arg(argv, "stations"),
      only,
      trainingDays: Number(arg(argv, "training-days", "210")),
      trainingStart: arg(argv, "training-start", "2025-07-01")!,
      validateFrom: arg(argv, "validate-from"),
      validateDays: Number(arg(argv, "validate-days", "7")),
      cacheDir: arg(argv, "cache-dir", ".cache")!,
      requestIntervalMs: Number(arg(argv, "request-interval", "2.5")) * 1000,
      userAgent: arg(argv, "user-agent"),
      onProgress: (message) => console.error(message),
    });
  } catch (e) {
    const msg = (e as Error).message;
    console.error(
      msg === "No stations were fitted"
        ? "No stations were fitted — leaving the existing output untouched"
        : msg,
    );
    return 1;
  }

  await writeFile(outputPath, JSON.stringify(bundle, null, 2));
  console.error(`\nwrote ${outputPath} — ${(bundle.stations as unknown[]).length} stations`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code));
}
