import type { FeatureCollection, LineString, Point } from 'geojson';
import { LINE_OFFSET, TUNNELS } from '../config';
import type { LineGroup, LineMode, TransitData } from '../types';
import { LocalFrame, Path, type PathPoint } from './geo';

export interface Line {
  id: string;
  name: string;
  short: string;
  color: string;
  textColor: string;
  group: LineGroup;
  mode: LineMode;
  order: number;
}

export interface Station {
  /** index into Network.stations; -1 for an edge point */
  idx: number;
  id: string;
  name: string;
  lon: number;
  lat: number;
  x: number;
  y: number;
  lines: Line[];
  /** a streetcar stop rather than a station */
  stop: boolean;
  /** not a station: where a VIA train enters or leaves the region covered by the map */
  edge: boolean;
  /** stations sharing this name nearby (they are one place for departures and platform use) */
  group: number[];
}

export interface Shape {
  idx: number;
  id: string;
  line: Line;
  path: Path;
  /** underground stretches as [from, to] distances, sorted */
  ug: [number, number][];
}

export interface Pattern {
  idx: number;
  id: string;
  line: Line;
  dir: number;
  headsign: string;
  shape: Shape;
  stations: Station[];
  /** distance of each stop along the shape */
  dist: Float64Array;
  /** travel direction at each stop (unit vector) */
  hx: Float32Array;
  hy: Float32Array;
  /** the trip starts / ends at the edge of the region rather than at a station */
  enters: boolean;
  leaves: boolean;
}

type RouteProps = { line: string; color: string; ug: boolean; off: number; group: LineGroup; z: number };

/** drawing order: regional rail at the bottom, night streetcars under the daytime routes, the subway on top */
const Z: Record<LineGroup, number> = { via: 0, go: 1, airport: 2, streetcar: 4, lrt: 5, subway: 6 };

export const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

export class Network {
  readonly frame: LocalFrame;
  readonly lines: Line[];
  readonly lineById = new Map<string, Line>();
  readonly stations: Station[];
  readonly shapes: Shape[];
  readonly patterns: Pattern[];
  /** the whole network, and the TTC subway + LRT */
  readonly bounds: [[number, number], [number, number]];
  readonly cityBounds: [[number, number], [number, number]];
  /** for each station: the patterns calling there and at which stop */
  readonly calls: { pattern: Pattern; k: number }[][];

  constructor(data: TransitData) {
    const extent = (list: { lon: number; lat: number }[]): [[number, number], [number, number]] => {
      let w = Infinity;
      let s = Infinity;
      let e = -Infinity;
      let n = -Infinity;
      for (const st of list) {
        w = Math.min(w, st.lon);
        e = Math.max(e, st.lon);
        s = Math.min(s, st.lat);
        n = Math.max(n, st.lat);
      }
      return [
        [w, s],
        [e, n],
      ];
    };
    this.bounds = extent(data.stations);
    const lineGroup = new Map(data.lines.map((l) => [l.id, l.group]));
    const rapid = data.stations.filter((s) => s.lines.some((l) => lineGroup.get(l) === 'subway' || lineGroup.get(l) === 'lrt'));
    this.cityBounds = rapid.length ? extent(rapid) : this.bounds;
    // origin: the middle of the city (keeps local coordinates small where most trains are)
    const [[cw, cs], [ce, cn]] = this.cityBounds;
    const frame = (this.frame = new LocalFrame((cw + ce) / 2, (cs + cn) / 2));

    this.lines = data.lines.map((l, i) => ({ id: l.id, name: l.name, short: l.short, color: l.color, textColor: l.textColor, group: l.group, mode: l.mode, order: i }));
    for (const l of this.lines) this.lineById.set(l.id, l);
    const lineOf = (id: string) => this.lineById.get(id) ?? this.lines[0];

    this.stations = data.stations.map((st, idx) => {
      const p = frame.toLocal(st.lon, st.lat);
      return { idx, id: st.id, name: st.name, lon: st.lon, lat: st.lat, x: p.x, y: p.y, lines: st.lines.map(lineOf), stop: st.kind === 'stop', edge: false, group: [idx] };
    });
    // same name within a kilometre = one place (e.g. the two streetcar stops either side of an intersection)
    const byName = new Map<string, Station[]>();
    for (const st of this.stations) byName.set(norm(st.name), [...(byName.get(norm(st.name)) ?? []), st]);
    for (const st of this.stations) st.group = (byName.get(norm(st.name)) ?? [st]).filter((o) => Math.hypot(o.x - st.x, o.y - st.y) < 1000).map((o) => o.idx);

    this.shapes = data.shapes.map((sh, idx) => {
      const m = sh.d.length / 2;
      const px = new Float64Array(m);
      const py = new Float64Array(m);
      const q = { x: 0, y: 0 };
      let lon = 0;
      let lat = 0;
      for (let i = 0; i < m; i++) {
        lon += sh.d[2 * i];
        lat += sh.d[2 * i + 1];
        frame.toLocal(lon / 1e6, lat / 1e6, q);
        px[i] = q.x;
        py[i] = q.y;
      }
      const line = lineOf(sh.line);
      // long regional tracks are sampled more coarsely (they are straight for kilometres)
      const step = line.group === 'go' || line.group === 'via' ? 4 : 2;
      return { idx, id: sh.id, line, path: new Path(px, py, step), ug: [] };
    });

    const pt: PathPoint = { x: 0, y: 0, tx: 0, ty: 0 };
    this.patterns = data.patterns.map((p, idx) => {
      const shape = this.shapes[p.shape];
      const line = lineOf(p.line);
      const dist = Float64Array.from(p.at, (a) => shape.path.distAtVertex(a));
      for (let k = 1; k < dist.length; k++) dist[k] = Math.max(dist[k], dist[k - 1]);
      const hx = new Float32Array(dist.length);
      const hy = new Float32Array(dist.length);
      dist.forEach((d, k) => {
        shape.path.at(d, pt);
        hx[k] = pt.tx;
        hy[k] = pt.ty;
      });
      const stations = p.stations.map((i, k) => {
        if (i >= 0) return this.stations[i];
        shape.path.at(dist[k], pt);
        const [lon, lat] = frame.toLngLat(pt.x, pt.y);
        return { idx: -1, id: `edge:${idx}:${k}`, name: 'edge of the map', lon, lat, x: pt.x, y: pt.y, lines: [line], stop: false, edge: true, group: [] } satisfies Station;
      });
      return {
        idx,
        id: p.id,
        line,
        dir: p.dir,
        headsign: p.headsign,
        shape,
        stations,
        dist,
        hx,
        hy,
        enters: stations[0].edge,
        leaves: stations[stations.length - 1].edge,
      };
    });

    this.calls = this.stations.map(() => []);
    for (const p of this.patterns) p.stations.forEach((st, k) => st.idx >= 0 && this.calls[st.idx].push({ pattern: p, k }));

    this.markUnderground();
  }

