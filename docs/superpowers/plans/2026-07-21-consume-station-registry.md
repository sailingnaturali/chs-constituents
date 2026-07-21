# Consume the Station Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `chs-constituents` read its station list from `@sailingnaturali/station-corrections`' registry instead of its own `stations/salish-sea.json`, so station identity has one source.

**Architecture:** The registry ships `{ name, position, provider, providerId }` keyed by a stable public id (`chs-dodd-narrows`). This pipeline needs exactly three of those: the key (its output `id`), the `name` (its output `name`), and the `providerId` (the IWLS handle it fetches with). The registry becomes the default station source; `--stations <path>` keeps working for user-supplied lists.

**Tech Stack:** TypeScript, ESM with `.js` import specifiers, vitest, Node 22+.

## Why this is a correctness fix, not just deduplication

`src/pipeline.ts:53-54,97` currently *derives* the public station id from the label:

```ts
const slug = (label) => "chs-" + label.toLowerCase().replace(/[^a-z0-9]+/g, "-")…
id: slug(station.label),
```

So renaming a label silently changes the public id that consumers key on. The registry key is explicit and stable, and renaming a display name there cannot move it. That is the actual bug this closes; the removed duplication is a bonus.

## Global Constraints

- **This repo ships no CHS-derived data and never will.** Station ids and hand-written names are not CHS-derived (the same posture `currents-vault` takes); constituents and predictions are. Nothing in this change may bundle fitted output. `currents.json` stays gitignored.
- **`--stations <path>` must keep working unchanged** for a user-supplied `[{id, label}]` list. Those entries have no registry key, so the `slug(label)` derivation must remain as the fallback — not be deleted.
- **The `--only` filter must keep matching on the display name**, as it does today.
- Full suite green: `npx vitest run`.
- Match existing style: this codebase writes substantial *why* comments and uses `.js` specifiers on relative imports.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/pipeline.ts` | **Modify.** `StationRef` gains optional `key`; `fitStation` prefers it over `slug(label)`. |
| `src/registry.ts` | **Create.** Load the bundled registry and map it to `StationRef[]`. Single place that knows the registry's shape. |
| `src/cli.ts` | **Modify.** Default the station source to the registry; keep `--stations` for files. |
| `package.json` | **Modify.** Add `@sailingnaturali/station-corrections` dependency. |
| `stations/salish-sea.json` | **Delete.** The registry replaces it. |
| `README.md` | **Modify.** Document where the station list now comes from. |

---

### Task 1: A registry key overrides the derived slug

**Files:**
- Modify: `src/pipeline.ts`
- Test: `test/fit.test.ts`

**Interfaces:**
- Produces: `StationRef { id: string; label: string; key?: string }`; `fitStation` emits `key ?? slug(label)` as the fitted `id`

- [ ] **Step 1: Write the failing test**

Append to `test/fit.test.ts`. Read the file first and reuse its existing client-stubbing pattern rather than inventing a new one — if it already has a helper for a fake `IwlsClient` with enough samples to fit, use that.

```ts
it("uses the registry key as the fitted id when one is given", async () => {
  const station = { id: "63aef1866a2b9417c035030f", label: "Dodd Narrows", key: "chs-dodd-narrows" };
  const result = await fitStation(fakeClient(), station, { start: new Date("2025-07-01T00:00:00Z"), days: 30 });
  expect(result?.id).toBe("chs-dodd-narrows");
  expect(result?.name).toBe("Dodd Narrows");
});

it("falls back to the derived slug for a station with no key", async () => {
  // A user-supplied --stations list has no registry key. This path must stay.
  const station = { id: "63aef1866a2b9417c035030f", label: "Dodd Narrows" };
  const result = await fitStation(fakeClient(), station, { start: new Date("2025-07-01T00:00:00Z"), days: 30 });
  expect(result?.id).toBe("chs-dodd-narrows");
});

