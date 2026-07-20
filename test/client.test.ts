import { describe, it, expect } from "vitest";
import { IwlsClient, type ChunkCache } from "../src/client.js";

/** Cache that records every key it is asked for and always misses. */
function recordingCache(): ChunkCache & { keys: string[] } {
  const keys: string[] = [];
  return {
    keys,
    async read(key) {
      keys.push(key);
      return null;
    },
    async write() {},
  };
}

/** Client that never touches the network: every chunk fetch returns empty. */
function offlineClient(cache: ChunkCache) {
  const client = new IwlsClient({ cache, requestIntervalMs: 0 });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (client as any).get = async () => [];
  return client;
}

describe("chunk cache keys", () => {
  it("shares chunks across window lengths", async () => {
    // This is the whole reason chunks are anchored to a fixed epoch grid rather
    // than to the caller's start date. If it regresses, changing the training
    // window silently refetches everything against a rate limit.
    const start = new Date("2025-07-01T00:00:00Z");

    const short = recordingCache();
    await offlineClient(short).series("X", "wcsp1", start, 60);
    const long = recordingCache();
    await offlineClient(long).series("X", "wcsp1", start, 180);

    expect(long.keys.slice(0, short.keys.length)).toEqual(short.keys);
    expect(short.keys.length).toBeGreaterThan(1);
  });

  it("aligns chunks to the grid regardless of the requested start", async () => {
    // The grid runs from the Unix epoch, so 2025-07-03 begins a chunk.
    const aligned = recordingCache();
    await offlineClient(aligned).series("X", "wcsp1", new Date("2025-07-03T00:00:00Z"), 30);
    const offset = recordingCache();
    await offlineClient(offset).series("X", "wcsp1", new Date("2025-07-06T13:22:00Z"), 30);

    // Different starts inside the same grid week must hit the same first chunk.
    expect(offset.keys[0]).toBe(aligned.keys[0]);
    expect(aligned.keys[0]).toBe("X-wcsp1-20250703.json");
  });

  it("keys by station and series code, so they cannot collide", async () => {
    const cache = recordingCache();
    const client = offlineClient(cache);
    const start = new Date("2025-07-01T00:00:00Z");
    await client.series("A", "wcsp1", start, 7);
    await client.series("A", "wcdp1", start, 7);
    await client.series("B", "wcsp1", start, 7);
    expect(new Set(cache.keys).size).toBe(cache.keys.length);
  });
});
