import { describe, it, expect } from "vitest";
import { IwlsClient, currentStations, tideStations } from "../src/client.js";

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

describe("tideStations", () => {
  it("keeps only stations that publish a wlp series", () => {
    // A derived gate's reference is a TIDE port (wlp), which currentStations drops.
    expect(tideStations(RAW as never).map((s) => s.id)).toEqual(["wl1"]);
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
