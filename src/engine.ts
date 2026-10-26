import { Map as MapLibreMap } from 'maplibre-gl';
import type { LngLatLike, MapMouseEvent, StyleSpecification } from 'maplibre-gl';
import type { JSAnimation } from 'animejs';
import 'maplibre-gl/dist/maplibre-gl.css';
import { BASEMAPS, CITY, GROUPS, type BasemapKey, type StyleMode } from './config';
import { SimClock } from './lib/clock';
import type { PathPoint } from './lib/geo';
import { Network, type Line } from './lib/network';
import { Schedule, trainName, type TrainState, type Vehicle } from './lib/schedule';
import { Store } from './lib/store';
import { reducedMotion, tween } from './lib/motion';
import { isDark } from './lib/sun';
import { addDays, hm, hms, keyLabel, untilLabel, weekdayOf, WEEKDAYS, Zone } from './lib/time';
import { addNetworkLayers, addStationLabels, blankStyle, ROUTE_LAYERS, routeFilter, STATION_LAYERS, withoutBuildings } from './map/layers';
import { TrainLabels } from './map/TrainLabels';
import { TrainLayer } from './map/TrainLayer';
import { consistFor } from './map/trainModels';
import type { LineGroup, TransitData } from './types';

/* ------------------------------------------------------------------ what the React UI sees */

export interface LineInfo {
  id: string;
  name: string;
  short: string;
  color: string;
  group: LineGroup;
}
export interface TrainRow {
  key: string;
  id: string;
  line: LineInfo;
  headsign: string;
  status: string;
  eta: string;
  ug: boolean;
}
export interface StopRow {
  name: string;
  time: string;
  state: 'past' | 'now' | 'next' | 'future';
}
export interface TrainDetail {
  kind: 'train';
  key: string;
  id: string;
  line: LineInfo;
  visible: boolean;
  headsign: string;
  status: string;
  sub: string;
  progress: number;
  from: string;
  to: string;
  speed: string;
  stock: string;
  /** train number shown by the operator (GO, UP, VIA); empty for the TTC */
  run: string;
  ug: boolean;
  stops: StopRow[];
  next: string | null;
}
export interface StationDetail {
  kind: 'station';
  idx: number;
  name: string;
  /** a streetcar stop rather than a station */
  stop: boolean;
  lines: LineInfo[];
  groups: { line: LineInfo; headsign: string; items: { time: string; until: string; key: string | null }[] }[];
  here: { key: string; id: string; line: LineInfo; headsign: string; what: string }[];
}
export interface Snapshot {
  ms: number;
  live: boolean;
  paused: boolean;
  speed: number;
  clock: string;
  date: string;
  service: string;
  special: boolean;
  fallback: string | null;
  lines: (LineInfo & { count: number; hidden: boolean })[];
  groups: { id: LineGroup; label: string; short: string; color: string; count: number; hidden: boolean }[];
  total: number;
  trains: TrainRow[];
  detail: TrainDetail | StationDetail | null;
  follow: boolean;
  styleMode: StyleMode;
  pitched: boolean;
  nextService: string | null;
  scrub: number;
  toast: { id: number; text: string } | null;
  stations: { idx: number; name: string }[];
  /** the map is showing its night style: the panels follow it */
  dark: boolean;
  /** the first frame has run, so the train counts are real (not the empty start) */
  ready: boolean;
  /** trains in service through the service day, for the timeline */
  profile: ServiceProfile;
}

/** average number of trains in service per time bin, per line group (bins × groups) */
export interface ServiceProfile {
  key: string;
  /** seconds after service-day midnight of the first bin, and the bin length */
  from: number;
  step: number;
  groups: { id: LineGroup; color: string }[];
  bins: number[][];
  max: number;
}

export type Selection = { kind: 'train'; key: string } | { kind: 'station'; idx: number } | null;

export interface EngineOptions {
  /** start at this instant instead of now (epoch ms) */
  at?: number;
  speed?: number;
  /** force a basemap (e.g. "none" for offline testing) */
  basemap?: BasemapKey | null;
}

interface Flight {
  t0: number;
  dur: number;
  from: [number, number];
  z0: number;
  z1: number;
}

const info = (l: Line): LineInfo => ({ id: l.id, name: l.name, short: l.short, color: l.color, group: l.group });
const PREFS = 'toronto-transit-live:prefs';
const ease = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2);

/**
 * The app's core, outside React: owns the map, the clock, the timetable and the train layer,
 * runs the animation loop, and publishes a small snapshot for the UI four times a second.
 */
