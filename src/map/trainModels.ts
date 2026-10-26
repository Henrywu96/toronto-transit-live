import {
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  Color,
  InstancedMesh,
  Material,
  Matrix4,
  MeshBasicMaterial,
  MeshLambertMaterial,
  PlaneGeometry,
  Float32BufferAttribute,
  SRGBColorSpace,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Line } from '../lib/network';

/**
 * The Toronto area's trains, modelled loosely after photos of the real fleets:
 *
 *  - TTC Toronto Rocket (Lines 1 and 4): stainless steel, black window band, open gangways between cars
 *  - TTC T1 (Line 2): stainless steel, separate windows, red accents
 *  - Alstom Flexity Freedom (Line 5) and Citadis Spirit (Line 6): white low-floor light rail
 *  - Bombardier Flexity Outlook (streetcars): TTC red and white, five modules
 *  - GO Transit: a green and white locomotive with bilevel coaches and a cab car
 *  - UP Express diesel multiple units, VIA Rail Venture trainsets, and the Terminal Link people mover
 *
 * Every section is built in its own frame (x forward, y up, z to the right). The sides are painted with
 * canvas textures; all parts are instanced so the whole fleet draws in a few dozen calls.
 */

export type ModelKey = 'tr' | 't1' | 'freedom' | 'citadis' | 'outlook' | 'bilevel' | 'dmu' | 'venture' | 'apm';
/** which painting and geometry a section uses: front cab, rear cab (or cab car), or a middle section */
export type Role = 'cabF' | 'cabR' | 'midA' | 'midB';

export interface ModelSpec {
  key: ModelKey;
  name: string;
  /** section length, articulation gap and gap between coupled cars (m) */
  secLen: number;
  art: number;
  coupler: number;
  w: number;
  /** body height above the underframe */
  h: number;
  /** floor / underframe height */
  bottom: number;
  /** how far the windscreen leans back */
  nose: number;
  /** roof edge radius, front corner radius in plan */
  roofR: number;
  cornerR: number;
  /** bottom of the windscreen, as a share of the body height */
  winLow: number;
  /** pantographs on the roof (electric light rail and streetcars) */
  panto: boolean;
  /** most sections of this model drawn at once */
  cap: number;
}

const M = (key: ModelKey, name: string, o: Omit<ModelSpec, 'key' | 'name'>): ModelSpec => ({ key, name, ...o });

export const MODELS: Record<ModelKey, ModelSpec> = {
  tr: M('tr', 'Bombardier Toronto Rocket', { secLen: 22.7, art: 0.8, coupler: 0.8, w: 3.14, h: 2.95, bottom: 0.95, nose: 1.1, roofR: 0.45, cornerR: 0.65, winLow: 0.5, panto: false, cap: 800 }),
  t1: M('t1', 'Bombardier T1', { secLen: 22.7, art: 1.0, coupler: 1.0, w: 3.14, h: 2.95, bottom: 0.95, nose: 0.35, roofR: 0.4, cornerR: 0.3, winLow: 0.5, panto: false, cap: 600 }),
  freedom: M('freedom', 'Alstom Flexity Freedom', { secLen: 5.8, art: 0.25, coupler: 1.1, w: 2.65, h: 3.05, bottom: 0.35, nose: 1.3, roofR: 0.62, cornerR: 0.95, winLow: 0.44, panto: true, cap: 500 }),
  citadis: M('citadis', 'Alstom Citadis Spirit', { secLen: 11.9, art: 0.3, coupler: 1.1, w: 2.65, h: 3.1, bottom: 0.35, nose: 1.2, roofR: 0.6, cornerR: 0.9, winLow: 0.4, panto: true, cap: 200 }),
  outlook: M('outlook', 'Bombardier Flexity Outlook', { secLen: 5.8, art: 0.3, coupler: 1, w: 2.54, h: 3.0, bottom: 0.35, nose: 1.05, roofR: 0.55, cornerR: 0.8, winLow: 0.45, panto: true, cap: 1600 }),
  bilevel: M('bilevel', 'GO bilevel', { secLen: 25.9, art: 1.1, coupler: 1.1, w: 3.0, h: 4.05, bottom: 0.7, nose: 1.0, roofR: 0.7, cornerR: 0.45, winLow: 0.58, panto: false, cap: 2000 }),
  dmu: M('dmu', 'Nippon Sharyo DMU', { secLen: 25.9, art: 1.0, coupler: 1.0, w: 3.05, h: 3.15, bottom: 1.1, nose: 1.7, roofR: 0.55, cornerR: 0.85, winLow: 0.5, panto: false, cap: 150 }),
  venture: M('venture', 'Siemens Venture', { secLen: 25.9, art: 1.0, coupler: 1.0, w: 3.0, h: 3.0, bottom: 1.05, nose: 1.9, roofR: 0.55, cornerR: 0.95, winLow: 0.5, panto: false, cap: 300 }),
  apm: M('apm', 'Doppelmayr Cable Liner', { secLen: 4.6, art: 0.6, coupler: 0.6, w: 2.5, h: 2.5, bottom: 0.5, nose: 0.9, roofR: 0.55, cornerR: 0.75, winLow: 0.35, panto: false, cap: 80 }),
};

