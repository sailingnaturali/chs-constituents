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
