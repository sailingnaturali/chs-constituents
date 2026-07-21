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
  return mapRegistry(registry as Record<string, RegistryEntry>, provider);
}

/**
 * The actual key -> StationRef mapping, split out so the empty-field guard
 * below can be exercised with synthetic data in a test - reaching for a real
 * bad entry would mean shipping one into the registry package itself just to
 * prove this throws.
 */
export function mapRegistry(data: Record<string, RegistryEntry>, provider: string): StationRef[] {
  return Object.entries(data)
    .filter(([, entry]) => entry.provider === provider)
    .map(([key, entry]) => {
      // fitStation does `station.key ?? slug(station.label)` - `??` only
      // falls through on null/undefined, so an empty string here would sail
      // straight past that fallback and come out the other end as a blank or
      // wrong fitted id. That is exactly the "quiet wrongness" this registry
      // read is supposed to prevent, so refuse loudly at the source instead
      // of letting it surface three layers away in a published bundle.
      if (!key || !entry.name || !entry.providerId) {
        throw new Error(`registry entry ${JSON.stringify(key)} has an empty key, name, or providerId`);
      }
      return { id: entry.providerId, label: entry.name, key };
    });
}