export interface SectionSpec {
  /** distance from the nose of the train to the centre of this section */
  off: number;
  len: number;
  role: Role;
  /** turned round (a cab at the rear faces backwards) */
  flip: boolean;
  panto: boolean;
}
export interface Consist {
  model: ModelSpec;
  sections: SectionSpec[];
  length: number;
  label: string;
  /** smallest on-screen size when zoomed out (px): long trains stay long, streetcars stay small */
  minPx: number;
  minW: number;
}

/** how each line's trains are made up (cars per train is typical service, not every run) */
interface Makeup {
  model: ModelKey;
  /** vehicles coupled together; each one has a cab at both ends */
  units: number;
  /** sections per vehicle, cabs included */
  sections: number;
  /** locomotive-hauled: a locomotive at one end and a cab car at the other */
  push?: boolean;
  label: string;
  minPx: number;
  minW?: number;
}

function makeupFor(line: Line): Makeup {
  switch (line.mode) {
    case 'subway':
      if (line.id === 'l2') return { model: 't1', units: 1, sections: 6, label: 'Bombardier T1 × 6 cars', minPx: 60 };
      if (line.id === 'l4') return { model: 'tr', units: 1, sections: 4, label: 'Toronto Rocket × 4 cars', minPx: 50 };
      return { model: 'tr', units: 1, sections: 6, label: 'Toronto Rocket × 6 cars (open gangways)', minPx: 60 };
    case 'lrt':
      if (line.id === 'l6') return { model: 'citadis', units: 1, sections: 4, label: 'Alstom Citadis Spirit, 4 sections (low floor)', minPx: 44 };
      return { model: 'freedom', units: 2, sections: 5, label: 'Alstom Flexity Freedom × 2 (low floor)', minPx: 48 };
    case 'streetcar':
      return { model: 'outlook', units: 1, sections: 5, label: 'Bombardier Flexity Outlook, 5 modules (low floor)', minPx: 34, minW: 9 };
    case 'go':
      return { model: 'bilevel', units: 1, sections: 11, push: true, label: 'MP40 locomotive + 10 bilevel coaches', minPx: 84 };
    case 'up':
      return { model: 'dmu', units: 1, sections: 3, label: 'Nippon Sharyo DMU × 3 cars', minPx: 46 };
    case 'via':
      return { model: 'venture', units: 1, sections: 6, push: true, label: 'Siemens Charger + Venture coaches', minPx: 66 };
    case 'tl':
      return { model: 'apm', units: 1, sections: 7, label: 'Cable-hauled people mover, 7 cars', minPx: 28, minW: 8 };
  }
}

const consists = new Map<string, Consist>();

function buildConsist(mk: Makeup, reversed: boolean): Consist {
  const m = MODELS[mk.model];
  const sections: SectionSpec[] = [];
  let x = 0;
  for (let u = 0; u < mk.units; u++) {
    for (let i = 0; i < mk.sections; i++) {
      const first = i === 0;
      const last = i === mk.sections - 1;
      let role: Role = first ? 'cabF' : last ? 'cabR' : i % 2 ? 'midA' : 'midB';
      let flip = last && !first;
      if (mk.push && reversed) {
        // running cab car first: the cab car leads, the locomotive pushes from the back (facing backwards)
        if (first) {
          role = 'cabR';
          flip = false;
        } else if (last) {
          role = 'cabF';
          flip = true;
        }
      }
      const panto = m.panto && (mk.sections <= 3 ? i === 0 : i === Math.floor(mk.sections / 2));
      sections.push({ off: x + m.secLen / 2, len: m.secLen, role, flip, panto });
      x += m.secLen + (last ? (u < mk.units - 1 ? m.coupler : 0) : m.art);
    }
  }
  return { model: m, sections, length: x, label: mk.label, minPx: mk.minPx, minW: mk.minW ?? 11 };
}

/** how a train is drawn; locomotive-hauled trains lead with the cab car on trips towards Union (direction 1) */
export function consistFor(line: Line, dir = 0): Consist {
  const mk = makeupFor(line);
  const reversed = !!mk.push && dir === 1;
  const key = `${line.mode}:${line.id === 'l2' || line.id === 'l4' || line.id === 'l6' ? line.id : ''}:${reversed ? 'r' : ''}`;
  let c = consists.get(key);
  if (!c) consists.set(key, (c = buildConsist(mk, reversed)));
  return c;
}

