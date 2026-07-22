# Phase 1: Fetch the Station List Live from CHS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `chs-constituents` fetch its own station list live from the CHS IWLS API, so it no longer depends on `@sailingnaturali/station-corrections` supplying the CHS station **id** — the registry becomes a name/metadata *overlay*, not the id source.

**Architecture:** Today `src/registry.ts` reads the shared registry and maps `providerId → StationRef.id` (the handle `IwlsClient` fetches with). This plan adds `IwlsClient.stations()` to pull all current stations live from IWLS (`GET /stations`, filtered to those publishing a `wcsp1` current-speed series — ~30 of ~1570). The registry is re-cast as a `name → {key, label}` overlay, matched to a live station by normalized name, supplying only the stable public key and cleaned display name. The CHS id flows from the live index straight into `fitStation` and is used *only* to fetch — it never appears in the output bundle, which is keyed by the public slug/key as it already is. After this, the registry can drop `providerId` (Phase 2) without breaking anything here.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node ≥ 18 (global `fetch`), vitest.

## Global Constraints

- **ESM import specifiers carry `.js`** even for `.ts` sources (e.g. `from "./client.js"`). Match the existing style.
- **Tests live in `test/`**, run with `npm test` (`vitest run --exclude "**/compare_events.test.ts"`).
- **No CHS-derived data is ever committed.** Station **ids** and **names** are identifiers and facts, not derived predictions — those are fine to handle in code (the existing `registry.ts` header says so). The fitted constituents that `fitStation` produces are the operator's local, non-redistributed output (already carried by the `NOTE` in `cli.ts`). This plan commits neither.
- **The CHS id must not become a new committed artifact.** It is fetched live and used only as a fetch handle; do not write it into any file under version control.
- **`StationRef` shape is fixed** (`src/pipeline.ts`): `{ id: string; label: string; key?: string }`. `id` is the IWLS fetch handle; `key` (optional) is the stable public id; when `key` is absent `fitStation` derives `slug(label)`.

---

### Task 1: List current stations live from IWLS

**Files:**
- Modify: `src/client.ts` (add `IwlsStation`, `currentStations`, `IwlsClient.stations`)
- Test: `test/stations.test.ts` (create)

**Interfaces:**
- Consumes: nothing new — uses the existing `IwlsClient.get<T>(path)` seam.
- Produces:
  - `export interface IwlsStation { id: string; officialName: string; latitude: number; longitude: number; operating: boolean }`
  - `export function currentStations(raw: RawStation[]): IwlsStation[]` — pure filter/shaper.
  - `IwlsClient.stations(): Promise<IwlsStation[]>` — fetches `GET /stations` and returns the current-station subset.

- [ ] **Step 1: Write the failing test**

Create `test/stations.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { IwlsClient, currentStations } from "../src/client.js";

// Trimmed to the fields the code reads. The IWLS index carries ~1570 stations;
// only those publishing a wcsp1 (water-current speed) series are current
// stations the fitting pipeline can use.
const RAW = [
  {
    id: "wl1", officialName: "Tasiujaq", latitude: 58.7, longitude: -69.8, operating: false,
    timeSeries: [{ code: "wlo" }, { code: "wlp" }],
  },
  {
    id: "cur1", officialName: "Dodd Narrows", latitude: 49.1344, longitude: -123.8171, operating: true,
    timeSeries: [{ code: "wcsp1" }, { code: "wcdp1" }, { code: "wcp1-events" }],
  },
  {
    id: "cur2", officialName: "Active Pass", latitude: 48.8604, longitude: -123.3128, operating: true,
    timeSeries: [{ code: "wcsp1" }],
  },
];

describe("currentStations", () => {
  it("keeps only stations that publish a wcsp1 series", () => {
    expect(currentStations(RAW as never).map((s) => s.id)).toEqual(["cur1", "cur2"]);
  });

  it("shapes each station to id/officialName/lat/lon/operating", () => {
    const [dodd] = currentStations(RAW as never);
    expect(dodd).toEqual({
      id: "cur1", officialName: "Dodd Narrows",
      latitude: 49.1344, longitude: -123.8171, operating: true,
    });
  });

  it("survives a station with no timeSeries array", () => {
    const raw = [{ id: "x", officialName: "X", latitude: 0, longitude: 0, operating: false }];
    expect(currentStations(raw as never)).toEqual([]);
  });
});

describe("IwlsClient.stations", () => {
  it("filters the fetched index to current stations", async () => {
    const client = new IwlsClient({ requestIntervalMs: 0 });
    // Same seam the existing client tests use: override get() to skip the network.
    (client as unknown as { get: () => Promise<unknown> }).get = async () => RAW;
    const out = await client.stations();
    expect(out.map((s) => s.officialName)).toEqual(["Dodd Narrows", "Active Pass"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/stations.test.ts`
