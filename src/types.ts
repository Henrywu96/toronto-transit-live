/** Shape of public/data/transit.json, written by scripts/build-gtfs.mjs from the TTC, GO, UP Express and VIA Rail GTFS feeds. */
export interface TransitData {
  version: number;
  generatedAt: string;
  /** agency time zone (America/Toronto) */
  timezone: string;
  /** where each part of the timetable came from, and the dates it covers (YYYYMMDD) */
  feeds: FeedInfo[];
  lines: LineData[];
  stations: StationData[];
  shapes: ShapeData[];
  patterns: PatternData[];
  /** service calendars; ids start with the feed key ("ttc:1", "go:d4", "via:91") */
  services: ServiceData[];
  /** per-trip timing, delta-encoded: [arr0 − start, dep0 − arr0, arr1 − dep0, dep1 − arr1, …] in seconds */
  profiles: number[][];
  /** block ids, prefixed with the feed key (one block = one train working several trips) */
  blocks: string[];
  /** [run label, pattern, service, start (seconds after service-day midnight), profile, block (-1 when none)] */
  trips: TripRow[];
}

export type TripRow = [string, number, number, number, number, number];

export interface FeedInfo {
  key: string;
  name: string;
  url: string;
  lastModified?: string;
  version?: string;
  start: string;
  end: string;
}

/** UI grouping of the lines */
export type LineGroup = 'subway' | 'lrt' | 'streetcar' | 'go' | 'airport' | 'via';
/** which rolling stock a line runs */
export type LineMode = 'subway' | 'lrt' | 'streetcar' | 'go' | 'up' | 'tl' | 'via';

export interface LineData {
  id: string;
  name: string;
  short: string;
  color: string;
  textColor: string;
  group: LineGroup;
  mode: LineMode;
  routeIds: string[];
}

export interface StationData {
  id: string;
  name: string;
  lon: number;
  lat: number;
  lines: string[];
  /** "stop" for a streetcar stop (drawn smaller); stations leave it out */
  kind?: 'stop';
}

export interface ShapeData {
  id: string;
  line: string;
  /** delta-encoded micro-degrees: [lon0, lat0, dlon1, dlat1, …] (× 1e-6) */
  d: number[];
}

export interface PatternData {
  id: string;
  line: string;
  dir: number;
  headsign: string;
  /** index into shapes */
  shape: number;
  /** index into stations, in travel order; -1 = the point where a VIA train leaves or enters the region */
  stations: number[];
  /** where each stop sits on the shape: vertex index + fraction of the next segment */
  at: number[];
}

export interface ServiceData {
  id: string;
  /** Monday … Sunday as "1111100" */
  days: string;
  start: string;
  end: string;
  add: string[];
  remove: string[];
}