/* ------------------------------------------------------------------ side paintings */

const GLASS = '#1a2230';
const TTC_RED = '#da291c';
const STEEL = '#c3c9cf';
const WHITE = '#eef0ee';
const GO_GREEN = '#00853e';
const GO_LIME = '#7ab800';

interface Painted {
  map: CanvasTexture;
  glow: CanvasTexture;
}

/** a painter's description of one model's side: everything in (u, v) units of the section */
interface Livery {
  body: string;
  /** full-length stripes [v0, v1, colour] */
  stripes: [number, number, string][];
  /** window rows: a continuous band of glazing, or separate panes about `pane` long */
  rows: { v0: number; v1: number; pane?: number }[];
  /** door positions (left edge, in u) on middle sections and on cab sections, door width */
  doors: number[];
  cabDoors: number[];
  doorW: number;
  doorTop: number;
  doorColor: string;
  /** where the cab section's side windows stop (the windscreen starts) */
  cabEnd: number;
  /** cab front painted in another colour: lower part from u0 to the nose, up to v */
  nose?: { u0: number; v: number; color: string };
  roof: string;
}

const LIVERY: Record<ModelKey, Livery> = {
  tr: {
    body: STEEL,
    stripes: [
      [0.02, 0.05, '#9aa2ab'],
      [0.4, 0.44, TTC_RED],
    ],
    rows: [{ v0: 0.5, v1: 0.86 }],
    doors: [0.1, 0.36, 0.62, 0.86],
    cabDoors: [0.08, 0.32, 0.56],
    doorW: 0.06,
    doorTop: 0.88,
    doorColor: '#aeb5bd',
    cabEnd: 0.8,
    nose: { u0: 0.92, v: 0.45, color: TTC_RED },
    roof: '#cfd4d9',
  },
  t1: {
    body: STEEL,
    stripes: [[0.36, 0.4, TTC_RED]],
    rows: [{ v0: 0.52, v1: 0.84, pane: 0.075 }],
    doors: [0.16, 0.45, 0.74],
    cabDoors: [0.12, 0.4, 0.66],
    doorW: 0.065,
    doorTop: 0.88,
    doorColor: '#b2b9c1',
    cabEnd: 0.88,
    nose: { u0: 0.96, v: 0.42, color: TTC_RED },
    roof: '#c9ced3',
  },
  freedom: {
    body: WHITE,
    stripes: [
      [0, 0.1, '#5c636c'],
      [0.36, 0.41, TTC_RED],
    ],
    rows: [{ v0: 0.45, v1: 0.88 }],
    doors: [0.33],
    cabDoors: [0.18],
    doorW: 0.3,
    doorTop: 0.9,
    doorColor: '#d9dde3',
    cabEnd: 0.66,
    roof: '#d6dadf',
  },
  citadis: {
    body: WHITE,
    stripes: [
      [0, 0.1, '#4e555e'],
      [0.34, 0.38, TTC_RED],
    ],
    rows: [{ v0: 0.42, v1: 0.9 }],
    doors: [0.18, 0.66],
    cabDoors: [0.3],
    doorW: 0.14,
    doorTop: 0.92,
    doorColor: '#d9dde3',
    cabEnd: 0.82,
    roof: '#d2d6db',
  },
  outlook: {
    body: TTC_RED,
    stripes: [
      [0.42, 0.45, '#f4f4f2'],
      [0.88, 0.95, '#f4f4f2'],
    ],
    rows: [{ v0: 0.47, v1: 0.86 }],
    doors: [0.33],
    cabDoors: [0.2],
    doorW: 0.3,
    doorTop: 0.86,
    doorColor: '#1f262f',
    cabEnd: 0.68,
    roof: '#e9eaea',
  },
  bilevel: {
    body: WHITE,
    stripes: [
      [0, 0.13, GO_GREEN],
      [0.15, 0.18, GO_LIME],
    ],
    rows: [
      { v0: 0.24, v1: 0.42, pane: 0.085 },
      { v0: 0.58, v1: 0.78, pane: 0.085 },
    ],
    doors: [0.2, 0.74],
    cabDoors: [0.2, 0.62],
    doorW: 0.06,
    doorTop: 0.5,
    doorColor: '#c9ced3',
    cabEnd: 0.9,
    roof: '#c8ccd0',
  },
  dmu: {
    body: '#dfe3e6',
    stripes: [
      [0, 0.3, '#1b2a49'],
      [0.3, 0.35, '#0075d2'],
    ],
    rows: [{ v0: 0.45, v1: 0.84, pane: 0.12 }],
    doors: [0.12, 0.8],
    cabDoors: [0.2, 0.62],
    doorW: 0.06,
    doorTop: 0.88,
    doorColor: '#c3c9cf',
    cabEnd: 0.84,
    nose: { u0: 0.9, v: 0.35, color: '#1b2a49' },
    roof: '#c7ccd1',
  },
  venture: {
    body: '#b9c0c8',
    stripes: [
      [0.36, 0.42, '#ffcb06'],
      [0, 0.06, '#3a4048'],
    ],
    rows: [{ v0: 0.48, v1: 0.84 }],
    doors: [0.06, 0.88],
    cabDoors: [0.08, 0.7],
    doorW: 0.05,
    doorTop: 0.88,
    doorColor: '#a7afb8',
    cabEnd: 0.84,
    roof: '#aeb5bd',
  },
  apm: {
    body: WHITE,
    stripes: [[0.2, 0.28, '#00a19a']],
    rows: [{ v0: 0.38, v1: 0.9 }],
    doors: [0.3],
    cabDoors: [0.25],
    doorW: 0.4,
    doorTop: 0.92,
    doorColor: '#e2e5e8',
    cabEnd: 0.8,
    roof: '#dfe2e5',
  },
};