Expected: FAIL — `currentStations` is not exported / `client.stations is not a function`.

- [ ] **Step 3: Implement in `src/client.ts`**

Add near the other interfaces (after `StationMetadata`):

```ts
/** A station as the IWLS /stations index lists it, trimmed to what we use. */
export interface IwlsStation {
  id: string;
  officialName: string;
  latitude: number;
  longitude: number;
  operating: boolean;
}

/** The raw /stations element shape — only the fields we read. */
interface RawStation {
  id: string;
  officialName: string;
  latitude: number;
  longitude: number;
  operating: boolean;
  timeSeries?: { code: string }[];
}

/**
 * Keep only current stations: those that publish a water-current speed series
 * (`wcsp1`), which `fetchProjectedSeries` needs. Of ~1570 IWLS stations only
 * ~30 are current stations; the rest are water-level and have no wcsp1/wcdp1
 * to project onto a flood axis.
 */
export function currentStations(raw: RawStation[]): IwlsStation[] {
  return raw
    .filter((s) => (s.timeSeries ?? []).some((t) => t.code === "wcsp1"))
    .map(({ id, officialName, latitude, longitude, operating }) => ({
      id, officialName, latitude, longitude, operating,
    }));
}
```

Add this method to the `IwlsClient` class (next to `metadata`):

```ts
  /** Every CHS current station, live from the IWLS index. */
  async stations(): Promise<IwlsStation[]> {
    return currentStations(await this.get<RawStation[]>("stations"));
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/stations.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/client.ts test/stations.test.ts
git commit -m "feat(client): list current stations live from IWLS /stations"
```

---

### Task 2: Recast the registry as a name overlay (no id)

**Files:**
- Modify: `src/registry.ts` (replace `registryStations`/`mapRegistry` with `normalizeName`/`registryOverlay`/`stationsFromApi`)
- Test: `test/registry.test.ts` (rewrite)

**Interfaces:**
- Consumes: `IwlsStation` from Task 1; `StationRef` from `src/pipeline.ts`.
- Produces:
  - `export function normalizeName(name: string): string`
  - `export interface OverlayEntry { key: string; label: string }`
  - `export function registryOverlay(data?, provider?): Map<string, OverlayEntry>` — keyed by normalized name; reads only `name` + object key, **never `providerId`**.
  - `export function stationsFromApi(stations: IwlsStation[], overlay: Map<string, OverlayEntry>): StationRef[]`
- **Removed:** `registryStations`, `mapRegistry` (they mapped `providerId → id`, the coupling this whole phase removes).

- [ ] **Step 1: Write the failing test** — rewrite `test/registry.test.ts` entirely:

