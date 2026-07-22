import { describe, it, expect, afterEach } from "vitest";
import { writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("rejects with the IWLS-empty message when the live index is empty", async () => {
    const client = clientWith([]);
    await expect(resolveStations(client, { only: [] })).rejects.toThrow(
      /No current stations returned by IWLS/,
    );
  });

  it("rejects with the --only message when a non-empty live index matches nothing", async () => {
    const client = clientWith([
      { id: "a", officialName: "Dodd Narrows", latitude: 0, longitude: 0, operating: true },
    ]);
    await expect(resolveStations(client, { only: ["xyz"] })).rejects.toThrow(
      /No stations matched --only/,
    );
  });

  describe("with a --stations file", () => {
    const file = join(tmpdir(), `resolve-stations-test-${process.pid}.json`);

    afterEach(async () => {
      await rm(file, { force: true });
    });

    it("rejects with the --only message when the file has entries but none match", async () => {
      await writeFile(file, JSON.stringify([{ id: "a", label: "Dodd Narrows" }]));
      const client = clientWith([]);
      await expect(
        resolveStations(client, { stationsFile: file, only: ["xyz"] }),
      ).rejects.toThrow(/No stations matched --only/);
    });
  });
});