/**
 * Paints one side of a section. u runs along the section (0 = rear, 1 = front), v up the body (0 = floor).
 * `glow` receives only the windows, used as the emissive map so they light up at night.
 */
function paint(model: ModelKey, role: Role): Painted {
  const W = 512;
  const H = 128;
  const mk = () => {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    return c;
  };
  const cv = mk();
  const gl = mk();
  const g = cv.getContext('2d')!;
  const e = gl.getContext('2d')!;
  e.fillStyle = '#000';
  e.fillRect(0, 0, W, H);
  const X = (u: number) => u * W;
  const Y = (v: number) => (1 - v) * H;
  const rect = (ctx: CanvasRenderingContext2D, u0: number, v0: number, u1: number, v1: number, color: string) => {
    ctx.fillStyle = color;
    ctx.fillRect(X(u0), Y(v1), X(u1) - X(u0), Y(v0) - Y(v1));
  };
  const win = (u0: number, v0: number, u1: number, v1: number) => {
    rect(g, u0, v0, u1, v1, GLASS);
    rect(e, u0 + 0.004, v0 + 0.02, u1 - 0.004, v1 - 0.02, '#fff');
  };
  const L = LIVERY[model];
  const isCab = role === 'cabF' || role === 'cabR';

  // locomotives: GO's green and white MP40 and VIA's Siemens Charger
  if (isCab && role === 'cabF' && (model === 'bilevel' || model === 'venture')) {
    if (model === 'bilevel') {
      rect(g, 0, 0, 1, 1, GO_GREEN);
      rect(g, 0, 0.42, 1, 0.5, '#f4f4f2');
      rect(g, 0, 0.53, 1, 0.56, GO_LIME);
      rect(g, 0.06, 0.6, 0.66, 0.92, '#0f6b34'); // engine room hood
      for (let u = 0.1; u < 0.64; u += 0.06) rect(g, u, 0.64, u + 0.035, 0.88, '#0b5a2b'); // louvres
      win(0.76, 0.66, 0.88, 0.9); // cab side window
    } else {
      rect(g, 0, 0, 1, 1, '#b9c0c8');
      rect(g, 0, 0, 1, 0.08, '#3a4048');
      g.fillStyle = '#ffcb06';
      g.beginPath();
      g.moveTo(X(0.55), Y(0.08));
      g.lineTo(X(1), Y(0.08));
      g.lineTo(X(1), Y(0.62));
      g.bezierCurveTo(X(0.86), Y(0.5), X(0.72), Y(0.3), X(0.55), Y(0.08));
      g.fill();
      for (let u = 0.08; u < 0.5; u += 0.07) rect(g, u, 0.55, u + 0.04, 0.85, '#8f979f');
      win(0.8, 0.6, 0.9, 0.86);
    }
    rect(g, 0, 0.96, 1, 1, '#9aa1a8');
  } else {
    rect(g, 0, 0, 1, 1, L.body);
    for (const [v0, v1, c] of L.stripes) rect(g, 0, v0, 1, v1, c);
    const end = isCab ? L.cabEnd : 1;
    const doors = isCab ? L.cabDoors : L.doors;
    // windows between the doors
    for (const row of L.rows) {
      const spans: [number, number][] = [];
      let a = 0.015;
      for (const d of doors) {
        if (row.v0 < L.doorTop) {
          spans.push([a, d - 0.012]);
          a = d + L.doorW + 0.012;
        }
      }
      spans.push([a, end - 0.015]);
      for (const [s0, s1] of spans) {
        if (s1 - s0 < 0.02) continue;
        if (!row.pane) {
          win(s0, row.v0, s1, row.v1);
          g.fillStyle = '#3a4352';
          const n = Math.max(1, Math.round((s1 - s0) / 0.16));
          for (let i = 1; i < n; i++) g.fillRect(X(s0 + ((s1 - s0) * i) / n) - 1.5, Y(row.v1), 3, Y(row.v0) - Y(row.v1));
        } else {
          const n = Math.max(1, Math.round((s1 - s0) / row.pane));
          const step = (s1 - s0) / n;
          for (let i = 0; i < n; i++) win(s0 + i * step + 0.006, row.v0, s0 + (i + 1) * step - 0.006, row.v1);
        }
      }
    }
    // doors: a panel with two tall windows
    for (const d of doors) {
      rect(g, d, 0.03, d + L.doorW, L.doorTop, L.doorColor);
      g.strokeStyle = 'rgba(40,46,54,0.55)';
      g.lineWidth = 2;
      g.strokeRect(X(d), Y(L.doorTop), X(d + L.doorW) - X(d), Y(0.03) - Y(L.doorTop));
      const mid = d + L.doorW / 2;
      const top = Math.min(L.doorTop - 0.04, 0.86);
      const low = L.doorTop < 0.6 ? 0.24 : 0.5;
      win(d + 0.006, low, mid - 0.004, top);
      win(mid + 0.004, low, d + L.doorW - 0.006, top);
    }
    if (isCab) {
      win(L.cabEnd + 0.02, L.rows[L.rows.length - 1].v0, Math.min(0.97, L.cabEnd + 0.1), L.rows[L.rows.length - 1].v1); // cab side window
      if (L.nose) rect(g, L.nose.u0, 0.02, 1, L.nose.v, L.nose.color);
    }
    rect(g, 0, 0.96, 1, 1, L.roof);
  }
  const tex = (c: HTMLCanvasElement) => {
    const t = new CanvasTexture(c);
    t.colorSpace = SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  };
  return { map: tex(cv), glow: tex(gl) };
}

