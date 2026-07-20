const API = "https://api-iwls.dfo-mpo.gc.ca/api/v1";

/** IWLS allows 3 req/s and 30 req/min. Stay well under both. */
export const DEFAULT_REQUEST_INTERVAL_MS = 2500;

/** Chunk length for cached series fetches. */
const CHUNK_DAYS = 7;
const DAY_MS = 86_400_000;

/**
 * Somewhere to keep fetched chunks between runs. Two methods so the same client
 * works against the filesystem on a SignalK server and IndexedDB in a browser.
 */
export interface ChunkCache {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
}

export const NO_CACHE: ChunkCache = {
  read: async () => null,
  write: async () => {},
};

export interface ClientOptions {
  cache?: ChunkCache;
  requestIntervalMs?: number;
  userAgent?: string;
  /** Called with human-readable progress. Wire it to a plugin's status line. */
  onProgress?: (message: string) => void;
}

export interface StationMetadata {
  floodDirection: number;
  ebbDirection: number;
  latitude: number;
  longitude: number;
}

/** A CHS event as published, already normalised to signed along-axis speed. */
export interface ObservedEvent {
  time: string;
  kind: "slack" | "maxFlood" | "maxEbb";
  speed: number;
}

const QUALIFIER: Record<string, ObservedEvent["kind"]> = {
  SLACK: "slack",
  EXTREMA_FLOOD: "maxFlood",
  EXTREMA_EBB: "maxEbb",
};

const iso = (when: Date) => when.toISOString().replace(/\.\d+Z$/, "Z");

/**
 * Snap to a fixed 7-day grid measured from the Unix epoch.
 *
 * Anchoring chunks globally rather than to the requested start is what lets a
 * 60-day run and a 180-day run share cache entries. Anchor to `start` instead
 * and changing the training window silently refetches everything.
 */
function floorToGrid(when: Date): Date {
  const days = Math.floor(when.getTime() / DAY_MS);
  return new Date((days - (days % CHUNK_DAYS)) * DAY_MS);
}

export class IwlsClient {
  private cache: ChunkCache;
  private intervalMs: number;
  private userAgent: string;
  private onProgress: (message: string) => void;
  private last = 0;

  constructor({
    cache = NO_CACHE,
    requestIntervalMs = DEFAULT_REQUEST_INTERVAL_MS,
    userAgent = "chs-constituents",
    onProgress = () => {},
  }: ClientOptions = {}) {
    this.cache = cache;
    this.intervalMs = requestIntervalMs;
    this.userAgent = userAgent;
    this.onProgress = onProgress;
  }

  private async throttle(): Promise<void> {
    const gap = Date.now() - this.last;
    if (gap < this.intervalMs) {
      await new Promise((resolve) => setTimeout(resolve, this.intervalMs - gap));
    }
    this.last = Date.now();
  }

  async get<T>(path: string, attempts = 5): Promise<T> {
    let delay = this.intervalMs;
    for (let attempt = 0; attempt < attempts; attempt++) {
      await this.throttle();
      let response: Response;
      try {
        response = await fetch(`${API}/${path}`, { headers: { "User-Agent": this.userAgent } });
      } catch (error) {
        if (attempt === attempts - 1) throw error;
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      if (response.ok) return (await response.json()) as T;
      if (response.status === 429) {
        // Back off rather than hammer. IWLS keeps saying no otherwise and the
        // whole run dies late, after you have paid for most of the fetching.
        delay = Math.min(delay * 2, 60_000);
        this.onProgress(`429 throttled, backing off ${Math.round(delay / 1000)}s`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      if (response.status < 500 || attempt === attempts - 1) {
        throw new Error(`IWLS ${response.status} for ${path}`);
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    throw new Error(`fetch failed after ${attempts} attempts: ${path}`);
  }

  async metadata(stationId: string): Promise<StationMetadata> {
    return this.get<StationMetadata>(`stations/${stationId}/metadata`);
  }

  /** A continuous time series, fetched in cached 7-day chunks. */
  async series(
    stationId: string,
    code: string,
    start: Date,
    days: number,
  ): Promise<Map<string, number>> {
    const end = new Date(start.getTime() + days * DAY_MS);
    const merged = new Map<string, number>();

    for (let chunk = floorToGrid(start); chunk < end; ) {
      const key = `${stationId}-${code}-${iso(chunk).slice(0, 10).replace(/-/g, "")}.json`;
      const cached = await this.cache.read(key);
      let rows: Record<string, number>;
      if (cached) {
        rows = JSON.parse(cached);
      } else {
        const chunkEnd = new Date(chunk.getTime() + CHUNK_DAYS * DAY_MS);
        const data = await this.get<{ eventDate: string; value: number }[]>(
          `stations/${stationId}/data?time-series-code=${code}` +
            `&from=${iso(chunk)}&to=${iso(chunkEnd)}`,
        );
        rows = Object.fromEntries(data.map((row) => [row.eventDate, row.value]));
        await this.cache.write(key, JSON.stringify(rows));
      }
      for (const [time, value] of Object.entries(rows)) merged.set(time, value);
      chunk = new Date(chunk.getTime() + CHUNK_DAYS * DAY_MS);
    }

    const startMs = start.getTime();
    const endMs = end.getTime();
    return new Map(
      [...merged].filter(([time]) => {
        const at = Date.parse(time);
        return at >= startMs && at < endMs;
      }),
    );
  }

  /** CHS's own published slack/max events, for out-of-sample validation. */
  async events(stationId: string, start: Date, end: Date): Promise<ObservedEvent[]> {
    const rows = await this.get<{ eventDate: string; qualifier: string; value: number }[]>(
      `stations/${stationId}/data?time-series-code=wcp1-events` +
        `&from=${iso(start)}&to=${iso(end)}`,
    );
    return rows
      .filter((row) => QUALIFIER[row.qualifier])
      .map((row) => ({
        time: row.eventDate,
        kind: QUALIFIER[row.qualifier],
        speed:
          row.qualifier === "SLACK" ? 0 : row.qualifier === "EXTREMA_FLOOD" ? row.value : -row.value,
      }));
  }
}

/**
 * Fetch a station's speed and direction series and project onto its flood axis.
 *
 * The projection is linear, so this is equivalent to a full 2D fit projected
 * onto the same axis — verified against a 2D solve.
 */
export async function fetchProjectedSeries(
  client: IwlsClient,
  stationId: string,
  floodDirection: number,
  start: Date,
  days: number,
): Promise<{ time: Date; value: number }[]> {
  const speed = await client.series(stationId, "wcsp1", start, days);
  const direction = await client.series(stationId, "wcdp1", start, days);

  const samples: { time: Date; value: number }[] = [];
  for (const [time, magnitude] of speed) {
    const heading = direction.get(time);
    if (heading === undefined) continue;
    const radians = ((heading - floodDirection) * Math.PI) / 180;
    samples.push({ time: new Date(time), value: magnitude * Math.cos(radians) });
  }
  return samples.sort((a, b) => a.time.getTime() - b.time.getTime());
}
