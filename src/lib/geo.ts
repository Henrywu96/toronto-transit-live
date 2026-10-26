/**
 * Geometry on a local plane. Everything the trains need is computed in "local metres": x east,
 * y north, relative to an origin near the middle of the network, using the same Web Mercator
 * maths as MapLibre (so the three.js layer lines up with the map exactly, in double precision).
 */

const EARTH_CIRCUMFERENCE = 2 * Math.PI * 6371008.8; // MapLibre's value

export const mercX = (lon: number) => (180 + lon) / 360;
export const mercY = (lat: number) => (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) / 360;
export const lonFromMercX = (x: number) => x * 360 - 180;
export const latFromMercY = (y: number) => (360 / Math.PI) * Math.atan(Math.exp(((180 - y * 360) * Math.PI) / 180)) - 90;

export interface XY {
  x: number;
  y: number;
}

export class LocalFrame {
  /** origin in Mercator units (0…1) */
  readonly mx0: number;
  readonly my0: number;
  /** Mercator units per local metre */
  readonly k: number;

  constructor(readonly lon0: number, readonly lat0: number) {
    this.mx0 = mercX(lon0);
    this.my0 = mercY(lat0);
    this.k = 1 / EARTH_CIRCUMFERENCE / Math.cos((lat0 * Math.PI) / 180);
  }

  toLocal(lon: number, lat: number, out: XY = { x: 0, y: 0 }): XY {
    out.x = (mercX(lon) - this.mx0) / this.k;
    out.y = -(mercY(lat) - this.my0) / this.k;
    return out;
  }

  toLngLat(x: number, y: number): [number, number] {
    return [lonFromMercX(this.mx0 + x * this.k), latFromMercY(this.my0 - y * this.k)];
  }

  /** local metres covered by one CSS pixel at a zoom level (MapLibre tiles are 512 px) */
  metersPerPixel(zoom: number): number {
    return 1 / (this.k * 512 * 2 ** zoom);
  }
}

export interface PathPoint {
  x: number;
  y: number;
  /** unit tangent in the direction of travel */
  tx: number;
  ty: number;
}

/**
 * A polyline resampled into an even table (about every 2 m) with smoothed tangents, so the
 * position at any distance is two array reads and a lerp. Distances outside the line continue
 * straight on from its ends (useful for long trains standing at a terminus).
 */
export class Path {
  readonly L: number;
  readonly n: number;
  readonly step: number;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly tx: Float32Array;
  readonly ty: Float32Array;
  /** distance at each original vertex */
  readonly vd: Float64Array;

  constructor(px: ArrayLike<number>, py: ArrayLike<number>, approxStep = 2) {
    const m = px.length;
    const vd = new Float64Array(m);
    for (let i = 1; i < m; i++) vd[i] = vd[i - 1] + Math.hypot(px[i] - px[i - 1], py[i] - py[i - 1]);
    this.vd = vd;
    const L = (this.L = Math.max(vd[m - 1], 1e-6));
    const n = (this.n = Math.max(2, Math.ceil(L / approxStep) + 1));
    const step = (this.step = L / (n - 1));
    const x = (this.x = new Float32Array(n));
    const y = (this.y = new Float32Array(n));
    let seg = 0;
    for (let i = 0; i < n; i++) {
      const s = i === n - 1 ? L : i * step;
      while (seg < m - 2 && vd[seg + 1] < s) seg++;
      const len = vd[seg + 1] - vd[seg];
      const t = len > 0 ? Math.min(1, Math.max(0, (s - vd[seg]) / len)) : 0;
      x[i] = px[seg] + (px[seg + 1] - px[seg]) * t;
      y[i] = py[seg] + (py[seg + 1] - py[seg]) * t;
    }
    // tangents from samples about ±6 m apart: rounds off polyline corners so cars turn smoothly
    const w = Math.max(1, Math.round(6 / step));
    const tx = (this.tx = new Float32Array(n));
    const ty = (this.ty = new Float32Array(n));
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - w);
      const b = Math.min(n - 1, i + w);
      const dx = x[b] - x[a];
      const dy = y[b] - y[a];
      const l = Math.hypot(dx, dy) || 1;
      tx[i] = dx / l;
      ty[i] = dy / l;
    }
  }

  at(s: number, o: PathPoint): PathPoint {
    const { n, x, y, tx, ty } = this;
    if (s <= 0) {
      o.tx = tx[0];
      o.ty = ty[0];
      o.x = x[0] + tx[0] * s;
      o.y = y[0] + ty[0] * s;
      return o;
    }
    if (s >= this.L) {
      const e = s - this.L;
      o.tx = tx[n - 1];
      o.ty = ty[n - 1];
      o.x = x[n - 1] + tx[n - 1] * e;
      o.y = y[n - 1] + ty[n - 1] * e;
      return o;
    }
    const f = s / this.step;
    const k = Math.min(n - 2, Math.floor(f));
    const t = f - k;
    o.x = x[k] + (x[k + 1] - x[k]) * t;
    o.y = y[k] + (y[k + 1] - y[k]) * t;
    const ax = tx[k] + (tx[k + 1] - tx[k]) * t;
    const ay = ty[k] + (ty[k + 1] - ty[k]) * t;
    const l = Math.hypot(ax, ay) || 1;
    o.tx = ax / l;
    o.ty = ay / l;
    return o;
  }

  /** distance along the path of a position given as vertex index + fraction */
  distAtVertex(at: number): number {
    const vd = this.vd;
    const i = Math.max(0, Math.min(vd.length - 2, Math.floor(at)));
    const f = Math.max(0, Math.min(1, at - i));
    return vd[i] + (vd[i + 1] - vd[i]) * f;
  }
}