/** how dark the soft shadow under the trains is (0 = no shadow) */
const SHADOW_OPACITY = 0.26;
/** shadow size: width as a share of the car body, and how far it fades out at each end (metres) */
const SHADOW_WIDTH = 1.45;
const SHADOW_FADE = 3;

/**
 * A soft contact shadow for one section, as an alpha mask: it fades out smoothly to the sides and linearly
 * towards both ends. Neighbouring sections overlap by exactly the fade length, so their fades add up to one
 * even band along the train, and the band itself ends in a soft rounded tip instead of a square corner.
 */
function shadowTexture(fadeU: number): CanvasTexture {
  const W = 128;
  const H = 32;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(W, H);
  const core = 0.45; // fully dark across the middle 45 % of the width
  for (let y = 0; y < H; y++) {
    const d = Math.abs((y + 0.5) / H - 0.5) * 2;
    const t = Math.min(1, Math.max(0, (1 - d) / (1 - core)));
    const across = t * t * (3 - 2 * t);
    for (let x = 0; x < W; x++) {
      const u = (x + 0.5) / W;
      const along = Math.min(1, Math.min(u, 1 - u) / fadeU);
      img.data[(y * W + x) * 4 + 3] = Math.round(255 * along * across);
    }
  }
  ctx.putImageData(img, 0, 0);
  return new CanvasTexture(c);
}

/* ------------------------------------------------------------------ geometry */

/**
 * A car section as a loft: a rounded cross-section (curved roof edges, sides leaning in a little above the
 * windows) swept along the length. For a cab the cross-section follows the nose: the roof drops along the
 * windscreen curve and the corners round off in plan, so the front is curved in every direction.
 * UVs are u = along the section, v = height / body height, so the side paintings line up on every surface.
 * Vertex colours darken the windscreen on cabs.
 */
