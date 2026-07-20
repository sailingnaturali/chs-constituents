// Browser-safe surface: no node builtins reachable from here. The CLI (which
// needs the filesystem) is a separate entry point.
export { fit } from "./fit.js";
export type { Sample, FitOptions, FitResult, FittedConstituent, UnseparablePair } from "./fit.js";

export { currentEvents } from "./events.js";
export type { CurrentEvent, CurrentEventKind, EventOptions } from "./events.js";

export { IwlsClient, fetchProjectedSeries, NO_CACHE, DEFAULT_REQUEST_INTERVAL_MS } from "./client.js";
export type { ChunkCache, ClientOptions, StationMetadata, ObservedEvent } from "./client.js";

export { fitStation, BASIS } from "./pipeline.js";
export type { StationRef, FittedStation, FitStationOptions } from "./pipeline.js";

export { validate, tier, MATCH_WINDOW_MIN, FLIP_QUARANTINE } from "./validate.js";
export type { ValidationResult, Tier } from "./validate.js";