export class Engine {
  readonly zone: Zone;
  readonly net: Network;
  readonly sched: Schedule;
  readonly clock = new SimClock();
  readonly store: Store<Snapshot>;

  map: MapLibreMap | null = null;
  sel: Selection = null;
  follow = false;
  styleMode: StyleMode = 'auto';
  readonly hidden = new Set<string>();

  private basemap: BasemapKey | null = null;
  private styleLoaded = false;
  private styleTimer = 0;
  /** set when the street map could not be loaded: keep showing the lines on a plain background */
  private basemapFailed = false;
  private readonly forcedBasemap: BasemapKey | null;
  private layer: TrainLayer | null = null;
  private labels: TrainLabels | null = null;
  private readonly states: TrainState[] = [];
  private readonly visible: TrainState[] = [];
  private raf = 0;
  private lastPub = 0;
  private lastStyleCheck = 0;
  private flight: Flight | null = null;
  private toast: Snapshot['toast'] = null;
  private toastSeq = 0;
  private toastUntil = 0;
  private hoverQueued = false;
  private size = { w: 1200, h: 800 };
  private readonly pt: PathPoint = { x: 0, y: 0, tx: 0, ty: 0 };
  private readonly stationList: { idx: number; name: string }[];

  constructor(
    readonly data: TransitData,
    opts: EngineOptions = {},
  ) {
    this.zone = new Zone(data.timezone || 'America/Toronto');
    this.net = new Network(data);
    this.sched = new Schedule(data, this.net, this.zone);
    this.forcedBasemap = opts.basemap ?? null;
    if (opts.at != null && Number.isFinite(opts.at)) this.clock.set(opts.at);
    if (opts.speed && opts.speed !== 1) this.clock.setSpeed(opts.speed);
    try {
      const p = JSON.parse(localStorage.getItem(PREFS) ?? '{}') as { style?: StyleMode; hidden?: string[] };
      if (p.style && ['auto', 'light', 'gray', 'dark'].includes(p.style)) this.styleMode = p.style;
      for (const id of p.hidden ?? []) if (this.net.lineById.has(id)) this.hidden.add(id);
    } catch {
      /* storage unavailable: defaults */
    }
    const seen = new Set<string>();
    this.stationList = this.net.stations
      .filter((s) => !s.stop)
      .filter((s) => (seen.has(s.name) ? false : (seen.add(s.name), true)))
      .map((s) => ({ idx: s.idx, name: s.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
    this.store = new Store(this.snapshot());
  }

  /* ---------------------------------------------------------------- lifecycle */

  mount(container: HTMLElement): () => void {
    const [[w, s], [e, n]] = this.net.cityBounds;
    const map = new MapLibreMap({
      container,
      center: [(w + e) / 2, (s + n) / 2],
      zoom: 11,
      pitch: 45,
      bearing: -17,
      minZoom: 7.5,
      maxZoom: 19.5,
      maxPitch: 70,
      attributionControl: { compact: true },
      canvasContextAttributes: { antialias: true },
    });
    this.map = map;
    this.labels = new TrainLabels(container, (key) => this.selectTrain(key));
    map.on('style.load', () => this.onStyleLoad());
    map.on('click', (ev) => this.onClick(ev));
    map.on('mousemove', (ev) => this.onHover(ev));
    map.on('dragstart', () => this.stopFollow());
    map.on('resize', () => this.measure());
    // the basemap asks for a few pattern images its sprite lacks (e.g. wood-pattern): fill them with a transparent pixel
    map.on('styleimagemissing', (e) => {
      if (!map.hasImage(e.id)) map.addImage(e.id, { width: 1, height: 1, data: new Uint8Array(4) });
    });
    map.on('error', (e) => {
      // a failed style download has no sourceId (tile errors do); fall back to a plain map
      if (!this.styleLoaded && this.basemap !== 'none' && !(e as { sourceId?: string }).sourceId) this.onBasemapError();
    });
    this.measure();
    map.once('load', () => this.view('city', true));
    this.basemap = null;
    this.applyBasemap();
    this.raf = requestAnimationFrame(this.loop);
    return () => {
      cancelAnimationFrame(this.raf);
      clearTimeout(this.styleTimer);
      this.labels?.destroy();
      this.labels = null;
      this.layer = null;
      map.remove();
      this.map = null;
    };
  }

  /* ---------------------------------------------------------------- basemap */

  private wantedBasemap(): BasemapKey {
    if (this.forcedBasemap) return this.forcedBasemap;
    if (this.basemapFailed) return 'none';
    if (this.styleMode === 'auto') return isDark(this.clock.ms, CITY.lat, CITY.lon) ? 'dark' : 'light';
    return this.styleMode;
  }

  private applyBasemap() {
    const map = this.map;
    if (!map) return;
    const want = this.wantedBasemap();
    if (want === this.basemap) return;
    this.basemap = want;
    this.styleLoaded = false;
    clearTimeout(this.styleTimer);
    if (want !== 'none') this.styleTimer = window.setTimeout(() => this.onBasemapError(), 15000);
    if (want === 'none') map.setStyle(blankStyle(), { diff: false });
    else map.setStyle(BASEMAPS[want].url, { diff: false, transformStyle: (_prev: StyleSpecification | undefined, next: StyleSpecification) => withoutBuildings(next) });
  }

  private get dark() {
    return this.basemap === 'dark';
  }

  private onBasemapError() {
    if (this.styleLoaded || this.basemapFailed || !this.map) return;
    this.basemapFailed = true;
    this.applyBasemap();
    this.say('The street map could not be loaded – showing the train lines only');
  }

  private onStyleLoad() {
    const map = this.map;
    if (!map) return;
    this.styleLoaded = true;
    clearTimeout(this.styleTimer);
    addNetworkLayers(map, this.net, { dark: this.dark, hidden: [...this.hidden] });
    this.layer ??= new TrainLayer(this.net, this.net.frame, () => this.visible, () => this.afterRender());
    this.layer.night = this.dark;
    this.layer.pixelScale = this.size.w < 760 ? 0.62 : 1;
    this.layer.selectedKey = this.sel?.kind === 'train' ? this.sel.key : null;
    map.addLayer(this.layer);
    if (this.basemap !== 'none') addStationLabels(map, this.dark);
    this.updateStationHighlight();
  }

  setStyleMode(mode: StyleMode) {
    this.styleMode = mode;
    this.basemapFailed = false; // try the street map again
    this.savePrefs();
    this.applyBasemap();
    this.publish();
  }

  private savePrefs() {
    try {
      localStorage.setItem(PREFS, JSON.stringify({ style: this.styleMode, hidden: [...this.hidden] }));
    } catch {
      /* ignore */
    }
  }

  /* ---------------------------------------------------------------- frame loop */

  private loop = (now: number) => {
    this.raf = requestAnimationFrame(this.loop);
    const map = this.map;
    if (!map) return;
    const ms = this.clock.tick(now);
    this.sched.states(ms, this.states);
    this.ticked = true;
    this.visible.length = 0;
    for (const st of this.states) if (!this.hidden.has(st.trip.pattern.line.id)) this.visible.push(st);
    if (this.flight) this.stepFlight(now);
    else if (this.follow) this.followStep();
    map.triggerRepaint();
    if (now - this.lastPub > 250) {
      this.lastPub = now;
      this.publish();
    }
    if (now - this.lastStyleCheck > 4000) {
      this.lastStyleCheck = now;
      this.applyBasemap();
    }
  };

  private afterRender() {
    if (this.map && this.layer && this.labels) this.labels.update(this.map, this.net.frame, this.layer.poses, this.sel?.kind === 'train' ? this.sel.key : null);
  }

  /* ---------------------------------------------------------------- camera */

  private trainLngLat(st: TrainState): [number, number] {
    const p = st.trip.pattern.shape.path.at(st.dist, this.pt);
    return this.net.frame.toLngLat(p.x + p.ty * 2, p.y - p.tx * 2);
  }

  private selectedState(): TrainState | null {
    if (this.sel?.kind !== 'train') return null;
    const key = this.sel.key;
    return this.states.find((s) => s.v.key === key) ?? null;
  }

  private measure() {
    const el = this.map?.getContainer();
    if (!el) return;
    this.size = { w: el.clientWidth, h: el.clientHeight };
    if (this.layer) this.layer.pixelScale = this.size.w < 760 ? 0.62 : 1;
  }

  /** on phones the train card covers the bottom half: keep the followed train in the part still visible */
  private viewOffset(): [number, number] {
    const { w, h } = this.size;
    if (w >= 760 || !this.sel) return [0, 0];
    const sheet = h * 0.52 + 136;
    return [0, Math.round((60 + (h - sheet)) / 2 - h / 2)];
  }

  /** the map centre that puts this train in the middle of the visible area */
  private centerFor(st: TrainState): [number, number] {
    const ll = this.trainLngLat(st);
    const [ox, oy] = this.viewOffset();
    const map = this.map;
    if (!map || (!ox && !oy)) return ll;
    const p = map.project(ll);
    const c = map.unproject([p.x - ox, p.y - oy]);
    return [c.lng, c.lat];
  }

  private followStep() {
    const st = this.selectedState();
    if (!st || !this.map) return;
    this.map.jumpTo({ center: this.centerFor(st) });
  }

  private stepFlight(now: number) {
    const f = this.flight!;
    const map = this.map!;
    const st = this.selectedState();
    const p = Math.min(1, (now - f.t0) / f.dur);
    if (!st) {
      this.flight = null;
      return;
    }
    const e = ease(p);
    const to = this.centerFor(st);
    map.jumpTo({ center: [f.from[0] + (to[0] - f.from[0]) * e, f.from[1] + (to[1] - f.from[1]) * e], zoom: f.z0 + (f.z1 - f.z0) * e });
    if (p >= 1) {
      this.flight = null;
      this.setFollow(true);
    }
  }

  setFollow(on: boolean) {
    this.follow = on;
    const map = this.map;
    if (map) {
      // while following, zoom around the train instead of the mouse
      map.scrollZoom.disable();
      map.scrollZoom.enable(on ? { around: 'center' } : undefined);
      map.touchZoomRotate.disable();
      map.touchZoomRotate.enable(on ? { around: 'center' } : undefined);
    }
    this.publish();
  }

  private stopFollow() {
    if (this.flight) this.flight = null;
    if (this.follow) {
      this.setFollow(false);
      this.say('Stopped following – drag the map freely');
    }
  }

  view(kind: 'network' | 'city' | 'downtown' | 'tilt', instant = false) {
    const map = this.map;
    if (!map) return;
    this.flight = null;
    if (this.follow) this.setFollow(false);
    if (kind === 'tilt') {
      map.easeTo({ pitch: map.getPitch() > 10 ? 0 : 50, duration: 700 });
      return;
    }
    if (kind === 'network' || kind === 'city') {
      // the whole GO network reaches Kitchener, Niagara Falls, Barrie and Oshawa; "city" is the TTC subway and LRT
      const b = kind === 'network' ? this.net.bounds : this.net.cityBounds;
      map.fitBounds(b, { padding: this.padding(), bearing: -17, pitch: kind === 'network' ? 20 : 40, duration: instant ? 0 : 1200, maxZoom: 13 });
      return;
    }
    const centre = this.net.stations.find((s) => /^union station$/i.test(s.name));
    const c: LngLatLike = centre ? [centre.lon, centre.lat] : [CITY.lon, CITY.lat];
    map.flyTo({ center: c, zoom: 15, pitch: 55, bearing: -17, duration: 1400 });
  }

  private padding() {
    const map = this.map;
    const W = map?.getContainer().clientWidth ?? 1200;
    if (W < 760) return { top: 80, bottom: 160, left: 24, right: 24 };
    return { top: 90, bottom: 110, left: 340, right: this.sel ? 380 : 50 };
  }

  /* ---------------------------------------------------------------- selection */

  selectTrain(key: string, fly = false) {
    this.sel = { kind: 'train', key };
    if (this.layer) this.layer.selectedKey = key;
    this.updateStationHighlight();
    const st = this.selectedState();
    if (fly && st && this.map) {
      const c = this.map.getCenter();
      this.flight = { t0: performance.now(), dur: 1100, from: [c.lng, c.lat], z0: this.map.getZoom(), z1: Math.max(this.map.getZoom(), 15) };
    } else if (fly) {
      this.say('That train is not on the map right now');
    }
    this.publish();
  }

  selectStation(idx: number, fly = false) {
    this.sel = { kind: 'station', idx };
    this.flight = null;
    if (this.follow) this.setFollow(false);
    if (this.layer) this.layer.selectedKey = null;
    this.updateStationHighlight();
    const st = this.net.stations[idx];
    if (fly && this.map && st) this.map.flyTo({ center: [st.lon, st.lat], zoom: Math.max(this.map.getZoom(), 14.6), duration: 1100 });
    this.publish();
  }

  clearSelection() {
    this.sel = null;
    this.flight = null;
    if (this.follow) this.setFollow(false);
    if (this.layer) this.layer.selectedKey = null;
    this.updateStationHighlight();
    this.publish();
  }

  private ripple: JSAnimation | null = null;

  /** ring the picked station, and send two ripples out from it on the map so it is easy to spot */
  private updateStationHighlight() {
    const map = this.map;
    if (!map?.getLayer('tt-station-sel')) return;
    const ids = this.sel?.kind === 'station' ? this.net.stations[this.sel.idx].group : [];
    map.setFilter('tt-station-sel', ['in', ['get', 'idx'], ['literal', ids]]);
    this.ripple?.pause();
    this.ripple = null;
    if (!map.getLayer('tt-station-ripple')) return;
    map.setFilter('tt-station-ripple', ['in', ['get', 'idx'], ['literal', ids]]);
    map.setPaintProperty('tt-station-ripple', 'circle-stroke-opacity', 0);
    if (!ids.length || reducedMotion()) return;
    this.ripple = tween(
      { r: 9, o: 0.9 },
      { r: 42, o: 0 },
      {
        duration: 1150,
        ease: 'outQuad',
        loop: 1,
        apply: (v) => {
          if (!map.getLayer('tt-station-ripple')) return;
          map.setPaintProperty('tt-station-ripple', 'circle-radius', v.r);
          map.setPaintProperty('tt-station-ripple', 'circle-stroke-opacity', v.o);
        },
      },
    );
  }

  followRandom() {
    const pool = this.visible.filter((s) => s.mode === 'run' || s.mode === 'stop');
    const list = pool.length ? pool : this.visible;
    if (!list.length) {
      this.say('No trains are running right now');
      return;
    }
    const st = list[Math.floor(Math.random() * list.length)];
    this.selectTrain(st.v.key, true);
  }

  toggleLine(id: string) {
    if (this.hidden.has(id)) this.hidden.delete(id);
    else this.hidden.add(id);
    this.applyHidden();
  }

  /** hide or show every line of a group (all hidden → show them all; otherwise hide them all) */
  toggleGroup(group: LineGroup) {
    const lines = this.net.lines.filter((l) => l.group === group);
    const allHidden = lines.every((l) => this.hidden.has(l.id));
    for (const l of lines) {
      if (allHidden) this.hidden.delete(l.id);
      else this.hidden.add(l.id);
    }
    this.applyHidden();
  }

  private applyHidden() {
    const map = this.map;
    if (map?.getLayer('tt-line')) for (const l of ROUTE_LAYERS) map.setFilter(l, routeFilter(l, [...this.hidden]));
    this.savePrefs();
    this.publish();
  }

  /* ---------------------------------------------------------------- time */

  private glide: JSAnimation | null = null;

  /**
   * Move the clock to an instant and let the trains race there instead of jumping: about half a second
   * for a few minutes, up to a second for many hours. Dragging the timeline stops a glide in progress.
   */
  glideTo(ms: number, then?: () => void) {
    this.glide?.pause();
    this.glide = null;
    const from = this.clock.ms;
    const dist = Math.abs(ms - from);
    if (reducedMotion() || dist < 2000 || dist > 30 * 3600 * 1000) {
      this.clock.set(ms);
      then?.();
      this.publish();
      return;
    }
    this.glide = tween(
      { t: from },
      { t: ms },
      {
        duration: Math.min(1100, 450 + (dist / 3.6e6) * 90),
        ease: 'inOutCubic',
        apply: (v) => this.clock.set(v.t),
        done: () => {
          this.glide = null;
          then?.();
          this.publish();
        },
      },
    );
  }

  goLive() {
    if (this.clock.live) return;
    const dist = Math.abs(Date.now() - this.clock.ms);
    // aim a little ahead: real time keeps moving while the trains catch up
    const lead = Math.min(1100, 450 + (dist / 3.6e6) * 90);
    this.glideTo(Date.now() + lead, () => this.clock.goLive());
  }
  togglePause() {
    this.clock.togglePause();
    this.publish();
  }
  setSpeed(s: number) {
    this.clock.setSpeed(s);
    this.publish();
  }
  shift(sec: number) {
    this.glideTo(this.clock.ms + sec * 1000);
  }
  /**
   * go to a time of day (seconds after midnight, may be > 24 h for after-midnight) on the current service day;
   * `glide` lets the trains race there, otherwise the clock jumps (while dragging the timeline)
   */
  setTimeOfDay(sec: number, glide = false) {
    const key = this.serviceDay(this.clock.ms);
    const ms = this.zone.at(key, sec);
    if (glide) return this.glideTo(ms);
    this.glide?.pause();
    this.glide = null;
    this.clock.set(ms);
    this.publish();
  }

  /** the service day an instant belongs to (before 3 am it is still "yesterday") */
  private serviceDay(ms: number) {
    const w = this.zone.wall(ms);
    return w.h < 3 ? addDays(w.key, -1) : w.key;
  }

  /* ---------------------------------------------------------------- input */

  private pickTrain(x: number, y: number, radius = 22): string | null {
    const map = this.map;
    if (!map || !this.layer) return null;
    let best: string | null = null;
    let bd = radius * radius;
    for (const p of this.layer.poses) {
      const s = map.project(this.net.frame.toLngLat(p.x, p.y));
      const d = (s.x - x) ** 2 + (s.y - y) ** 2;
      if (d < bd) {
        bd = d;
        best = p.state.v.key;
      }
    }
    return best;
  }

  private pickStation(x: number, y: number): number | null {
    const map = this.map;
    if (!map?.getLayer('tt-stations')) return null;
    const f = map.queryRenderedFeatures(
      [
        [x - 7, y - 7],
        [x + 7, y + 7],
      ],
      { layers: STATION_LAYERS.filter((l) => map.getLayer(l)) },
    );
    const idx = f[0]?.properties?.idx;
    return typeof idx === 'number' ? idx : null;
  }

  private onClick(ev: MapMouseEvent) {
    const key = this.pickTrain(ev.point.x, ev.point.y);
    if (key) return this.selectTrain(key);
    const st = this.pickStation(ev.point.x, ev.point.y);
    if (st != null) return this.selectStation(st);
    if (this.sel) this.clearSelection();
  }

  private onHover(ev: MapMouseEvent) {
    if (this.hoverQueued) return;
    this.hoverQueued = true;
    requestAnimationFrame(() => {
      this.hoverQueued = false;
      const map = this.map;
      if (!map) return;
      const hit = this.pickTrain(ev.point.x, ev.point.y) != null || this.pickStation(ev.point.x, ev.point.y) != null;
      map.getCanvas().style.cursor = hit ? 'pointer' : '';
    });
  }

  say(text: string) {
    this.toast = { id: ++this.toastSeq, text };
    this.toastUntil = performance.now() + 3200;
    this.publish();
  }

  /* ---------------------------------------------------------------- snapshot for the UI */

  publish() {
    this.store.set(this.snapshot());
  }

  private time(plan: { base: number }, sec: number) {
    return hm(this.zone.wall(plan.base + sec * 1000));
  }

  private snapshot(): Snapshot {
    const ms = this.clock.ms;
    const w = this.zone.wall(ms);
    const day = this.serviceDay(ms);
    const plan = this.sched.plan(day);
    const counts = new Map<string, number>();
    const groupCounts = new Map<string, number>();
    for (const st of this.states) {
      const l = st.trip.pattern.line;
      counts.set(l.id, (counts.get(l.id) ?? 0) + 1);
      groupCounts.set(l.group, (groupCounts.get(l.group) ?? 0) + 1);
    }
    const trains = this.visible
      .map((st) => this.row(st))
      .sort((a, b) => (this.net.lineById.get(a.line.id)!.order - this.net.lineById.get(b.line.id)!.order) || a.id.localeCompare(b.id, 'en', { numeric: true }));
    if (this.toast && performance.now() > this.toastUntil) this.toast = null;
    const next = this.states.length ? null : this.sched.nextService(ms);
    const scrubBase = this.zone.serviceBase(day);
    return {
      ms,
      live: this.clock.live,
      paused: this.clock.paused,
      speed: this.clock.speed,
      clock: hms(w),
      date: keyLabel(w.key),
      service: plan.special ? 'Holiday / special service' : `${WEEKDAYS[weekdayOf(day)]} service`,
      special: plan.special,
      fallback: plan.borrowed.length
        ? `${plan.borrowed.map((b) => `${b.feed} trains follow the ${keyLabel(b.key)} schedule`).join('; ')}: the published timetable does not cover this date yet.`
        : null,
      lines: this.net.lines.map((l) => ({ ...info(l), count: counts.get(l.id) ?? 0, hidden: this.hidden.has(l.id) })),
      groups: GROUPS.filter((g) => this.net.lines.some((l) => l.group === g.id)).map((g) => ({
        ...g,
        count: groupCounts.get(g.id) ?? 0,
        hidden: this.net.lines.filter((l) => l.group === g.id).every((l) => this.hidden.has(l.id)),
      })),
      total: this.states.length,
      trains,
      detail: this.detail(ms),
      follow: this.follow,
      styleMode: this.styleMode,
      pitched: (this.map?.getPitch() ?? 45) > 10,
      nextService: next ? `${hm(this.zone.wall(next))} (${untilLabel((next - ms) / 1000)})` : null,
      scrub: Math.round((ms - scrubBase) / 1000),
      toast: this.toast,
      stations: this.stationList,
      dark: this.dark,
      ready: this.ticked,
      profile: this.serviceProfile(day),
    };
  }

  private readonly profiles = new Map<string, ServiceProfile>();
  private ticked = false;

  /** how many trains run at each time of the service day (04:00 to 04:00), in 10-minute bins */
  private serviceProfile(day: string): ServiceProfile {
    const hit = this.profiles.get(day);
    if (hit) return hit;
    const from = 4 * 3600;
    const step = 600;
    const n = 144;
    const groups = GROUPS.filter((g) => this.net.lines.some((l) => l.group === g.id)).map((g) => ({ id: g.id, color: g.color }));
    const gi = new Map(groups.map((g, i) => [g.id, i]));
    const bins = Array.from({ length: n }, () => new Array<number>(groups.length).fill(0));
    for (const tr of this.sched.plan(day).trips) {
      const g = gi.get(tr.pattern.line.group);
      if (g === undefined) continue;
      const a = Math.max(0, Math.floor((tr.start - from) / step));
      const b = Math.min(n - 1, Math.floor((tr.end - from) / step));
      for (let i = a; i <= b; i++) {
        const lo = Math.max(tr.start, from + i * step);
        const hi = Math.min(tr.end, from + (i + 1) * step);
        if (hi > lo) bins[i][g] += (hi - lo) / step;
      }
    }
    let max = 1;
    for (const b of bins) max = Math.max(max, b.reduce((x, y) => x + y, 0));
    const p = { key: day, from, step, groups, bins, max };
    this.profiles.set(day, p);
    if (this.profiles.size > 4) this.profiles.delete(this.profiles.keys().next().value!);
    return p;
  }

  private where(st: TrainState): { status: string; eta: string } {
    const p = st.trip.pattern;
    const stn = p.stations[st.k];
    const left = st.nextT - st.t;
    switch (st.mode) {
      case 'standby':
        return { status: `Boarding at ${stn.name}`, eta: `dep ${untilLabel(left)}` };
      case 'stop':
        if (stn.edge) return { status: 'Coming into the region', eta: '' };
        return { status: `At ${stn.name}`, eta: `dep ${untilLabel(left)}` };
      case 'arrived':
        return { status: `Arrived at ${stn.name}`, eta: '' };
      default: {
        const next = p.stations[st.k + 1];
        if (next.edge) return { status: `Leaving the region towards ${p.headsign}`, eta: '' };
        return { status: `Next: ${next.name}`, eta: untilLabel(left) };
      }
    }
  }

  /** first and last real station of a trip (VIA trips can start or end at the edge of the map) */
  private ends(p: TrainState['trip']['pattern']): { from: string; to: string } {
    const real = p.stations.filter((s) => !s.edge);
    return { from: p.enters ? `(beyond the map) · ${real[0]?.name ?? ''}` : real[0]?.name ?? '', to: p.leaves ? `${real[real.length - 1]?.name ?? ''} · ${p.headsign}` : real[real.length - 1]?.name ?? '' };
  }

  private row(st: TrainState): TrainRow {
    const w = this.where(st);
    return {
      key: st.v.key,
      id: trainName(st.trip, st.v),
      line: info(st.trip.pattern.line),
      headsign: st.trip.pattern.headsign,
      status: w.status,
      eta: w.eta,
      ug: this.net.isUnderground(st.trip.pattern.shape, st.dist),
    };
  }

  private detail(ms: number): TrainDetail | StationDetail | null {
    const sel = this.sel;
    if (!sel) return null;
    if (sel.kind === 'station') return this.stationDetail(sel.idx, ms);
    const v = this.sched.findVehicle(sel.key);
    if (!v) return null;
    const st = this.states.find((s) => s.v.key === sel.key) ?? null;
    if (st) return this.trainDetail(v, st);
    return this.hiddenTrainDetail(v, ms);
  }

  private trainDetail(v: Vehicle, st: TrainState): TrainDetail {
    const tr = st.trip;
    const p = tr.pattern;
    const n = p.stations.length;
    const w = this.where(st);
    const plan = v.plan;
    const stops: StopRow[] = [];
    p.stations.forEach((s, k) => {
      if (s.edge) return;
      let state: StopRow['state'] = 'future';
      if (st.mode === 'run') state = k <= st.k ? 'past' : k === st.k + 1 ? 'next' : 'future';
      else state = k < st.k ? 'past' : k === st.k ? 'now' : 'future';
      stops.push({ name: s.name, time: this.time(plan, tr.start + tr.t[2 * k + (k === 0 ? 1 : 0)]), state });
    });
    const { from, to } = this.ends(p);
    const span = p.dist[n - 1] - p.dist[0] || 1;
    const idx = v.trips.indexOf(tr);
    const nx = v.trips[idx + 1];
    let sub = '';
    if (st.mode === 'run') sub = `Arrives ${this.time(plan, st.nextT)} · ${w.eta}`;
    else if (st.mode === 'stop' || st.mode === 'standby') sub = `Departs ${this.time(plan, st.nextT)} · ${w.eta.replace('dep ', '')}`;
    else sub = nx ? `Next trip to ${nx.pattern.headsign} at ${this.time(plan, nx.start)}` : 'Last trip of the day';
    return {
      kind: 'train',
      key: v.key,
      id: trainName(tr, v),
      line: info(p.line),
      visible: true,
      headsign: p.headsign,
      status: w.status,
      sub,
      progress: Math.max(0, Math.min(1, (st.dist - p.dist[0]) / span)),
      from,
      to,
      speed: st.mode === 'run' ? `${Math.round(st.speed * 3.6)} km/h` : '0 km/h',
      stock: consistFor(p.line, p.dir).label,
      run: tr.id,
      ug: this.net.isUnderground(p.shape, st.dist),
      stops,
      next: nx ? `${nx.pattern.headsign} · ${this.time(plan, nx.start)}` : null,
    };
  }

  private hiddenTrainDetail(v: Vehicle, ms: number): TrainDetail {
    const t = (ms - v.plan.base) / 1000;
    const next = v.trips.find((tr) => tr.start > t) ?? null;
    const prev = [...v.trips].reverse().find((tr) => tr.end <= t) ?? null;
    const ref = next ?? prev ?? v.trips[0];
    const p = ref.pattern;
    let status = 'Not in service';
    let sub = '';
    if (next && prev) {
      const at = p.enters ? 'the edge of the map' : p.stations[0].name;
      status = next.start - t > 900 ? `Out of service until ${this.time(v.plan, next.start)}` : `Turning back at ${at}`;
      sub = `Next trip to ${p.headsign} at ${this.time(v.plan, next.start)}`;
    } else if (next) {
      status = 'Not yet in service';
      sub = `First trip to ${p.headsign} at ${this.time(v.plan, next.start)}`;
    } else if (prev) {
      status = 'Finished for the day';
      sub = prev.pattern.leaves ? `Left the region towards ${prev.pattern.headsign}` : `Last arrival at ${prev.pattern.stations[prev.pattern.stations.length - 1].name}, ${this.time(v.plan, prev.end)}`;
    }
    const { from, to } = this.ends(p);
    return {
      kind: 'train',
      key: v.key,
      id: trainName(ref, v),
      line: info(p.line),
      visible: false,
      headsign: p.headsign,
      status,
      sub,
      progress: 0,
      from,
      to,
      speed: '–',
      stock: consistFor(p.line, p.dir).label,
      run: ref.id,
      ug: false,
      stops: [],
      next: next ? `${next.pattern.headsign} · ${this.time(v.plan, next.start)}` : null,
    };
  }

  private stationDetail(idx: number, ms: number): StationDetail {
    const st = this.net.stations[idx];
    const group = new Set(st.group);
    const lines = new Map<string, Line>();
    for (const i of st.group) for (const l of this.net.stations[i].lines) lines.set(l.id, l);
    const groups = this.sched.departures(st.group, ms, 3).map((g) => ({
      line: info(g.line),
      headsign: g.headsign,
      items: g.items.map((d) => ({ time: hm(this.zone.wall(d.ms)), until: untilLabel((d.ms - ms) / 1000), key: d.vehicle?.key ?? null })),
    }));
    const here = this.visible
      .filter((s) => s.mode !== 'run' && group.has(s.trip.pattern.stations[s.k].idx))
      .map((s) => ({ key: s.v.key, id: trainName(s.trip, s.v), line: info(s.trip.pattern.line), headsign: s.trip.pattern.headsign, what: this.where(s).eta }));
    return {
      kind: 'station',
      idx,
      name: st.name,
      stop: st.stop,
      lines: [...lines.values()].sort((a, b) => a.order - b.order).map(info),
      groups,
      here,
    };
  }

  /** parse ?at=2026-10-14T08:15 (Toronto time) */
  static parseAt(value: string | null, tz: string): number | undefined {
    if (!value) return undefined;
    const m = /^(\d{4})-?(\d{2})-?(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(value.trim());
    if (!m) return undefined;
    const zone = new Zone(tz);
    return zone.at(`${m[1]}${m[2]}${m[3]}`, +(m[4] ?? 8) * 3600 + +(m[5] ?? 0) * 60 + +(m[6] ?? 0));
  }
}