function loftGeometry(m: ModelSpec, cab: boolean): BufferGeometry {
  const L = m.secLen;
  const H = m.h;
  const W = m.w / 2;
  const n = m.nose;
  const r = m.roofR;
  const rc = m.cornerR;
  const winLow = m.winLow * H;
  const tumble = 0.05;
  const ARC = 6;
  const tipX = L / 2 + 0.05;

  // nose profile: quadratic curve from (tip, 0.42H) via (tip - 0.1, cH) to (tip - n, H)
  const cH = (n > 1 ? 0.88 : 0.97) * H;
  const nose: [number, number][] = [];
  for (let i = 0; i <= 40; i++) {
    const t = i / 40;
    const x = (1 - t) * (1 - t) * tipX + 2 * (1 - t) * t * (tipX - 0.1) + t * t * (tipX - n);
    const y = (1 - t) * (1 - t) * 0.42 * H + 2 * (1 - t) * t * cH + t * t * H;
    nose.push([x, y]);
  }
  const topAt = (x: number) => {
    if (!cab || x <= tipX - n) return H;
    for (let i = 1; i < nose.length; i++) {
      const [x0, y0] = nose[i - 1];
      const [x1, y1] = nose[i];
      if (x <= x0 && x >= x1) return y0 + ((y1 - y0) * (x0 - x)) / (x0 - x1 || 1);
    }
    return 0.42 * H;
  };
  const halfAt = (x: number) => {
    if (!cab || x <= tipX - rc) return W;
    const d = Math.min(rc, x - (tipX - rc));
    return W - rc + Math.sqrt(Math.max(0, rc * rc - d * d));
  };

  // slices along the length; dense through the nose, with a pair at the windscreen edge for a crisp colour change
  const xs: number[] = [-L / 2];
  if (cab) {
    const start = tipX - Math.max(n, rc) - 0.02;
    xs.push(start);
    const steps = 22;
    for (let i = 1; i <= steps; i++) xs.push(start + ((tipX - start) * i) / steps);
    xs.push(tipX - n - 0.004, tipX - n);
    xs.sort((p, q) => p - q);
  } else xs.push(L / 2);

  // one cross-section: (z, y) points from the bottom of the left side, over the roof, down to the bottom right
  const section = (x: number) => {
    const top = topAt(x);
    const hw = halfAt(x);
    const re = Math.min(r, hw * 0.8, Math.max(0.02, (top - 0.05) / 2));
    const side = (y: number) => hw * (1 - tumble * Math.min(1, Math.max(0, (y - 0.5 * H) / (0.5 * H))));
    const ys = [0, winLow - 0.004, winLow, top - re].map((y) => Math.min(y, top - re));
    const pts: [number, number][] = [];
    for (const y of ys) pts.push([-side(y), y]);
    const zc = side(top - re) - re;
    for (let k = 1; k <= ARC; k++) {
      const a = Math.PI - (k / ARC) * (Math.PI / 2);
      pts.push([-zc + re * Math.cos(a), top - re + re * Math.sin(a)]);
    }
    for (let k = 0; k < ARC; k++) {
      const a = Math.PI / 2 - (k / ARC) * (Math.PI / 2);
      pts.push([zc + re * Math.cos(a), top - re + re * Math.sin(a)]);
    }
    for (const y of [...ys].reverse()) pts.push([side(y), y]);
    return pts;
  };

  const pos: number[] = [];
  const uv: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const glass = new Color(GLASS);
  const push = (x: number, z: number, y: number) => {
    pos.push(x, y, z);
    uv.push(Math.min(1, Math.max(0, (x + L / 2) / L)), Math.min(1, y / H));
    const dark = cab && x >= tipX - n - 0.001 && y >= winLow - 0.001;
    if (dark) col.push(glass.r * 1.6, glass.g * 1.6, glass.b * 1.6);
    else col.push(1, 1, 1);
  };
  const rings = xs.map((x) => section(x));
  const P = rings[0].length;
  rings.forEach((ring, i) => ring.forEach(([z, y]) => push(xs[i], z, y)));
  for (let i = 0; i < rings.length - 1; i++) {
    for (let k = 0; k < P - 1; k++) {
      const a = i * P + k;
      const b = (i + 1) * P + k;
      idx.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }
  const body = new BufferGeometry();
  body.setAttribute('position', new Float32BufferAttribute(pos, 3));
  body.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  body.setAttribute('color', new Float32BufferAttribute(col, 3));
  body.setIndex(idx);
  body.computeVertexNormals();
  // make sure the surface faces outwards (the roof must point up)
  const nrm = body.getAttribute('normal');
  const topIdx = P >> 1;
  if (nrm.getY(topIdx) < 0) {
    for (let i = 0; i < idx.length; i += 3) [idx[i + 1], idx[i + 2]] = [idx[i + 2], idx[i + 1]];
    body.setIndex(idx);
    body.computeVertexNormals();
  }

  // flat end caps
  const cap = (ring: [number, number][], x: number, dir: 1 | -1) => {
    const g = new BufferGeometry();
    const cp: number[] = [];
    const cu: number[] = [];
    const cc: number[] = [];
    const cn: number[] = [];
    const ci: number[] = [];
    const add = (z: number, y: number) => {
      cp.push(x, y, z);
      cu.push(Math.min(1, Math.max(0, (x + L / 2) / L)), Math.min(1, y / H));
      cc.push(1, 1, 1);
      cn.push(dir, 0, 0);
    };
    add(0, ring.reduce((s2, p2) => s2 + p2[1], 0) / ring.length);
    ring.forEach(([z, y]) => add(z, y));
    for (let k = 1; k < ring.length; k++) ci.push(0, k, k + 1 > ring.length ? 1 : k + 1);
    ci.push(0, ring.length, 1);
    // winding from the ring's signed area: x part of Σ (p_k × p_k+1) with points (x, y, z)
    let area = 0;
    for (let k = 0; k < ring.length; k++) {
      const [z0, y0] = ring[k];
      const [z1, y1] = ring[(k + 1) % ring.length];
      area += y0 * z1 - z0 * y1;
    }
    if (Math.sign(area) !== dir) for (let i = 0; i < ci.length; i += 3) [ci[i + 1], ci[i + 2]] = [ci[i + 2], ci[i + 1]];
    g.setAttribute('position', new Float32BufferAttribute(cp, 3));
    g.setAttribute('uv', new Float32BufferAttribute(cu, 2));
    g.setAttribute('color', new Float32BufferAttribute(cc, 3));
    g.setAttribute('normal', new Float32BufferAttribute(cn, 3));
    g.setIndex(ci);
    return g;
  };
  return mergeGeometries([body, cap(rings[0], xs[0], -1), cap(rings[rings.length - 1], xs[xs.length - 1], 1)])!;
}

/** a lowered pantograph: base frame with the folded arms on top */
function pantoGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [];
  const base = new BoxGeometry(1.5, 0.14, 1.2);
  base.translate(0, 0.07, 0);
  parts.push(base);
  for (const z of [-0.45, 0.45]) {
    const arm = new BoxGeometry(2.0, 0.07, 0.07);
    arm.rotateZ(0.22);
    arm.translate(0.1, 0.35, z);
    parts.push(arm);
  }
  const head = new BoxGeometry(0.12, 0.08, 1.7);
  head.translate(1.05, 0.58, 0);
  parts.push(head);
  return mergeGeometries(parts)!;
}