  /**
   * Marks the tunnel stretches of every track from the TUNNELS table, per pair of successive stations.
   * Distances and underground state both come from the same shape, so dashed track lines and see-through
   * train models agree in either travel direction.
   */
  private markUnderground() {
    const ranges = new Map<Shape, [number, number][]>();
    const rules = new Map<string, { base: 'tunnel' | 'surface'; links: (typeof TUNNELS)[number]['links'] }>();
    for (const r of TUNNELS) {
      for (const id of r.lines) {
        const have = rules.get(id);
        if (have) have.links = [...have.links, ...r.links];
        else rules.set(id, { base: r.base, links: [...r.links] });
      }
    }
    for (const p of this.patterns) {
      const rule = rules.get(p.line.id);
      if (!rule) continue;
      const list = ranges.get(p.shape) ?? [];
      for (let k = 0; k < p.stations.length - 1; k++) {
        const a = norm(p.stations[k].name);
        const b = norm(p.stations[k + 1].name);
        const start = p.dist[k];
        const length = p.dist[k + 1] - start;
        if (length <= 0) continue;
        // GTFS shapes follow the trip direction; reverse the fractions for trips the other way
        let spans: [number, number][] | null = null;
        let surface = false;
        for (const link of rule.links) {
          const forward = link.from === a && link.to === b;
          const reverse = link.from === b && link.to === a;
          if (!forward && !reverse) continue;
          surface = !!link.surface;
          spans = (link.tunnel ?? link.surface ?? []).map(([f1, f2]) => (forward ? [f1, f2] : [1 - f2, 1 - f1]) as [number, number]);
          break;
        }
        let tunnel: [number, number][];
        if (spans === null) tunnel = rule.base === 'tunnel' ? [[0, 1]] : [];
        else if (!surface) tunnel = spans;
        else {
          // the complement of the surface stretches
          tunnel = [];
          let at = 0;
          for (const [f1, f2] of [...spans].sort((x, y) => x[0] - y[0])) {
            if (f1 > at) tunnel.push([at, f1]);
            at = Math.max(at, f2);
          }
          if (at < 1) tunnel.push([at, 1]);
        }
        for (const [f1, f2] of tunnel) list.push([start + length * f1, start + length * f2]);
      }
      if (list.length) ranges.set(p.shape, list);
    }

    for (const [shape, list] of ranges) {
      list.sort((a, b) => a[0] - b[0]);
      const merged: [number, number][] = [];
      for (const segment of list) {
        const last = merged[merged.length - 1];
        if (last && segment[0] <= last[1] + 1) last[1] = Math.max(last[1], segment[1]);
        else merged.push([...segment]);
      }
      shape.ug = merged.filter(([a, b]) => b - a > 20);
    }
  }