```ts
import { describe, it, expect } from "vitest";
import { normalizeName, registryOverlay, stationsFromApi } from "../src/registry.js";

describe("normalizeName", () => {
  it("folds case, punctuation and spacing so provider names match curated ones", () => {
    expect(normalizeName("DODD NARROWS")).toBe("dodd narrows");
    expect(normalizeName("Hole in the Wall")).toBe("hole in the wall");
    expect(normalizeName("Juan de Fuca - East")).toBe("juan de fuca east");
  });
});

describe("registryOverlay", () => {
  it("keys entries by normalized name and reads no id at all", () => {
    // No providerId field anywhere — proves the overlay is forward-compatible
    // with the registry dropping providerId in Phase 2.
    const overlay = registryOverlay(
      { "chs-dodd-narrows": { name: "Dodd Narrows", provider: "chs" } },
      "chs",
    );
    expect(overlay.get("dodd narrows")).toEqual({ key: "chs-dodd-narrows", label: "Dodd Narrows" });
  });

  it("only includes the requested provider", () => {
    const overlay = registryOverlay(
      { "chs-x": { name: "X", provider: "chs" }, "noaa-y": { name: "Y", provider: "noaa" } },
      "chs",
    );
    expect([...overlay.keys()]).toEqual(["x"]);
  });

  it("refuses an entry with an empty key or name", () => {
    expect(() => registryOverlay({ "": { name: "X", provider: "chs" } })).toThrow(/empty/);
    expect(() => registryOverlay({ "chs-x": { name: "", provider: "chs" } })).toThrow(/empty/);
  });

  it("includes the real bundled CHS gates (guards a silent rename)", () => {
    const overlay = registryOverlay();
    expect(overlay.get("dodd narrows")?.key).toBe("chs-dodd-narrows");
    expect(overlay.size).toBeGreaterThanOrEqual(19);
  });
});

describe("stationsFromApi", () => {
  const overlay = registryOverlay(
    { "chs-dodd-narrows": { name: "Dodd Narrows", provider: "chs" } },
    "chs",
  );

  it("takes id from the live station, key+label from the overlay when the name matches", () => {
    const refs = stationsFromApi(
      [{ id: "63aef1866a2b9417c035030f", officialName: "DODD NARROWS", latitude: 49.1, longitude: -123.8, operating: true }],
      overlay,
    );
    expect(refs).toEqual([{ id: "63aef1866a2b9417c035030f", label: "Dodd Narrows", key: "chs-dodd-narrows" }]);
  });

  it("falls back to the official name and no key when unmatched (pipeline slugs it)", () => {
    const refs = stationsFromApi(
      [{ id: "abc", officialName: "Somewhere New", latitude: 0, longitude: 0, operating: true }],
      overlay,
    );
    expect(refs).toEqual([{ id: "abc", label: "Somewhere New" }]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/registry.test.ts`
Expected: FAIL — `normalizeName`/`registryOverlay`/`stationsFromApi` not exported.

- [ ] **Step 3: Rewrite `src/registry.ts`**

Replace the whole file with:

```ts
import registry from "@sailingnaturali/station-corrections/data/registry.json" with { type: "json" };
import type { StationRef } from "./pipeline.js";
import type { IwlsStation } from "./client.js";

/**
 * The registry as a name/metadata overlay, not the station id source.
 *
 * Station ids now come live from the IWLS index (`IwlsClient.stations`); the
 * shared registry supplies only the stable public key and the cleaned display
 * name, matched to a live station by normalized name. `providerId` is
 * deliberately NOT read here — the registry package is dropping it (Phase 2),
 * and nothing in this repo may depend on it.
 *
 * No CHS-derived data is involved: these are identifiers and hand-written
 * names, not predictions or constituents.
 */
interface RegistryEntry {
  name: string;
  provider: string;
}

/** Fold case, punctuation and spacing so "DODD NARROWS" matches "Dodd Narrows". */
export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export interface OverlayEntry {
  key: string;
  label: string;
}

/**
 * Build a `normalizedName -> {key, label}` overlay from the shared registry,
 * filtered to one provider. Reads only the object key and `name`; an empty
 * key or name is refused at the source rather than silently detaching a gate
 * from its live station.
 */
export function registryOverlay(
  data: Record<string, RegistryEntry> = registry as Record<string, RegistryEntry>,
  provider = "chs",
): Map<string, OverlayEntry> {
  const overlay = new Map<string, OverlayEntry>();
  for (const [key, entry] of Object.entries(data)) {
    if (entry.provider !== provider) continue;
    if (!key?.trim() || !entry.name?.trim()) {
      throw new Error(`registry entry ${JSON.stringify(key)} has an empty key or name`);
    }
    overlay.set(normalizeName(entry.name), { key, label: entry.name });
  }
  return overlay;
}

/**
 * Resolve live IWLS current stations to StationRefs. The id is the live IWLS
 * handle (used only to fetch, never emitted); a name match in the overlay
 * upgrades the label to the curated name and supplies the stable key. An
 * unmatched station keeps its official name and no key, so `fitStation`
 * derives a slug from the label.
 */
export function stationsFromApi(
  stations: IwlsStation[],
  overlay: Map<string, OverlayEntry>,
): StationRef[] {
  return stations.map((s) => {
    const hit = overlay.get(normalizeName(s.officialName));
    return hit ? { id: s.id, label: hit.label, key: hit.key } : { id: s.id, label: s.officialName };
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify nothing else imports the removed functions**

Run: `grep -rn "registryStations\|mapRegistry" src test`
Expected: only `src/cli.ts` still references `registryStations` (fixed in Task 3). If anything else appears, it must be updated before this task's commit — but per the current tree only `cli.ts` and the (now-rewritten) test used them.

- [ ] **Step 6: Commit**

```bash
git add src/registry.ts test/registry.test.ts
git commit -m "refactor(registry): recast as a name overlay, drop providerId dependency"
```

---

### Task 3: Default the CLI to the live station list

**Files:**
- Modify: `src/cli.ts` (extract `resolveStations`, reorder to build the client first, update `--help`, guard the auto-exec so the module is importable in tests)
- Test: `test/resolve-stations.test.ts` (create)

**Interfaces:**
- Consumes: `IwlsClient` (Task 1), `registryOverlay`/`stationsFromApi` (Task 2), `StationRef`.
- Produces: `export async function resolveStations(client: IwlsClient, opts: { stationsFile?: string; only: string[] }): Promise<StationRef[]>`

- [ ] **Step 1: Write the failing test**

Create `test/resolve-stations.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { IwlsClient } from "../src/client.js";
import { resolveStations } from "../src/cli.js";

function clientWith(stations: unknown[]): IwlsClient {
  const c = new IwlsClient({ requestIntervalMs: 0 });
  (c as unknown as { stations: () => Promise<unknown> }).stations = async () => stations;
  return c;
}