export type PartName =
  | 'blob'
  | 'under'
  | 'cabBody'
  | 'cabBodyR'
  | 'midA'
  | 'midB'
  | 'roof'
  | 'equip'
  | 'panto'
  | 'ghostCab'
  | 'ghostCabR'
  | 'ghostMidA'
  | 'ghostMidB';
export const PARTS: PartName[] = ['blob', 'under', 'cabBody', 'cabBodyR', 'midA', 'midB', 'roof', 'equip', 'panto', 'ghostCab', 'ghostCabR', 'ghostMidA', 'ghostMidB'];
/** parts coloured per instance (roof: real colour blended with the line colour when zoomed out; ghosts: a hint of it) */
export const TINTED = new Set<PartName>(['roof', 'ghostCab', 'ghostCabR', 'ghostMidA', 'ghostMidB']);
const GHOSTS = new Set<PartName>(['ghostCab', 'ghostCabR', 'ghostMidA', 'ghostMidB']);

export interface Fleet {
  m: ModelSpec;
  parts: Record<PartName, InstancedMesh>;
  local: Record<string, Matrix4>;
}

export interface FleetMaterials {
  shell: MeshLambertMaterial;
  glass: MeshLambertMaterial;
  under: MeshLambertMaterial;
  roof: MeshLambertMaterial;
  equip: MeshLambertMaterial;
  panto: MeshLambertMaterial;
  /** textured sides, per model and role (lit windows at night use emissive) */
  sides: MeshLambertMaterial[];
  /** soft shadows, one per model (their fade depends on the section length) */
  shadows: MeshBasicMaterial[];
}

export function makeMaterials(): FleetMaterials {
  return {
    shell: new MeshLambertMaterial({ color: WHITE }),
    glass: new MeshLambertMaterial({ color: GLASS, emissive: new Color('#ffd9a0'), emissiveIntensity: 0 }),
    under: new MeshLambertMaterial({ color: '#2b3038' }),
    roof: new MeshLambertMaterial({ color: '#ffffff' }),
    equip: new MeshLambertMaterial({ color: '#b8bec6' }),
    panto: new MeshLambertMaterial({ color: '#3a3f47' }),
    sides: [],
    shadows: [],
  };
}

function sideMaterial(mats: FleetMaterials, p: Painted): MeshLambertMaterial {
  const mat = new MeshLambertMaterial({ map: p.map, emissive: new Color('#ffd9a0'), emissiveMap: p.glow, emissiveIntensity: 0 });
  mats.sides.push(mat);
  return mat;
}