  isUnderground(shape: Shape, d: number): boolean {
    for (const r of shape.ug) if (d >= r[0] && d <= r[1]) return true;
    return false;
  }

  /**
   * One drawable set of route lines per line: the longest track first, then only the parts of
   * other shapes not already drawn (the two directions of a line usually share one polyline).
   */
  routeGeoJSON(): FeatureCollection<LineString, RouteProps> {
    const features: FeatureCollection<LineString, RouteProps>['features'] = [];
    const CELL = 30;
    for (const line of this.lines) {
      const sample = line.group === 'go' || line.group === 'via' ? 16 : 8;
      const covered = new Set<string>();
      const cellKey = (x: number, y: number) => `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`;
      const isCovered = (x: number, y: number) => {
        const cx = Math.floor(x / CELL);
        const cy = Math.floor(y / CELL);
        for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) if (covered.has(`${cx + i},${cy + j}`)) return true;
        return false;
      };
      const shapes = this.shapes.filter((s) => s.line === line).sort((a, b) => b.path.L - a.path.L);
      const pt: PathPoint = { x: 0, y: 0, tx: 0, ty: 0 };
      for (const shape of shapes) {
        const P = shape.path;
        const count = Math.max(2, Math.ceil(P.L / sample) + 1);
        const xs: number[] = [];
        const ys: number[] = [];
        const ds: number[] = [];
        const free: boolean[] = [];
        for (let i = 0; i < count; i++) {
          const d = (P.L * i) / (count - 1);
          P.at(d, pt);
          xs.push(pt.x);
          ys.push(pt.y);
          ds.push(d);
          free.push(!isCovered(pt.x, pt.y));
        }
        // runs of uncovered samples, one sample of overlap at each end so pieces join up
        let i = 0;
        while (i < count) {
          if (!free[i]) {
            i++;
            continue;
          }
          let j = i;
          while (j + 1 < count && free[j + 1]) j++;
          const a = Math.max(0, i - 1);
          const b = Math.min(count - 1, j + 1);
          if ((b - a) * sample >= 40 || shapes.length === 1) this.pushRun(features, line, shape, xs, ys, ds, a, b);
          i = j + 1;
        }
        for (let k = 0; k < count; k++) covered.add(cellKey(xs[k], ys[k]));
      }
    }
    return { type: 'FeatureCollection', features };
  }

  private pushRun(out: FeatureCollection<LineString, RouteProps>['features'], line: Line, shape: Shape, xs: number[], ys: number[], ds: number[], a: number, b: number) {
    let idx: number[] = [];
    for (let k = a; k <= b; k++) idx.push(k);
    // draw every run in one consistent direction so side-by-side offsets keep each line in its own lane
    const dx = xs[b] - xs[a];
    const dy = ys[b] - ys[a];
    if (Math.abs(dy) >= Math.abs(dx) ? dy > 0 : dx < 0) idx = idx.reverse();
    let cur: number[] = [];
    let curUg: boolean | null = null;
    const flush = () => {
      if (cur.length >= 2) {
        out.push({
          type: 'Feature',
          properties: { line: line.id, color: line.color, ug: !!curUg, off: LINE_OFFSET[line.id] ?? 0, group: line.group, z: Z[line.group] - (line.group === 'streetcar' && line.short.startsWith('3') ? 1 : 0) },
          geometry: { type: 'LineString', coordinates: cur.map((k) => this.frame.toLngLat(xs[k], ys[k])) },
        });
      }
    };
    for (const k of idx) {
      const ug = this.isUnderground(shape, ds[k]);
      if (curUg !== null && ug !== curUg) {
        cur.push(k);
        flush();
        cur = [k];
      } else cur.push(k);
      curUg = ug;
    }
    flush();
  }

  stationGeoJSON(): FeatureCollection<Point, { idx: number; name: string; n: number; color: string; stop: boolean; rank: number }> {
    return {
      type: 'FeatureCollection',
      features: this.stations.map((st) => {
        const groups = new Set(st.lines.map((l) => l.group));
        // label priority: interchanges, then rapid transit stations, regional stations, streetcar stops
        const rank = st.stop ? 3 : groups.size > 1 || st.lines.length > 2 ? 0 : groups.has('subway') || groups.has('lrt') ? 1 : 2;
        const solo = st.lines.length === 1 || groups.size === 1;
        return {
          type: 'Feature',
          properties: { idx: st.idx, name: st.name, n: st.lines.length, color: solo ? st.lines[0].color : '#1d2633', stop: st.stop, rank },
          geometry: { type: 'Point', coordinates: [st.lon, st.lat] },
        };
      }),
    };
  }
}
