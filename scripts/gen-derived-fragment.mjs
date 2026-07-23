// Generate the engine's CHS reference-tide fragment (currents-chs.json): the
// tide-harmonic fit for each derived gate's reference port + the derived-slack
// record itself. This is the *operator* running the fit under their own CHS
// licence — the output is gitignored and NOT for redistribution, exactly like
// the full bundle. It exists so a native app can predict the reference tide and
// derive Malibu slack offline, without shipping CHS data in a public bundle.
//
//   cd chs-constituents && npm run build && node scripts/gen-derived-fragment.mjs
import { writeFile } from "node:fs/promises";
import { IwlsClient } from "../dist/client.js";
import { fitTideStation } from "../dist/pipeline.js";
import { derivedGates, derivedSlackRecord } from "../dist/derived.js";
import { normalizeName } from "../dist/registry.js";
import { fileCache } from "../dist/build.js";

const log = (m) => console.error(m);
const client = new IwlsClient({
  cache: fileCache(".cache"),
  requestIntervalMs: 2500,
  userAgent: "chs-constituents/1.0",
  onProgress: log,
});

const gates = derivedGates();
if (!gates.length) throw new Error("no derived gates in the registry");
const tideByName = new Map((await client.tideStations()).map((s) => [normalizeName(s.officialName), s]));

const stations = [];
const fittedRefs = new Set();
for (const g of gates) {
  if (!fittedRefs.has(g.referenceKey)) {
    const live = tideByName.get(normalizeName(g.referenceName));
    if (!live) throw new Error(`no live IWLS tide station for ${g.referenceName}`);
    log(`fitting reference tide ${g.referenceName} (${g.referenceKey}) …`);
    const ref = await fitTideStation(
      client,
      { id: live.id, label: g.referenceName, key: g.referenceKey },
      { start: new Date("2025-07-01T00:00:00Z"), days: 210, onProgress: log },
    );
    if (!ref) throw new Error(`insufficient water-level data for ${g.referenceName}`);
    stations.push(ref);
    fittedRefs.add(g.referenceKey);
  }
  stations.push(derivedSlackRecord(g));
}

const bundle = {
  note:
    "CHS reference-tide fits + derived-slack gates. Derived from CHS IWLS " +
    "predictions for personal, non-commercial use under the operator's own CHS " +
    "licence. Crown copyright retained. NOT FOR NAVIGATION. Do not redistribute.",
  generated: new Date().toISOString().slice(0, 10),
  stations,
};
await writeFile("currents-chs.json", JSON.stringify(bundle, null, 2));
console.error(`\nwrote currents-chs.json — ${stations.length} records`);