/** a see-through copy of a painted body material for trains in tunnel (lit windows still glow at night) */
function ghostOf(mats: FleetMaterials, base: MeshLambertMaterial): MeshLambertMaterial {
  const g = base.clone();
  g.transparent = true;
  g.opacity = 0.5;
  g.depthWrite = false;
  mats.sides.push(g);
  return g;
}

export function makeFleet(key: ModelKey, mats: FleetMaterials): Fleet {
  const m = MODELS[key];
  const L = m.secLen;
  const box = (x: number, y: number, z: number) => new BoxGeometry(x, y, z);

  // rounded sections; front cabs and rear cabs (or cab cars) have their own paintings
  const cab = loftGeometry(m, true);
  const cabSide = sideMaterial(mats, paint(key, 'cabF'));
  cabSide.vertexColors = true; // dark windscreen
  const pushPull = key === 'bilevel' || key === 'venture';
  const cabSideR = pushPull ? sideMaterial(mats, paint(key, 'cabR')) : cabSide;
  cabSideR.vertexColors = true;
  const mid = loftGeometry(m, false);
  const midA = sideMaterial(mats, paint(key, 'midA'));
  const midB = sideMaterial(mats, paint(key, 'midB'));

  // soft shadow: one section plus the gap to the next, plus the fade that overlaps the neighbour's
  const shadowLen = L + m.art + SHADOW_FADE;
  const blob = new PlaneGeometry(shadowLen, m.w * SHADOW_WIDTH);
  blob.rotateX(-Math.PI / 2);
  const shadow = new MeshBasicMaterial({
    map: shadowTexture(SHADOW_FADE / shadowLen),
    color: '#000000',
    transparent: true,
    opacity: SHADOW_OPACITY,
    depthWrite: false,
    visible: SHADOW_OPACITY > 0,
  });
  mats.shadows.push(shadow);
  const geo: Record<PartName, BufferGeometry> = {
    blob,
    under: box(L * 0.8, m.bottom, m.w * 0.84),
    cabBody: cab,
    cabBodyR: cab,
    midA: mid,
    midB: mid,
    roof: box(L * 0.9, 0.1, m.w * 0.56),
    equip: box(Math.min(2.4, L * 0.4), 0.38, m.w * 0.55),
    panto: pantoGeometry(),
    // underground: the same rounded bodies, see-through
    ghostCab: cab,
    ghostCabR: cab,
    ghostMidA: mid,
    ghostMidB: mid,
  };
  const mat: Record<PartName, Material | Material[]> = {
    blob: shadow,
    under: mats.under,
    cabBody: cabSide,
    cabBodyR: cabSideR,
    midA,
    midB,
    roof: mats.roof,
    equip: mats.equip,
    panto: mats.panto,
    ghostCab: ghostOf(mats, cabSide),
    ghostCabR: pushPull ? ghostOf(mats, cabSideR) : ghostOf(mats, cabSide),
    ghostMidA: ghostOf(mats, midA),
    ghostMidB: ghostOf(mats, midB),
  };
  const white = new Color('#ffffff');
  const parts = {} as Record<PartName, InstancedMesh>;
  for (const name of PARTS) {
    const im = new InstancedMesh(geo[name], mat[name], m.cap);
    im.frustumCulled = false;
    im.count = 0;
    if (TINTED.has(name)) im.setColorAt(0, white); // create the colour buffer up front (no shader rebuild later)
    im.renderOrder = GHOSTS.has(name) ? 10 : name === 'blob' ? 1 : 2;
    parts[name] = im;
  }
  const T = (x: number, y: number, z: number, rotY = 0) => new Matrix4().makeRotationY(rotY).setPosition(x, y, z);
  const b = m.bottom;
  const roofY = b + m.h + 0.02;
  const cabRoof = (L - m.nose - 0.3) / (L * 0.9);
  const local = {
    cab: T(0, b, 0),
    cabFlip: T(0, b, 0, Math.PI),
    mid: T(0, b, 0),
    roofMid: T(0, roofY, 0),
    // cab roofs are shorter: the windscreen takes the front of the roof
    roofF: T(-m.nose / 2 - 0.1, roofY, 0).multiply(new Matrix4().makeScale(cabRoof, 1, 1)),
    roofR: T(m.nose / 2 + 0.1, roofY, 0).multiply(new Matrix4().makeScale(cabRoof, 1, 1)),
    equip: T(L * 0.12, roofY + 0.2, 0),
    panto: T(-L * 0.2, roofY + 0.06, 0),
    under: T(0, b / 2, 0),
    blob: T(0, 0.04, 0),
  };
  return { m, parts, local };
}
