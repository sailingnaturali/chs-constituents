import registry from "@sailingnaturali/station-corrections/data/registry.json" with { type: "json" };

/**
 * Derived gates: passes with NO current station of their own. Slack is a
 * reference tide port's high/low water shifted by a fixed lag. The registry
 * carries the whole spec in a `derived` block; this reads it out and resolves
 * the reference port's display name so the build can fit that tide offline.
 *
 * No CHS-derived data here — just identifiers and lags from the shared registry.
 */
interface DerivedBlock {
  reference: string;
  hwLagMinutes: number;
  lwLagMinutes: number;
}
interface RegistryEntry {
  name: string;
  provider: string;
  kind?: string;
  derived?: DerivedBlock;
}

export interface DerivedGateSpec {
  key: string;
  name: string;
  referenceKey: string;
  referenceName: string;
  hwLagMinutes: number;
  lwLagMinutes: number;
}

/**
 * The bundle record for a derived gate: no constituents and no speed — a
 * consumer predicts the referenced tide port and derives slack from its HW/LW.
 * `tide-derived` (not `chs-derived`) marks that this record itself holds no CHS
 * data, only a pointer and the lags.
 */
export interface DerivedSlackRecord {
  id: string;
  name: string;
  type: "derived-slack";
  source: "tide-derived";
  reference: string;
  hwLagMinutes: number;
  lwLagMinutes: number;
}

export function derivedSlackRecord(spec: DerivedGateSpec): DerivedSlackRecord {
  return {
    id: spec.key,
    name: spec.name,
    type: "derived-slack",
    source: "tide-derived",
    reference: spec.referenceKey,
    hwLagMinutes: spec.hwLagMinutes,
    lwLagMinutes: spec.lwLagMinutes,
  };
}

export function derivedGates(
  data: Record<string, RegistryEntry> = registry as Record<string, RegistryEntry>,
  provider = "chs",
): DerivedGateSpec[] {
  const gates: DerivedGateSpec[] = [];
  for (const [key, entry] of Object.entries(data)) {
    if (entry.provider !== provider || !entry.derived) continue;
    const ref = data[entry.derived.reference];
    if (!ref) {
      throw new Error(
        `derived gate ${key} references ${entry.derived.reference}, which is not in the registry`,
      );
    }
    gates.push({
      key,
      name: entry.name,
      referenceKey: entry.derived.reference,
      referenceName: ref.name,
      hwLagMinutes: entry.derived.hwLagMinutes,
      lwLagMinutes: entry.derived.lwLagMinutes,
    });
  }
  return gates;
}