it("a renamed label cannot move a keyed station's id", async () => {
  // The point of the key: display name and public id are decoupled.
  const station = { id: "63aef1866a2b9417c035030f", label: "Dodd Narrows (north end)", key: "chs-dodd-narrows" };
  const result = await fitStation(fakeClient(), station, { start: new Date("2025-07-01T00:00:00Z"), days: 30 });
  expect(result?.id).toBe("chs-dodd-narrows");
  expect(result?.name).toBe("Dodd Narrows (north end)");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/fit.test.ts`
Expected: the first and third fail — `id` is the slug of the label, not the key. The second passes already (that is the existing behaviour, pinned here so the fallback cannot be dropped).

- [ ] **Step 3: Implement**

In `src/pipeline.ts`, extend the interface:

```ts
export interface StationRef {
  id: string;
  label: string;
  /**
   * Stable public id from the station registry, when this station came from
   * there. Preferred over `slug(label)` because it does not move when a
   * display name is edited - deriving the public id from the label meant a
   * rename silently rekeyed the station for every consumer.
   *
   * Absent for a user-supplied --stations list, which still derives.
   */
  key?: string;
}
```

And in `fitStation`, change the `id` assignment:

```ts
    id: station.key ?? slug(station.label),
```

Leave `slug` in place — it is the fallback for keyless stations.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run`
Expected: all pass

- [ ] **Step 5: Commit**

```bash
git add src/pipeline.ts test/fit.test.ts
git commit -m "Prefer a registry key over the label-derived slug for a station's public id"
```

---

### Task 2: Load the station list from the registry

**Files:**
- Create: `src/registry.ts`
- Test: `test/registry.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `StationRef` with `key` from Task 1
- Produces: `registryStations(provider?: string) -> StationRef[]`

- [ ] **Step 1: Add the dependency**

```bash
npm install @sailingnaturali/station-corrections@^1.4.1
```

- [ ] **Step 2: Write the failing test**

Create `test/registry.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { registryStations } from "../src/registry.js";

describe("registryStations", () => {
  it("returns the bundled CHS gates as StationRefs", () => {
    const stations = registryStations();
    expect(stations.length).toBeGreaterThanOrEqual(19);
    const dodd = stations.find((s) => s.key === "chs-dodd-narrows");
    expect(dodd).toBeDefined();
    expect(dodd!.label).toBe("Dodd Narrows");
    // `id` is what the IWLS API is called with - the provider's own handle,
    // not the registry key.
    expect(dodd!.id).toBe("63aef1866a2b9417c035030f");
  });

  it("only returns stations for the requested provider", () => {
    for (const station of registryStations("chs")) {
      expect(station.key.startsWith("chs-")).toBe(true);
    }
    expect(registryStations("nonexistent")).toEqual([]);
  });

  it("every station has the three fields the pipeline needs", () => {
    for (const station of registryStations()) {
      expect(typeof station.id).toBe("string");
      expect(station.id.length).toBeGreaterThan(0);
      expect(typeof station.label).toBe("string");
      expect(station.label.length).toBeGreaterThan(0);
      expect(typeof station.key).toBe("string");
    }
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/registry.test.ts`
Expected: FAIL — cannot resolve `../src/registry.js`

- [ ] **Step 4: Implement**

Create `src/registry.ts`:

```ts
import registry from "@sailingnaturali/station-corrections/data/registry.json" with { type: "json" };
import type { StationRef } from "./pipeline.js";

interface RegistryEntry {
  name: string;
  provider: string;
  providerId: string;
}

/**
 * The station list, from the shared registry rather than a copy kept here.
 *
 * Station identity - which gates exist, what they are called, and which
 * opaque IWLS handle each maps to - is curated once in
 * @sailingnaturali/station-corrections and read by everything that needs it.
 * This repo used to keep its own stations/salish-sea.json, which meant the
 * same three facts lived in two places with nothing reconciling them.
 *
 * The mapping is deliberately not one-to-one:
 *   registry key        -> StationRef.key   (stable public id, survives renames)
 *   registry providerId -> StationRef.id    (what IwlsClient actually fetches)
 *   registry name       -> StationRef.label (display, and what --only matches)
 *
 * No CHS-derived data is involved: these are identifiers and hand-written
 * names, not predictions or constituents.
 */
export function registryStations(provider = "chs"): StationRef[] {
  return Object.entries(registry as Record<string, RegistryEntry>)
    .filter(([, entry]) => entry.provider === provider)
    .map(([key, entry]) => ({ id: entry.providerId, label: entry.name, key }));
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run`
Expected: all pass. If the JSON import attribute fails to compile, check `tsconfig.json`'s `module`/`moduleResolution` are `nodenext` and report what you found rather than switching to `readFile` — the import keeps this synchronous and bundler-friendly.

- [ ] **Step 6: Commit**

```bash
git add src/registry.ts test/registry.test.ts package.json package-lock.json
git commit -m "Read the station list from the shared registry"
```

---

### Task 3: Default the CLI to the registry and drop the local list

**Files:**
- Modify: `src/cli.ts`, `README.md`
- Delete: `stations/salish-sea.json`

**Interfaces:**
- Consumes: `registryStations()` from Task 2

- [ ] **Step 1: Change the station source**

In `src/cli.ts`, `stationsPath` currently defaults to `"stations/salish-sea.json"`. Make the default the registry and the flag an override:

```ts
  const stationsPath = arg(argv, "stations");
```

and replace the loading line:

```ts
  // Default to the shared registry; --stations still takes a file for
  // stations it does not cover. A file-supplied station has no registry key,
  // so its public id is still derived from its label (see pipeline.ts).
  let stations: StationRef[] = stationsPath
    ? JSON.parse(await readFile(stationsPath, "utf8"))
    : registryStations();
```

Add the import:

```ts
import { registryStations } from "./registry.js";
```

- [ ] **Step 2: Update `--help`**

Change the `--stations` line to state the new default:

```
  --stations <path>       JSON list of {id, label} (default: the bundled station registry)
```

- [ ] **Step 3: Verify the CLI still lists the same stations**

Run:

```bash
npx tsc && node dist/cli.js --help
```

Then confirm the default source resolves to 19 stations without hitting the network:

```bash
node -e '
import("./dist/registry.js").then(({ registryStations }) => {
  const s = registryStations();
  console.log(`${s.length} stations`);
  console.log(s.slice(0,3).map(x => `${x.key} -> ${x.id} (${x.label})`).join("\n"));
});'
```

Expected: `19 stations`, and each line showing a `chs-*` key mapping to an IWLS handle.

- [ ] **Step 4: Delete the local station list**

```bash
git rm stations/salish-sea.json
```

Confirm nothing still references it:

Run: `grep -rn "salish-sea" src/ test/ README.md package.json`
Expected: no output

- [ ] **Step 5: Update the README**

Find the section describing station lists and state that the default list now comes from `@sailingnaturali/station-corrections`, that `--stations` still accepts a `[{id, label}]` file for anything the registry does not cover, and that a file-supplied station gets a derived id while a registry station's id is stable across renames. Keep it to a short paragraph in the existing voice.

- [ ] **Step 6: Run everything**

```bash
npx vitest run
npx tsc --noEmit
```

Expected: all tests pass, no type errors

- [ ] **Step 7: Commit**

```bash
git add src/cli.ts README.md
git commit -m "Default the station list to the registry and drop the local copy"
```

---

## Out of scope

- **Phase 3** (`currents-vault` dropping `name`/`latitude`/`longitude` from pass frontmatter) and **Phase 4** (`currents-mcp` resolving identity from the registry) are separate plans.
- **Position** is in the registry but this pipeline does not need it — it fetches by `providerId` and emits no position. Do not add it to `StationRef`.
- **The `slug` derivation stays.** It is the documented fallback for user-supplied station lists, not dead code.