describe("resolveStations", () => {
  it("defaults to live current stations, name-overlaid from the registry", async () => {
    const client = clientWith([
      { id: "63aef1866a2b9417c035030f", officialName: "DODD NARROWS", latitude: 49.1, longitude: -123.8, operating: true },
    ]);
    const out = await resolveStations(client, { only: [] });
    expect(out[0]).toEqual({ id: "63aef1866a2b9417c035030f", label: "Dodd Narrows", key: "chs-dodd-narrows" });
  });

  it("applies --only against the overlaid label", async () => {
    const client = clientWith([
      { id: "a", officialName: "Dodd Narrows", latitude: 0, longitude: 0, operating: true },
      { id: "b", officialName: "Active Pass", latitude: 0, longitude: 0, operating: true },
    ]);
    const out = await resolveStations(client, { only: ["active"] });
    expect(out.map((s) => s.label)).toEqual(["Active Pass"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/resolve-stations.test.ts`
Expected: FAIL — `resolveStations` is not exported. (If the import instead *runs the CLI*, that is what Step 3's auto-exec guard fixes.)

- [ ] **Step 3: Edit `src/cli.ts`**

3a. Update the imports at the top:

```ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { IwlsClient, type ChunkCache } from "./client.js";
import { fitStation, type FittedStation, type StationRef } from "./pipeline.js";
import { registryOverlay, stationsFromApi } from "./registry.js";
import { MATCH_WINDOW_MIN } from "./validate.js";
```

3b. Add `resolveStations` above `main` (after the `arg` helper):

```ts
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
```

3c. In `main`, build the client **before** resolving stations, then replace the old station-resolution block. The old block is:

```ts
  const stationsPath = arg(argv, "stations");
  // ... other arg parsing ...
  let stations: StationRef[] = stationsPath
    ? JSON.parse(await readFile(stationsPath, "utf8"))
    : registryStations();
  if (!stations.length) {
    console.error(
      stationsPath
        ? `No stations in ${stationsPath}`
        : "No stations returned by the registry (check @sailingnaturali/station-corrections " +
            "is installed and its provider field still matches)",
    );
    return 1;
  }
  if (only.length) {
    stations = stations.filter((s) => only.some((w) => s.label.toLowerCase().includes(w)));
    if (!stations.length) {
      console.error("No stations matched --only");
      return 1;
    }
  }

  const client = new IwlsClient({
    cache: fileCache(cacheDir),
    requestIntervalMs: requestInterval * 1000,
    userAgent: "chs-constituents/1.0",
    onProgress: (message) => console.error(`  ${message}`),
  });
```

Replace it with (client first, then resolve):

```ts
  const stationsPath = arg(argv, "stations");
  // ... other arg parsing stays exactly as-is (trainingDays, trainingStart, etc.) ...

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
```

Leave the `const only = argv.reduce(...)` parsing where it is (it must be declared before the `resolveStations` call). The rest of `main` (the `fitStation` loop, bundle assembly, write) is unchanged.

3d. Update the `--help` text for `--stations`:

```ts
  --stations <path>       JSON list of {id, label} to fit instead of the live
                          IWLS index (default: every live CHS current station,
                          names improved via @sailingnaturali/station-corrections)
```

3e. Guard the auto-exec at the bottom so importing the module in a test does not run the CLI. Replace:

```ts
main().then((code) => process.exit(code));
```

with:

```ts
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code));
}
```

- [ ] **Step 4: Run the new test to verify it passes**

Run: `npx vitest run test/resolve-stations.test.ts`
Expected: PASS (2 tests), and no CLI output printed on import.

- [ ] **Step 5: Run the full suite + typecheck**

Run: `npm test && npm run build`
Expected: all tests PASS, `tsc` clean. (`npm run build` is `tsc`; it catches the dropped-import and any type drift.)

- [ ] **Step 6: Smoke-test against the live API (one station)**

Run: `npm run fit -- --only "Active Pass" --training-days 30`
Expected: prints `Active Pass …`, fetches, and writes `currents.json` with one fitted station. This proves the live `stations()` → overlay → `fitStation` path end to end. (Uses the network under your own CHS licence; it caches to `.cache`.)

- [ ] **Step 7: Commit**

```bash
git add src/cli.ts test/resolve-stations.test.ts
git commit -m "feat(cli): default to the live CHS station list, registry as name overlay"
```

---

## Self-Review

**Spec coverage:**
- "Fetch all live stations" → Task 1 (`IwlsClient.stations` + `currentStations` wcsp1 filter). ✓
- "Registry as a name mapping to improve usage" → Task 2 (`registryOverlay` + `stationsFromApi`, match by normalized name). ✓
- "Stop depending on the registry's id" → Task 2 removes `registryStations`/`mapRegistry` (the `providerId → id` map) and reads no id; Task 3 wires the live default. Registry can now drop `providerId` in Phase 2 without breaking this repo. ✓
- Forward-compat proof → `registryOverlay` test passes registry-shaped data with **no `providerId` field**. ✓

**Type consistency:** `IwlsStation` (Task 1) is consumed by `stationsFromApi` (Task 2). `StationRef` (`{id,label,key?}`) is produced by `stationsFromApi`/`resolveStations` and consumed by `fitStation` unchanged. `resolveStations` opts (`{stationsFile?, only}`) match `main`'s call site. `registryOverlay()`/`stationsFromApi()` names identical across Tasks 2 and 3. ✓

**Placeholder scan:** every code step shows complete code; no TBD/"handle errors"/"similar to". ✓

**Out of scope (later phases):** `station-corrections` dropping `providerId` and `currents-mcp` name-correlation = Phase 2; `signalk-currents` install-time build + removing CHS `defaults.ts` = Phase 3. Not touched here.
