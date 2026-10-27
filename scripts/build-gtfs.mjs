#!/usr/bin/env node
/**
 * Builds public/data/transit.json — every scheduled train in the Toronto area — from four GTFS feeds:
 *
 *   TTC         subway (Lines 1, 2, 4), light rail (Lines 5, 6) and streetcars
 *   GO Transit  the seven rail lines (GO buses are left out)
 *   UP Express  Union ↔ Pearson Airport
 *   VIA Rail    intercity trains, cut down to the part of each run inside the region
 *
 * and adds a timetable for the Terminal Link people mover at Pearson, which publishes no GTFS.
 * The result is one compact JSON file that the web app loads once and runs its own clock against.
 *
 *   node scripts/build-gtfs.mjs                   build from ./gtfs if that folder exists, else download the feeds
 *   node scripts/build-gtfs.mjs --download        always download fresh copies of the four feeds
 *   node scripts/build-gtfs.mjs --dir <folder>    use feeds already downloaded into <folder> (zips or unzipped folders)
 *   node scripts/build-gtfs.mjs --if-missing      skip when the output already exists
 *   node scripts/build-gtfs.mjs --out path.json   write somewhere else
 *
 * TTC_GTFS_URL, GO_GTFS_URL, UP_GTFS_URL and VIA_GTFS_URL override the download addresses.
 */
import { createReadStream } from 'node:fs';
import { access, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';

const FEEDS = [
  {
    key: 'ttc',
    name: 'TTC',
    match: /ttc|toronto/i,
    env: 'TTC_GTFS_URL',
    urls: [
      'https://opendata.toronto.ca/toronto.transit.commission/ttc-routes-and-schedules/OpenData_TTC_Schedules.zip',
      'http://opendata.toronto.ca/toronto.transit.commission/ttc-routes-and-schedules/OpenData_TTC_Schedules.zip',
    ],
    // City of Toronto open data catalogue: finds the current zip if the address above moves
    ckan: 'https://ckan0.cf.opendata.inter.prod-toronto.ca/api/3/action/package_show?id=ttc-routes-and-schedules',
    // the copy of the same feed that the Mobility Database (mobilitydatabase.org) downloads every day
    mirror: 'mdb-732',
  },
  { key: 'go', name: 'GO Transit', match: /^go(?![a-z])/i, env: 'GO_GTFS_URL', urls: ['https://assets.metrolinx.com/raw/upload/Documents/Metrolinx/Open%20Data/GO-GTFS.zip'] },
  { key: 'up', name: 'UP Express', match: /^up(?![a-z])/i, env: 'UP_GTFS_URL', urls: ['https://assets.metrolinx.com/raw/upload/Documents/Metrolinx/Open%20Data/UP-GTFS.zip'] },
  { key: 'via', name: 'VIA Rail', match: /via/i, env: 'VIA_GTFS_URL', urls: ['https://www.viarail.ca/sites/all/files/gtfs/viarail.zip'] },
];

/** VIA runs are cut to this box (Kitchener/Stratford – Niagara – Oshawa – Barrie), keeping one stop beyond it either side */
const REGION = { w: -81.1, e: -78.6, s: 42.95, n: 44.5 };
const inRegion = (lon, lat) => lon >= REGION.w && lon <= REGION.e && lat >= REGION.s && lat <= REGION.n;

/** UI groups, in display order */
const GROUPS = ['subway', 'lrt', 'streetcar', 'go', 'airport', 'via'];
const GO_ORDER = ['LW', 'MI', 'KI', 'BR', 'RH', 'ST', 'LE'];

/** fastest believable average between two stops (m/s), used to repair squeezed timetables */
const VMAX = { subway: 16, lrt: 16, streetcar: 14, go: 40, up: 40, via: 45, tl: 14 };
/** track simplification tolerance (m) */
const SIMPLIFY = { subway: 0.6, lrt: 0.6, streetcar: 0.8, go: 1.5, up: 1.2, via: 2, tl: 0.5 };

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const OUT = arg('--out') ?? 'public/data/transit.json';

main().catch((err) => {
  console.error(`\n✖ ${err.stack ?? err.message}`);
  process.exit(1);
});

async function main() {
  if (argv.includes('--if-missing')) {
    try {
      await access(OUT);
      console.log(`${OUT} already exists – skipping the download (run \`npm run data\` to refresh it).`);
      return;
    } catch {
      /* not there yet: build it */
    }
  }
  const t0 = Date.now();
  let dir = arg('--dir');
  if (!dir && !argv.includes('--download')) {
    try {
      if ((await stat('gtfs')).isDirectory()) {
        dir = 'gtfs';
        console.log('Using the feeds in gtfs/ (pass --download to fetch fresh copies instead)');
      }
    } catch {
      /* no local copies: download */
    }
  }
  let sources;
  try {
    sources = dir ? await localSources(dir) : await downloadAll();
  } catch (err) {
    if (dir) throw err;
    // keep the live timetable rather than fail the whole deploy
    const kept = await liveTimetable(err);
    await mkdir(dirname(OUT), { recursive: true });
    await writeFile(OUT, kept.json);
    console.warn(`⚠ ${OUT}: kept the live timetable from ${kept.generatedAt}. The next build will try the downloads again.`);
    return;
  }
  const data = await build(sources);
  const json = JSON.stringify(data);
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT + '.tmp', json);
  await rename(OUT + '.tmp', OUT);
  const groupOfPattern = data.patterns.map((p) => data.lines.find((l) => l.id === p.line).group);
  const byGroup = GROUPS.map((g) => `${g} ${data.trips.filter((t) => groupOfPattern[t[1]] === g).length}`);
  console.log(
    `✔ ${OUT}: ${(json.length / 1048576).toFixed(2)} MB · ${data.lines.length} lines · ${data.stations.length} stations · ` +
      `${data.patterns.length} patterns · ${data.profiles.length} timing profiles · ${data.trips.length} trips (${byGroup.join(', ')}) · ` +
      `${((Date.now() - t0) / 1000).toFixed(1)} s`,
  );
}

/* ------------------------------------------------------------------ feed sources */

/**
 * A feed source reads one GTFS table at a time, from an unzipped folder or from a zip.
 * { key, name, url, lastModified, has(file), lines(file) → async iterable of text lines }
 */
function folderSource(feed, path, info) {
  return {
    ...feed,
    url: info.url ?? path,
    lastModified: info.lastModified,
    async has(file) {
      try {
        return (await stat(join(path, file))).isFile();
      } catch {
        return false;
      }
    },
    lines(file) {
      return createInterface({ input: createReadStream(join(path, file)), crlfDelay: Infinity });
    },
  };
}

async function zipSource(feed, buf, info) {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(buf);
  const find = (name) => Object.values(zip.files).find((f) => !f.dir && f.name.toLowerCase().split('/').pop() === name.toLowerCase()) ?? null;
  return {
    ...feed,
    url: info.url,
    lastModified: info.lastModified,
    async has(file) {
      return !!find(file);
    },
    lines(file) {
      return createInterface({ input: find(file).nodeStream('nodebuffer'), crlfDelay: Infinity });
    },
  };
}

/** finds a folder holding routes.txt (the folder itself or one level down) */
async function feedFolder(path) {
  try {
    if ((await stat(join(path, 'routes.txt'))).isFile()) return path;
  } catch {
    /* look one level down */
  }
  for (const e of await readdir(path, { withFileTypes: true })) {
    if (e.isDirectory()) {
      try {
        if ((await stat(join(path, e.name, 'routes.txt'))).isFile()) return join(path, e.name);
      } catch {
        /* not this one */
      }
    }
  }
  return null;
}

async function localSources(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const out = [];
  for (const feed of FEEDS) {
    const hits = entries.filter((e) => feed.match.test(e.name) && (e.isDirectory() || /\.zip$/i.test(e.name)));
    // an unzipped folder wins over a zip of the same feed
    hits.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()));
    let src = null;
    for (const e of hits) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        const f = await feedFolder(p);
        if (f) src = folderSource(feed, f, { url: f });
      } else src = await zipSource(feed, await readFile(p), { url: p });
      if (src) break;
    }
    if (!src) throw new Error(`No ${feed.name} feed found in ${dir} (expected a folder or zip whose name matches ${feed.match})`);
    console.log(`${feed.name}: ${src.url}`);
    out.push(src);
  }
  return out;
}

const USER_AGENT = 'toronto-transit-live (+https://toronto-transit-live.vercel.app/)';

async function fetchZip(url) {
  const res = await fetch(url, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1024 || buf[0] !== 0x50 || buf[1] !== 0x4b) throw new Error('the response is not a zip file');
  return { buf, url, lastModified: res.headers.get('last-modified') ?? undefined };
}

async function ckanZip(api) {
  const res = await fetch(api, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`catalogue HTTP ${res.status}`);
  const pkg = (await res.json()).result;
  const zips = (pkg?.resources ?? []).filter((r) => /zip/i.test(r.format ?? '') || /\.zip($|\?)/i.test(r.url ?? ''));
  zips.sort((a, b) => String(b.last_modified ?? '').localeCompare(String(a.last_modified ?? '')));
  if (!zips.length) throw new Error('the catalogue lists no zip file');
  return fetchZip(zips[0].url);
}

/** the Mobility Database's latest copy of a feed, found through its public catalogue (urls.latest) */
async function mobilityDatabaseZip(id) {
  const res = await fetch('https://files.mobilitydatabase.org/feeds_v2.csv', { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`Mobility Database catalogue HTTP ${res.status}`);
  const rows = (await res.text()).split(/\r?\n/);
  const head = splitCsv(rows[0]);
  const idCol = head.indexOf('id');
  const latestCol = head.indexOf('urls.latest');
  if (idCol < 0 || latestCol < 0) throw new Error('the Mobility Database catalogue has no id or urls.latest column');
  for (const row of rows) {
    if (!row.includes(id)) continue;
    const cells = splitCsv(row);
    if (cells[idCol] === id && cells[latestCol]) return fetchZip(cells[latestCol]);
  }
  throw new Error(`the Mobility Database catalogue has no copy of ${id}`);
}

/** the timetable the live site is serving now, for when a feed can't be downloaded */
async function liveTimetable(err) {
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  const url = process.env.FALLBACK_DATA_URL || (host ? `https://${host}/data/transit.json` : '');
  if (!url || argv.includes('--no-fallback')) throw err;
  console.warn(`\n⚠ ${err.message}\n  Keeping the timetable that is live now instead: ${url}`);
  let res;
  try {
    res = await fetch(url, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(60_000) });
  } catch (e) {
    throw new Error(`${err.message} The live timetable could not be fetched either (${e.message}).`);
  }
  if (!res.ok) throw new Error(`${err.message} The live timetable could not be fetched either (HTTP ${res.status}).`);
  const json = await res.text();
  let data;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error(`${err.message} The live timetable at ${url} is not JSON.`);
  }
  if (data?.version !== 2 || !Array.isArray(data.trips) || !data.trips.length) throw new Error(`${err.message} The live timetable at ${url} is empty or in an old format.`);
  // say so when the kept timetable is about to run out
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  for (const f of data.feeds ?? []) if (f.end && f.end < today) console.warn(`  ${f.name}: the kept timetable ended on ${f.end}, so its trains won't show until a download works again.`);
  return { json, generatedAt: data.generatedAt ?? 'an earlier build' };
}

async function downloadAll() {
  const out = [];
  for (const feed of FEEDS) {
    const urls = process.env[feed.env] ? [process.env[feed.env]] : feed.urls;
    let got = null;
    let last;
    for (const url of urls) {
      for (let attempt = 1; attempt <= 3 && !got; attempt++) {
        try {
          console.log(`Downloading ${feed.name}: ${url}${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
          got = await fetchZip(url);
        } catch (err) {
          last = err;
          console.warn(`  failed: ${err.message}`);
          await new Promise((r) => setTimeout(r, attempt * 3000));
        }
      }
      if (got) break;
    }
    if (!got && feed.ckan && !process.env[feed.env]) {
      try {
        console.log(`  asking the open data catalogue for ${feed.name}`);
        got = await ckanZip(feed.ckan);
      } catch (err) {
        last = err;
        console.warn(`  failed: ${err.message}`);
      }
    }
    if (!got && feed.mirror && !process.env[feed.env]) {
      try {
        console.log(`  trying the Mobility Database's copy of ${feed.name} (${feed.mirror})`);
        got = await mobilityDatabaseZip(feed.mirror);
      } catch (err) {
        last = err;
        console.warn(`  failed: ${err.message}`);
      }
    }
    if (!got) throw new Error(`Could not download the ${feed.name} feed (${last?.message}). Set ${feed.env} or use --dir.`);
    console.log(`  ${(got.buf.length / 1048576).toFixed(1)} MB`);
    out.push(await zipSource(feed, got.buf, got));
  }
  return out;
}

/* ------------------------------------------------------------------ CSV */

/** RFC 4180 line split (quoted fields with commas and doubled quotes; GTFS feeds do not put line breaks in fields) */
function splitCsv(line) {
  if (!line.includes('"')) return line.split(',');
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else q = false;
      } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** Streams a GTFS table row by row: fn(cells, col) where col(name) gives the column index (-1 if absent). */
async function eachRow(src, name, fn, { required = true } = {}) {
  if (!(await src.has(name))) {
    if (required) throw new Error(`${name} is missing from the ${src.name} feed`);
    return false;
  }
  let index = null;
  const col = (n) => index.get(n) ?? -1;
  for await (const raw of src.lines(name)) {
    if (index === null) {
      index = new Map(splitCsv(raw.replace(/^﻿/, '')).map((h, i) => [h.trim(), i]));
      continue;
    }
    if (!raw.trim()) continue;
    fn(splitCsv(raw), col);
  }
  return true;
}
const cell = (c, i) => (i >= 0 && c[i] != null ? c[i].trim() : '');

function parseTime(s) {
  if (!s) return NaN;
  const m = /^(\d{1,3}):(\d{2})(?::(\d{2}))?$/.exec(s.trim());
  return m ? +m[1] * 3600 + +m[2] * 60 + +(m[3] ?? 0) : NaN;
}
const fmtTime = (t) => [Math.floor(t / 3600), Math.floor((t % 3600) / 60), t % 60].map((v) => String(v).padStart(2, '0')).join(':');

/** YYYYMMDD + n days */
function addDays(key, n) {
  const d = new Date(Date.UTC(+key.slice(0, 4), +key.slice(4, 6) - 1, +key.slice(6, 8) + n));
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}

/* ------------------------------------------------------------------ geometry (metres on a local plane) */

const LAT0 = 43.7;
const LON0 = -79.4;
const KX = 111320 * Math.cos((LAT0 * Math.PI) / 180);
const KY = 110574;
const xy = (lon, lat) => [(lon - LON0) * KX, (lat - LAT0) * KY];
const dist2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function segProject(a, b, p) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const x = a[0] + dx * t - p[0];
  const y = a[1] + dy * t - p[1];
  return { d: Math.hypot(x, y), t };
}

/** Douglas–Peucker on [lon,lat] points, tolerance in metres */
function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const P = pts.map(([lon, lat]) => xy(lon, lat));
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let best = -1;
    let bi = -1;
    for (let i = a + 1; i < b; i++) {
      const d = segProject(P[a], P[b], P[i]).d;
      if (d > best) {
        best = d;
        bi = i;
      }
    }
    if (best > tol) {
      keep[bi] = 1;
      stack.push([a, bi], [bi, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Removes back-and-forth spikes (a vertex where the line turns by more than 150° is a point out of sequence). */
function despike(pts) {
  const P = pts.slice();
  let i = 1;
  while (i < P.length - 1) {
    const a = xy(P[i - 1][0], P[i - 1][1]);
    const b = xy(P[i][0], P[i][1]);
    const c = xy(P[i + 1][0], P[i + 1][1]);
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const vx = c[0] - b[0];
    const vy = c[1] - b[1];
    const lu = Math.hypot(ux, uy);
    const lv = Math.hypot(vx, vy);
    if (lu < 1e-6 || lv < 1e-6 || (ux * vx + uy * vy) / (lu * lv) < -0.866) {
      P.splice(i, 1);
      i = Math.max(1, i - 1);
    } else i++;
  }
  return P;
}

/** Positions of stops along a shape, in order: vertex index + fraction, never going backwards. */
function projectStops(shape, stops) {
  const out = [];
  let from = 0;
  for (const p of stops) {
    let best = Infinity;
    let pos = from;
    for (let i = Math.floor(from); i < shape.length - 1; i++) {
      const r = segProject(shape[i], shape[i + 1], p);
      const at = i + r.t;
      if (at + 1e-9 < from) continue;
      if (r.d < best - 1e-6) {
        best = r.d;
        pos = at;
      } else if (best < 40 && r.d > best + 1500) break; // found it and moved well past
    }
    out.push(pos);
    from = pos;
  }
  return out;
}

/** mean distance (m) between each stop and the point it was placed at on the shape */
function fitError(shape, at, stops) {
  let sum = 0;
  stops.forEach((p, k) => {
    const i = Math.min(Math.floor(at[k]), shape.length - 2);
    const t = at[k] - i;
    const x = shape[i][0] + (shape[i + 1][0] - shape[i][0]) * t;
    const y = shape[i][1] + (shape[i + 1][1] - shape[i][1]) * t;
    sum += Math.hypot(x - p[0], y - p[1]);
  });
  return sum / stops.length;
}

function cumulative(shape) {
  const cum = [0];
  for (let i = 1; i < shape.length; i++) cum.push(cum[i - 1] + Math.hypot(shape[i][0] - shape[i - 1][0], shape[i][1] - shape[i - 1][1]));
  return cum;
}
const distAt = (cum, at) => {
  const i = Math.min(Math.floor(at), cum.length - 2);
  return cum[i] + (cum[i + 1] - cum[i]) * (at - i);
};

/** nearest position (vertex index + fraction) on a polyline of local points */
function nearestPos(P, p) {
  let best = Infinity;
  let pos = 0;
  for (let i = 0; i < P.length - 1; i++) {
    const r = segProject(P[i], P[i + 1], p);
    if (r.d < best) {
      best = r.d;
      pos = i + r.t;
    }
  }
  return pos;
}
const lerpPt = (pts, at) => {
  const i = Math.min(Math.floor(at), pts.length - 2);
  const t = at - i;
  return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t];
};

/** the part of a [lon,lat] polyline between the points nearest to a and b, oriented from a to b */
function sliceShape(pts, a, b) {
  const P = pts.map(([lon, lat]) => xy(lon, lat));
  let pa = nearestPos(P, xy(a[0], a[1]));
  let pb = nearestPos(P, xy(b[0], b[1]));
  const reverse = pa > pb;
  if (reverse) [pa, pb] = [pb, pa];
  const out = [lerpPt(pts, pa)];
  for (let i = Math.floor(pa) + 1; i <= Math.floor(pb) && i < pts.length; i++) if (i > pa) out.push(pts[i]);
  out.push(lerpPt(pts, pb));
  return reverse ? out.reverse() : out;
}

/* ------------------------------------------------------------------ names */

/** "Finch Station - Southbound Platform" → "Finch", "Keelesdale Station Eastbound Platform" → "Keelesdale" */
function cleanName(name) {
  const n = name
    .replace(/\s*\((?:NB|SB|EB|WB|north|south|east|west|platform)[^)]*\)\s*$/i, '')
    .replace(/\s+(?:NB|SB|EB|WB|northbound|southbound|eastbound|westbound)\b.*$/i, '')
    .replace(/\s+(?:LRT\s+)?(?:station|stop)\b.*$/i, '')
    .replace(/\s+platform\s*\w*$/i, '')
    .replace(/[\s\-–]+$/, '')
    .trim();
  return n || name.trim();
}
const norm = (n) =>
  n
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** a stop's own name with platform, side-of-street and operator decorations removed */
function baseName(feed, raw, streetcarStop) {
  let n = raw.trim();
  if (feed === 'up') n = n.replace(/^UP Express\s+/i, '');
  if (streetcarStop) {
    n = n
      .replace(/\s+-\s+[^-]*\bstation\b.*$/i, '') // "King St West at Yonge St East Side - King Station"
      .replace(/\s+(?:far|near|north|south|east|west)\s+side\b/gi, '');
  }
  n = n.replace(/\s+GO(?:\/UP)?$/i, '').replace(/\s+GO\/UP\b/i, '');
  return cleanName(n);
}

/** per-feed station aliases (normalized base name → station key) */
const ALIAS = {
  ttc: { bloor: 'bloor yonge', yonge: 'bloor yonge' }, // the two halves of Bloor-Yonge interchange
  via: { toronto: 'union' }, // VIA calls Union Station "Toronto"
  up: { 'pearson airport': 'terminal 1' }, // UP's airport stop is in Terminal 1, beside the Terminal Link station
};
/** display names for station keys */
const DISPLAY = { union: 'Union Station', 'bloor yonge': 'Bloor-Yonge', 'terminal 1': 'Pearson Terminal 1', 'terminal 3': 'Pearson Terminal 3' };
const FEED_RANK = { ttc: 0, go: 1, up: 2, tl: 3, via: 4 };

/** route headsigns → destination: "Line 1 (Yonge-University) towards Finch Station" → "Finch" */
function rawHeadsign(feed, h) {
  if (!h) return '';
  if (feed === 'ttc') {
    const m = /\btowards\s+(.+)$/i.exec(h);
    return m ? m[1] : '';
  }
  if (feed === 'go') return h.replace(/^[A-Z]{2}\s*-\s*/, '');
  if (feed === 'up') return h.replace(/^UP Express\s+/i, '');
  if (feed === 'via' && /^toronto$/i.test(h)) return 'Union Station';
  return h;
}
function tidyHeadsign(raw, lastStation) {
  if (!raw) return lastStation;
  if (/not\s+in\s+service/i.test(raw)) return 'Not in service';
  const h = cleanName(raw.replace(/\s+GO$/i, ''));
  const a = norm(h);
  const b = norm(lastStation);
  if (a && b && (a === b || b.startsWith(a + ' ') || a.startsWith(b + ' '))) return lastStation;
  return h;
}

/* ------------------------------------------------------------------ timing */

/**
 * Cleans one trip's stop times: fills gaps, smooths minute-rounded times by distance
 * (rounded feeds otherwise make trains lurch between 1- and 2-minute hops) and gives
 * every intermediate stop a short dwell. The trip still starts and ends on time.
 */
function tidyTimes(A, D, dist, vmax) {
  const n = A.length;
  for (let k = 0; k < n; k++) {
    if (isNaN(A[k])) A[k] = D[k];
    if (isNaN(D[k])) D[k] = A[k];
  }
  // interpolate missing (non-timepoint) stops by distance
  for (let k = 0; k < n; k++) {
    if (!isNaN(A[k])) continue;
    let a = k - 1;
    while (a >= 0 && isNaN(D[a])) a--;
    let b = k + 1;
    while (b < n && isNaN(A[b])) b++;
    if (a < 0 || b >= n) return null;
    const f = (dist[k] - dist[a]) / Math.max(1, dist[b] - dist[a]);
    A[k] = D[k] = Math.round(D[a] + (A[b] - D[a]) * f);
  }
  const wholeMinutes = A.every((t) => t % 60 === 0) && D.every((t) => t % 60 === 0);
  const arr = A.slice();
  const dep = D.slice();
  if (wholeMinutes && n >= 3) {
    const dwell = A.map((a, k) => (k === 0 || k === n - 1 ? 0 : D[k] - a >= 60 ? D[k] - a : 25));
    const total = A[n - 1] - D[0];
    const run = total - dwell.reduce((s, v) => s + v, 0);
    if (run > 30 * (n - 1)) {
      const w = [];
      for (let k = 0; k < n - 1; k++) w.push(dist[k + 1] - dist[k] + 300); // + time lost braking and accelerating
      const wsum = w.reduce((s, v) => s + v, 0);
      let t = D[0];
      for (let k = 1; k < n; k++) {
        t += (run * w[k - 1]) / wsum;
        arr[k] = Math.max(A[k] - 45, Math.min(A[k] + 45, t));
        dep[k] = k === n - 1 ? arr[k] : arr[k] + dwell[k];
        t = arr[k] + dwell[k];
      }
      arr[n - 1] = dep[n - 1] = A[n - 1];
    }
  } else {
    for (let k = 1; k < n - 1; k++) {
      if (D[k] - A[k] >= 10) continue;
      const half = Math.min(12, 0.2 * (A[k] - D[k - 1]), 0.2 * (A[k + 1] - D[k]));
      if (half > 0) {
        arr[k] = A[k] - half;
        dep[k] = D[k] + half;
      }
    }
  }
  // never run backwards, and no faster than a believable average between stops: a link that
  // rounded times squeeze too short borrows the time from slower links after it
  let debt = 0;
  for (let k = 1; k < n; k++) {
    const dwell = Math.max(0, dep[k] - arr[k]);
    const planned = arr[k] - dep[k - 1];
    const need = Math.max(20, (dist[k] - dist[k - 1]) / vmax + 8);
    const run = Math.max(need, planned - debt);
    debt += run - planned;
    arr[k] = dep[k - 1] + run;
    dep[k] = arr[k] + dwell;
  }
  return { arr: arr.map(Math.round), dep: dep.map(Math.round) };
}

/* ------------------------------------------------------------------ lines */

const hex = (c, fallback) => (/^[0-9a-f]{6}$/i.test(c ?? '') ? `#${c.toUpperCase()}` : fallback);

/** which line (if any) a route belongs to, per feed */
function lineFor(feed, r) {
  const color = hex(r.color, '#888888');
  const textColor = hex(r.text, '#FFFFFF');
  if (feed === 'ttc') {
    const short = r.short || r.id;
    const tidy = (s) => s.replace(/\s*\(\s*(.*?)\s*\)\s*$/, ' $1').replace(/\s*-\s*/g, '–');
    if (r.type === 1) return { id: `l${short}`, name: tidy(r.long || `Line ${short}`), short, group: 'subway', mode: 'subway', color, textColor };
    if (r.type === 0 && (/^line\s*\d/i.test(r.long) || Number(short) < 100))
      return { id: `l${short}`, name: tidy(r.long || `Line ${short}`), short, group: 'lrt', mode: 'lrt', color, textColor };
    if (r.type === 0) return { id: `s${short}`, name: `${short} ${r.long}`.trim(), short, group: 'streetcar', mode: 'streetcar', color, textColor };
    return null;
  }
  if (r.type !== 2) return null; // GO and VIA buses, VIA's Air Connect shuttle
  if (feed === 'go') return { id: `go-${(r.short || r.id).toLowerCase()}`, name: r.long || r.short, short: r.short || r.id, group: 'go', mode: 'go', color, textColor };
  if (feed === 'up') return { id: 'up', name: 'UP Express', short: 'UP', group: 'airport', mode: 'up', color, textColor };
  if (feed === 'via') return { id: 'via', name: 'VIA Rail', short: 'VIA', group: 'via', mode: 'via', color: hex(r.color, '#FFCB06'), textColor: hex(r.text, '#000000') };
  return null;
}

function lineOrder(l) {
  const g = GROUPS.indexOf(l.group) * 10000;
  if (l.group === 'go') return g + (GO_ORDER.indexOf(l.short) + 1 || 99);
  if (l.group === 'airport') return g + (l.id === 'up' ? 0 : 1);
  const n = Number(l.short);
  if (l.group === 'streetcar') return g + (Number.isFinite(n) ? (n >= 500 ? n - 500 : n + 500) : 999); // daytime 5xx before night 3xx
  return g + (Number.isFinite(n) ? n : 999);
}

/* ------------------------------------------------------------------ reading one feed */

/**
 * Reads the routes, trips, stop times, stops, track shapes and calendars of one feed, keeping only the
 * routes that are trains. Every id is prefixed with the feed key so the four feeds can be merged.
 */
async function loadFeed(src) {
  const K = src.key;
  const P = (id) => `${K}:${id}`;
  let timezone = 'America/Toronto';
  await eachRow(src, 'agency.txt', (c, col) => {
    const tz = cell(c, col('agency_timezone'));
    if (tz) timezone = tz;
  }, { required: false });
  const info = {};
  await eachRow(src, 'feed_info.txt', (c, col) => {
    info.version = cell(c, col('feed_version')) || undefined;
    info.start = cell(c, col('feed_start_date')) || undefined;
    info.end = cell(c, col('feed_end_date')) || undefined;
  }, { required: false });

  const routeLine = new Map();
  const lines = new Map();
  await eachRow(src, 'routes.txt', (c, col) => {
    const r = {
      id: cell(c, col('route_id')),
      type: Number(cell(c, col('route_type'))),
      short: cell(c, col('route_short_name')),
      long: cell(c, col('route_long_name')),
      color: cell(c, col('route_color')),
      text: cell(c, col('route_text_color')),
    };
    const l = lineFor(K, r);
    if (!l) return;
    routeLine.set(r.id, l.id);
    if (!lines.has(l.id)) lines.set(l.id, { ...l, routeIds: [] });
    lines.get(l.id).routeIds.push(r.id);
  });

  const trips = new Map();
  let buses = 0;
  await eachRow(src, 'trips.txt', (c, col) => {
    const line = routeLine.get(cell(c, col('route_id')));
    if (!line) return;
    const headsign = cell(c, col('trip_headsign'));
    // TTC lists its streetcar-replacement buses under the streetcar routes
    if (K === 'ttc' && /\bbus\b/i.test(headsign)) {
      buses++;
      return;
    }
    const id = cell(c, col('trip_id'));
    const short = cell(c, col('trip_short_name'));
    const block = cell(c, col('block_id'));
    trips.set(id, {
      id,
      // what the train card shows as the run: GO/UP train numbers, VIA train numbers (TTC trip ids mean nothing to riders)
      label: K === 'go' || K === 'up' ? id.replace(/^\d{8}-/, '') : K === 'via' ? (short ? `VIA ${short}` : '') : '',
      feed: K,
      line,
      service: P(cell(c, col('service_id'))),
      dir: Number(cell(c, col('direction_id')) || 0),
      shape: cell(c, col('shape_id')) ? P(cell(c, col('shape_id'))) : '',
      headsign: rawHeadsign(K, headsign),
      // VIA has no blocks: one train per train number
      block: block ? P(block) : K === 'via' ? P(short ? `VIA ${short}` : id) : '',
      stops: [],
    });
  });
  if (buses) console.log(`  ${src.name}: ${buses} replacement-bus trips left out`);

  await eachRow(src, 'stop_times.txt', (c, col) => {
    const t = trips.get(cell(c, col('trip_id')));
    if (!t) return;
    t.stops.push({
      seq: Number(cell(c, col('stop_sequence'))),
      stop: P(cell(c, col('stop_id'))),
      arr: parseTime(cell(c, col('arrival_time'))),
      dep: parseTime(cell(c, col('departure_time'))),
      // pickup 1 + drop-off 1 = no passengers here (yard tracks used as timing points)
      noPax: cell(c, col('pickup_type')) === '1' && cell(c, col('drop_off_type')) === '1',
    });
  });

  // frequency-based trips are expanded into individual runs
  const freq = [];
  await eachRow(src, 'frequencies.txt', (c, col) => {
    const id = cell(c, col('trip_id'));
    if (trips.has(id)) freq.push({ id, from: parseTime(cell(c, col('start_time'))), to: parseTime(cell(c, col('end_time'))), every: Number(cell(c, col('headway_secs'))) });
  }, { required: false });
  for (const f of freq) {
    const tpl = trips.get(f.id);
    if (!tpl || !(f.every > 0)) continue;
    trips.delete(f.id);
    tpl.stops.sort((a, b) => a.seq - b.seq);
    const base = tpl.stops[0].dep;
    for (let t = f.from; t < f.to; t += f.every) {
      const id = `${f.id}@${fmtTime(t)}`;
      trips.set(id, { ...tpl, id, label: id, stops: tpl.stops.map((s) => ({ ...s, arr: s.arr - base + t, dep: s.dep - base + t })) });
    }
  }

  const stops = new Map();
  await eachRow(src, 'stops.txt', (c, col) => {
    const id = P(cell(c, col('stop_id')));
    let name = cell(c, col('stop_name'));
    if (cell(c, col('stop_timezone')) === 'America/New_York' && !/\b(NY|N\.Y\.)\b/.test(name)) name += ' (NY)';
    stops.set(id, { id, feed: K, name, lat: Number(cell(c, col('stop_lat'))), lon: Number(cell(c, col('stop_lon'))) });
  });

  for (const [id, t] of trips) {
    t.stops.sort((a, b) => a.seq - b.seq);
    t.stops = t.stops.filter((s) => stops.has(s.stop));
    const pax = t.stops.filter((s) => !s.noPax);
    if (pax.length >= 2) t.stops = pax;
    if (t.stops.length < 2) trips.delete(id);
  }

  const services = new Map();
  const svc = (id) => {
    if (!services.has(id)) services.set(id, { id, days: '0000000', start: '99999999', end: '00000000', add: [], remove: [] });
    return services.get(id);
  };
  const used = new Set([...trips.values()].map((t) => t.service));
  await eachRow(src, 'calendar.txt', (c, col) => {
    const id = P(cell(c, col('service_id')));
    if (!used.has(id)) return;
    const s = svc(id);
    s.days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map((d) => (cell(c, col(d)) === '1' ? '1' : '0')).join('');
    s.start = cell(c, col('start_date'));
    s.end = cell(c, col('end_date'));
  }, { required: false });
  await eachRow(src, 'calendar_dates.txt', (c, col) => {
    const id = P(cell(c, col('service_id')));
    if (!used.has(id)) return;
    const s = svc(id);
    (cell(c, col('exception_type')) === '2' ? s.remove : s.add).push(cell(c, col('date')));
  }, { required: false });
  for (const id of used) svc(id);

  return { src, timezone, info, lines, trips: [...trips.values()], stops, services, shapes: new Map() };
}

/** reads the track shapes the kept trips use */
async function loadShapes(feed) {
  const want = new Set(feed.trips.map((t) => t.shape).filter(Boolean));
  const raw = new Map();
  await eachRow(feed.src, 'shapes.txt', (c, col) => {
    const id = `${feed.src.key}:${cell(c, col('shape_id'))}`;
    if (!want.has(id)) return;
    let list = raw.get(id);
    if (!list) raw.set(id, (list = []));
    list.push([Number(cell(c, col('shape_pt_sequence'))), Number(cell(c, col('shape_pt_lon'))), Number(cell(c, col('shape_pt_lat')))]);
  }, { required: false });
  for (const [id, list] of raw) feed.shapes.set(id, list.sort((a, b) => a[0] - b[0]).map((p) => [p[1], p[2]]));
}

/* ------------------------------------------------------------------ VIA: only the part in the region */

/**
 * where a track leaves REGION, walking from position `from` (inside) towards position `to` (outside);
 * positions are vertex index + fraction. Returns the crossing point and its position, or null.
 */
function regionExit(pts, from, to) {
  const step = to > from ? 1 : -1;
  const marks = [];
  if (step > 0) for (let v = Math.floor(from) + 1; v < to; v++) marks.push(v);
  else for (let v = Math.ceil(from) - 1; v > to; v--) marks.push(v);
  marks.push(to);
  let prev = from;
  for (const m of marks) {
    const p = lerpPt(pts, m);
    if (!inRegion(p[0], p[1])) {
      let lo = prev;
      let hi = m;
      for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        const q = lerpPt(pts, mid);
        if (inRegion(q[0], q[1])) lo = mid;
        else hi = mid;
      }
      return { pt: lerpPt(pts, lo), pos: lo };
    }
    prev = m;
  }
  return null;
}

/**
 * Keeps the stretch of each VIA run inside REGION. Where the train carries on beyond it, the trip gets an
 * extra end point on the region's edge (timed by distance between the stops either side), so a train to
 * Montréal is seen running off the map rather than vanishing at Oshawa. Runs that take several days are
 * moved to the service day of their first kept point, with their calendar shifted to match.
 */
function clipVia(feed) {
  const kept = [];
  const shifted = new Map();
  for (const t of feed.trips) {
    const C = t.stops.map((s) => {
      const p = feed.stops.get(s.stop);
      return [p.lon, p.lat];
    });
    const inside = C.map(([lon, lat]) => inRegion(lon, lat));
    // the longest run of stops inside the box
    let best = [-1, -1];
    for (let i = 0; i < inside.length; i++) {
      if (!inside[i]) continue;
      let j = i;
      while (j + 1 < inside.length && inside[j + 1]) j++;
      if (best[0] < 0 || j - i > best[1] - best[0]) best = [i, j];
      i = j;
    }
    const [i, j] = best;
    if (i < 0) continue;
    const track = t.shape && feed.shapes.get(t.shape)?.length > 1 ? feed.shapes.get(t.shape) : C;
    const P = track.map(([lon, lat]) => xy(lon, lat));
    const cum = cumulative(P);
    const pos = projectStops(P, C.map(([lon, lat]) => xy(lon, lat)));
    const time = (s) => (isNaN(s.dep) ? s.arr : s.dep);
    const stops = t.stops.slice(i, j + 1).map((s) => ({ ...s }));
    const edge = (a, b, inner) => {
      // a = stop index inside, b = neighbouring stop outside
      const e = regionExit(track, pos[a], pos[b]);
      if (!e) return null;
      const da = distAt(cum, pos[a]);
      const db = distAt(cum, pos[b]);
      const f = Math.abs(db - da) > 1 ? Math.abs(distAt(cum, e.pos) - da) / Math.abs(db - da) : 0.5;
      const ta = a < b ? time(t.stops[a]) : isNaN(t.stops[a].arr) ? t.stops[a].dep : t.stops[a].arr;
      const tb = a < b ? (isNaN(t.stops[b].arr) ? t.stops[b].dep : t.stops[b].arr) : time(t.stops[b]);
      const te = Math.round(ta + (tb - ta) * f);
      return { seq: inner.seq + (a < b ? 0.5 : -0.5), stop: null, edge: e.pt, arr: te, dep: te };
    };
    if (i > 0) {
      const e = edge(i, i - 1, stops[0]);
      if (e) stops.unshift(e);
    }
    if (j < t.stops.length - 1) {
      const e = edge(j, j + 1, stops[stops.length - 1]);
      if (e) stops.push(e);
    }
    if (stops.length < 2) continue;
    const days = Math.floor(time(stops[0]) / 86400);
    let service = t.service;
    if (days > 0) {
      for (const s of stops) {
        s.arr -= days * 86400;
        s.dep -= days * 86400;
      }
      service = `${t.service}+${days}`;
      if (!shifted.has(service)) shifted.set(service, shiftService(feed.services.get(t.service), service, days));
    }
    const end = (s) => s.edge ?? [feed.stops.get(s.stop).lon, feed.stops.get(s.stop).lat];
    kept.push({ ...t, service, stops, clip: t.shape && track !== C ? [end(stops[0]), end(stops[stops.length - 1])] : null });
  }
  for (const [id, s] of shifted) feed.services.set(id, s);
  feed.trips = kept;
}

function shiftService(s, id, days) {
  const rot = s.days
    .split('')
    .map((_, i) => s.days[(((i - days) % 7) + 7) % 7])
    .join('');
  return {
    id,
    days: rot,
    start: s.start === '99999999' ? s.start : addDays(s.start, days),
    end: s.end === '00000000' ? s.end : addDays(s.end, days),
    add: s.add.map((d) => addDays(d, days)),
    remove: s.remove.map((d) => addDays(d, days)),
  };
}

/* ------------------------------------------------------------------ one row per train instead of one per date */

/**
 * GO and UP publish every trip once per date (service_id = the date), so the same train appears up to
 * 180 times. Identical runs are folded into one trip with a calendar listing all its dates.
 */
function foldDates(feed) {
  const dateOnly = [...feed.services.values()].every((s) => !s.days.includes('1'));
  if (!dateOnly) return;
  const groups = new Map();
  for (const t of feed.trips) {
    const sig = [t.label, t.line, t.block, t.shape, t.headsign, t.dir, t.stops.map((s) => `${s.stop}@${s.arr}/${s.dep}`).join(',')].join('|');
    let g = groups.get(sig);
    if (!g) groups.set(sig, (g = { trip: t, dates: new Set() }));
    for (const d of feed.services.get(t.service).add) g.dates.add(d);
  }
  const bySet = new Map();
  const services = new Map();
  const trips = [];
  for (const g of groups.values()) {
    const dates = [...g.dates].sort();
    const k = dates.join(',');
    let id = bySet.get(k);
    if (!id) {
      id = `${feed.src.key}:d${bySet.size + 1}`;
      bySet.set(k, id);
      services.set(id, { id, days: '0000000', start: '99999999', end: '00000000', add: dates, remove: [] });
    }
    trips.push({ ...g.trip, service: id });
  }
  console.log(`  ${feed.src.name}: ${feed.trips.length} dated trips folded into ${trips.length} (${services.size} calendars)`);
  feed.trips = trips;
  feed.services = services;
}

/* ------------------------------------------------------------------ Terminal Link (no GTFS published) */

/**
 * Pearson's Terminal Link: two independent 7-car cable-hauled shuttles on side-by-side elevated tracks,
 * Terminal 1 – Terminal 3 – Viscount (1.5 km), about four minutes end to end, 24 hours a day.
 * One train runs at quiet times (00:30–03:30 and 08:00–11:30, when the airport quotes an 8-minute wait).
 * Station positions are approximate.
 */
function terminalLink(allServices) {
  const K = 'tl';
  const stops = new Map(
    [
      { id: 'tl:T1', name: 'Terminal 1', lat: 43.68262, lon: -79.61255 },
      { id: 'tl:T3', name: 'Terminal 3', lat: 43.68611, lon: -79.61972 },
      { id: 'tl:VS', name: 'Viscount', lat: 43.68935, lon: -79.61085 },
    ].map((s) => [s.id, { ...s, feed: K }]),
  );
  const T1 = stops.get('tl:T1');
  const T3 = stops.get('tl:T3');
  const VS = stops.get('tl:VS');
  // approximate guideway: north-west from the Terminal 1 garage to Terminal 3, then east to the Value Park Garage
  const out = [
    [T1.lon, T1.lat],
    [-79.616, 43.6838],
    [-79.6185, 43.6848],
    [T3.lon, T3.lat],
    [-79.619, 43.6876],
    [-79.6165, 43.6888],
    [-79.6135, 43.6894],
    [VS.lon, VS.lat],
  ];
  const shapes = new Map([
    ['tl:out', out],
    ['tl:back', out.slice().reverse()],
  ]);

  let start = '99999999';
  for (const s of allServices) {
    if (s.days.includes('1') && s.start < start) start = s.start;
    for (const d of s.add) if (d < start) start = d;
  }
  const services = new Map([['tl:daily', { id: 'tl:daily', days: '1111111', start: start === '99999999' ? '20260101' : start, end: '20991231', add: [], remove: [] }]]);

  // 480 s cycle per train (divides the day exactly, so the shuttles carry on across midnight)
  const LEG1 = 88;
  const DWELL = 36;
  const LEG2 = 80;
  const ONE_WAY = LEG1 + DWELL + LEG2; // 204 s
  const CYCLE = 2 * (ONE_WAY + DWELL); // 480 s
  const quiet = (t) => (t >= 1800 && t < 12600) || (t >= 28800 && t < 41400);
  const trips = [];
  for (const [train, offset] of [
    ['A', 0],
    ['B', CYCLE / 2],
  ]) {
    let n = 0;
    for (let t0 = offset; t0 < 86400; t0 += CYCLE / 2) {
      if (train === 'B' && quiet(t0)) continue;
      const outbound = Math.round((t0 - offset) / (CYCLE / 2)) % 2 === 0;
      const seq = outbound ? [T1, T3, VS] : [VS, T3, T1];
      const times = [
        [t0, t0],
        [t0 + LEG1, t0 + LEG1 + DWELL],
        [t0 + ONE_WAY, t0 + ONE_WAY],
      ];
      n++;
      trips.push({
        id: `TL-${train}${String(n).padStart(3, '0')}`,
        label: `TL-${train}${String(n).padStart(3, '0')}`,
        feed: K,
        line: 'tl',
        service: 'tl:daily',
        dir: outbound ? 0 : 1,
        shape: outbound ? 'tl:out' : 'tl:back',
        headsign: outbound ? 'Viscount' : 'Terminal 1',
        block: `tl:${train}`,
        stops: seq.map((s, k) => ({ seq: k, stop: s.id, arr: times[k][0], dep: times[k][1] })),
      });
    }
  }
  return {
    src: { key: K, name: 'Terminal Link', url: 'built in (Toronto Pearson published service pattern)' },
    timezone: 'America/Toronto',
    info: {},
    lines: new Map([['tl', { id: 'tl', name: 'Terminal Link', short: 'TL', group: 'airport', mode: 'tl', color: '#00A19A', textColor: '#FFFFFF', routeIds: [] }]]),
    trips,
    stops,
    services,
    shapes,
  };
}

/* ------------------------------------------------------------------ stations */

/** single-link clusters of stops: same name nearby, plus VIA stops sharing a GO station */
function buildStations(feeds, lineMeta) {
  const stops = new Map();
  for (const f of feeds) for (const [id, s] of f.stops) stops.set(id, s);
  const usedLines = new Map();
  for (const f of feeds)
    for (const t of f.trips)
      for (const s of t.stops) {
        if (!s.stop) continue; // a VIA run's end point on the region's edge
        let set = usedLines.get(s.stop);
        if (!set) usedLines.set(s.stop, (set = new Set()));
        set.add(t.line);
      }
  const items = [...usedLines].map(([id, lines]) => {
    const st = stops.get(id);
    const streetcar = [...lines].every((l) => lineMeta.get(l).group === 'streetcar');
    const base = baseName(st.feed, st.name, streetcar);
    let key = norm(base);
    const alias = ALIAS[st.feed]?.[key];
    if (alias && !streetcar) key = alias;
    return { id, st, lines, streetcar, base, key, p: xy(st.lon, st.lat), parent: -1 };
  });
  items.forEach((it, i) => (it.parent = i));
  const find = (i) => {
    while (items[i].parent !== i) i = items[i].parent = items[items[i].parent].parent;
    return i;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) items[Math.max(ra, rb)].parent = Math.min(ra, rb);
  };
  const byKey = new Map();
  items.forEach((it, i) => byKey.set(it.key, [...(byKey.get(it.key) ?? []), i]));
  for (const list of byKey.values()) {
    for (let x = 0; x < list.length; x++)
      for (let y = x + 1; y < list.length; y++) {
        const a = items[list[x]];
        const b = items[list[y]];
        // VIA has one stop per station, so two VIA stops are never the same place (Niagara Falls ON / NY)
        if (a.st.feed === 'via' && b.st.feed === 'via') continue;
        const limit = a.streetcar && b.streetcar ? 150 : a.streetcar || b.streetcar ? 500 : 800;
        if (dist2(a.p, b.p) < limit) union(list[x], list[y]);
      }
  }
  // VIA stops at GO stations under a different name ("Oshawa" / "Durham College Oshawa GO")
  const go = items.map((it, i) => [it, i]).filter(([it]) => it.st.feed === 'go');
  items.forEach((it, i) => {
    if (it.st.feed !== 'via') return;
    let best = -1;
    let bd = 300;
    for (const [g, j] of go) {
      const d = dist2(it.p, g.p);
      if (d < bd) [best, bd] = [j, d];
    }
    if (best >= 0) union(i, best);
  });

  const clusters = new Map();
  items.forEach((it, i) => {
    const r = find(i);
    if (!clusters.has(r)) clusters.set(r, []);
    clusters.get(r).push(it);
  });
  const stationOfStop = new Map();
  const stations = [];
  for (const members of clusters.values()) {
    const lines = new Set(members.flatMap((m) => [...m.lines]));
    const groups = new Set([...lines].map((l) => lineMeta.get(l).group));
    const keyed = members.find((m) => DISPLAY[m.key]);
    let name;
    if (keyed) name = DISPLAY[keyed.key];
    else {
      const rank = (m) => (m.streetcar ? 9 : FEED_RANK[m.st.feed] ?? 5);
      const top = Math.min(...members.map(rank));
      const counts = new Map();
      for (const m of members) if (rank(m) === top) counts.set(m.base, (counts.get(m.base) ?? 0) + 1);
      name = [...counts].sort((a, b) => b[1] - a[1])[0][0];
      const ttc = members.some((m) => m.st.feed === 'ttc');
      if (!ttc && (groups.has('go') || lines.has('up')) && !/\bGO\b/.test(name)) name += ' GO';
    }
    const idx = stations.length;
    for (const m of members) stationOfStop.set(m.id, idx);
    stations.push({
      id: members[0].id,
      name,
      lon: +(members.reduce((a, m) => a + m.st.lon, 0) / members.length).toFixed(6),
      lat: +(members.reduce((a, m) => a + m.st.lat, 0) / members.length).toFixed(6),
      lines,
      kind: [...groups].every((g) => g === 'streetcar') ? 'stop' : undefined,
    });
  }
  return { stations, stationOfStop, stops };
}

/* ------------------------------------------------------------------ build */

async function build(sources) {
  const feeds = [];
  for (const src of sources) {
    const t0 = Date.now();
    const f = await loadFeed(src);
    await loadShapes(f);
    if (src.key === 'via') clipVia(f);
    foldDates(f);
    console.log(`  ${src.name}: ${f.lines.size} lines, ${f.trips.length} trips (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    if (!f.trips.length) throw new Error(`The ${src.name} feed has no usable train trips`);
    feeds.push(f);
  }
  feeds.push(terminalLink(feeds.flatMap((f) => [...f.services.values()])));

  // lines, in display order
  const lineMeta = new Map();
  for (const f of feeds) for (const [id, l] of f.lines) lineMeta.set(id, l);
  const usedLines = new Set(feeds.flatMap((f) => f.trips.map((t) => t.line)));
  const lineList = [...lineMeta.values()].filter((l) => usedLines.has(l.id)).sort((a, b) => lineOrder(a) - lineOrder(b));
  const order = new Map(lineList.map((l, i) => [l.id, i]));

  const { stations, stationOfStop, stops } = buildStations(feeds, lineMeta);

  // shapes
  const shapes = [];
  const shapeIndex = new Map();
  const shapeXY = [];
  const rawShape = new Map();
  for (const f of feeds) for (const [id, pts] of f.shapes) rawShape.set(id, pts);
  const addShape = (id, line, lonlat) => {
    const pts = [];
    for (const p of lonlat) {
      const q = pts[pts.length - 1];
      if (!q || Math.abs(q[0] - p[0]) > 1e-7 || Math.abs(q[1] - p[1]) > 1e-7) pts.push(p);
    }
    if (pts.length < 2) return -1;
    const simple = simplify(despike(pts), SIMPLIFY[lineMeta.get(line).mode] ?? 0.8).map(([lon, lat]) => [Math.round(lon * 1e6), Math.round(lat * 1e6)]);
    // delta-encoded micro-degrees: [lon0, lat0, dlon1, dlat1, …]
    const d = [];
    let px = 0;
    let py = 0;
    for (const [x, y] of simple) {
      d.push(x - px, y - py);
      px = x;
      py = y;
    }
    const idx = shapes.length;
    shapes.push({ id, line, d });
    const P = simple.map(([x, y]) => xy(x / 1e6, y / 1e6));
    shapeXY.push({ P, cum: cumulative(P) });
    shapeIndex.set(id, idx);
    return idx;
  };
  const coordsOf = (si) => {
    const d = shapes[si].d;
    const out = [];
    let x = 0;
    let y = 0;
    for (let i = 0; i < d.length; i += 2) {
      x += d[i];
      y += d[i + 1];
      out.push([x / 1e6, y / 1e6]);
    }
    return out;
  };

  // services
  const services = new Map();
  for (const f of feeds) for (const t of f.trips) if (!services.has(t.service)) services.set(t.service, f.services.get(t.service));
  const serviceList = [...services.values()].sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
  const serviceIdx = new Map(serviceList.map((s, i) => [s.id, i]));

  // patterns, timing profiles, blocks, trips
  const patterns = [];
  const patternIndex = new Map();
  const finalIndex = new Map();
  const profiles = [];
  const profileIndex = new Map();
  const blocks = [];
  const blockIndex = new Map();
  const rows = [];
  let dropped = 0;

  // a pattern's track: its own GTFS shape, or a longer one of the same line that it runs along exactly
  // (TTC gives almost every short working its own copy of the line's track)
  const lineShapes = new Map();
  const ownLength = new Map();
  const fits = (si, stopXY, own) => {
    // every stop must lie as close to the candidate as to the trip's own track, over the same distance
    const { P, cum } = shapeXY[si];
    const at = projectStops(P, stopXY);
    for (let k = 0; k < at.length; k++) {
      if (k && at[k] <= at[k - 1]) return null;
      if (dist2(lerpPt(P, at[k]), stopXY[k]) > own.off[k] + 12) return null;
    }
    const len = distAt(cum, at[at.length - 1]) - distAt(cum, at[0]);
    return Math.abs(len - own.length) <= Math.max(40, own.length * 0.015) ? at : null;
  };
  const ownTrack = (id, pts, stopXY) => {
    // the trip's own track between its first and last stop: length, and how far each stop is from it
    let c = ownLength.get(id);
    if (!c) {
      const P = pts.map(([lon, lat]) => xy(lon, lat));
      ownLength.set(id, (c = { P, cum: cumulative(P) }));
    }
    const at = projectStops(c.P, stopXY);
    return { length: distAt(c.cum, at[at.length - 1]) - distAt(c.cum, at[0]), off: at.map((a, k) => dist2(lerpPt(c.P, a), stopXY[k])) };
  };

  for (const f of feeds) {
    // full-length runs first, so short workings can reuse their track
    const trips = f.trips.slice().sort((a, b) => (a.line < b.line ? -1 : a.line > b.line ? 1 : b.stops.length - a.stops.length));
    for (const t of trips) {
      const line = t.line;
      const mode = lineMeta.get(line).mode;
      // drop consecutive calls at the same station (two platforms of one interchange)
      const calls = [];
      for (const s of t.stops) {
        const st = s.stop ? stationOfStop.get(s.stop) : -1;
        const prev = calls[calls.length - 1];
        if (prev && st >= 0 && prev.st === st) {
          prev.dep = s.dep;
          continue;
        }
        calls.push({ ...s, st });
      }
      if (calls.length < 2) {
        dropped++;
        continue;
      }
      const callLonLat = calls.map((s) => s.edge ?? [stops.get(s.stop).lon, stops.get(s.stop).lat]);
      const stopXY = callLonLat.map(([lon, lat]) => xy(lon, lat));
      const st = calls.map((c) => c.st);
      let last = st.length - 1;
      while (last > 0 && st[last] < 0) last--;
      const headsign = tidyHeadsign(t.headsign, st[last] >= 0 ? stations[st[last]].name : '');
      const callKey = calls.map((s) => s.stop ?? 'edge').join(',');
      const pre = `${line}|${t.shape}|${t.clip ? t.clip.flat().join(',') : ''}|${callKey}|${headsign}`;
      let pi = patternIndex.get(pre);
      if (pi === undefined) {
        // the trip's own track
        let own = null;
        let ownId = '';
        if (t.shape && rawShape.has(t.shape)) {
          ownId = t.clip ? `${t.shape}|${callLonLat[0].join(',')}|${callLonLat[callLonLat.length - 1].join(',')}` : t.shape;
          own = t.clip ? sliceShape(rawShape.get(t.shape), t.clip[0], t.clip[1]) : rawShape.get(t.shape);
        } else {
          ownId = `auto:${line}:${callKey}`;
          own = callLonLat;
        }
        let si = shapeIndex.get(ownId) ?? -1;
        let at = null;
        if (si >= 0) at = projectStops(shapeXY[si].P, stopXY);
        else {
          const mine = ownTrack(ownId, own, stopXY);
          for (const cand of lineShapes.get(line) ?? []) {
            at = fits(cand, stopXY, mine);
            if (at) {
              si = cand;
              break;
            }
          }
          if (si < 0) {
            si = addShape(ownId, line, own);
            if (si < 0) {
              dropped++;
              continue;
            }
            lineShapes.set(line, [...(lineShapes.get(line) ?? []), si]);
            at = projectStops(shapeXY[si].P, stopXY);
            // a shape drawn against the direction of travel would squash every stop onto one end: try it reversed
            if (fitError(shapeXY[si].P, at, stopXY) > 60) {
              const rev = coordsOf(si).reverse();
              const ri = shapeIndex.get(`${shapes[si].id}:rev`) ?? addShape(`${shapes[si].id}:rev`, line, rev);
              const rat = projectStops(shapeXY[ri].P, stopXY);
              if (fitError(shapeXY[ri].P, rat, stopXY) < fitError(shapeXY[si].P, at, stopXY)) {
                si = ri;
                at = rat;
                lineShapes.get(line).push(ri);
              }
            }
          }
        }
        const err = fitError(shapeXY[si].P, at, stopXY);
        if (err > 150) console.warn(`  warning: ${line} “${headsign}” stops sit ${err.toFixed(0)} m off its track (${shapes[si].id})`);
        // trips calling at the same stations on the same track share a pattern, whichever platform ids they use
        const fkey = `${line}|${t.dir}|${si}|${st.join(',')}|${headsign}`;
        pi = finalIndex.get(fkey);
        if (pi === undefined) {
          pi = patterns.length;
          finalIndex.set(fkey, pi);
          patterns.push({ id: `p${pi}`, line, dir: t.dir, headsign, shape: si, stations: st, at: at.map((v) => +v.toFixed(3)), _dist: at.map((v) => distAt(shapeXY[si].cum, v)) });
        }
        patternIndex.set(pre, pi);
      }
      const p = patterns[pi];
      const times = tidyTimes(
        calls.map((s) => s.arr),
        calls.map((s) => s.dep),
        p._dist,
        VMAX[mode] ?? 16,
      );
      if (!times) {
        dropped++;
        continue;
      }
      const start = times.dep[0];
      // delta-encoded: [arr0 - start, dep0 - arr0, arr1 - dep0, dep1 - arr1, …]
      const prof = [];
      let prev = start;
      for (let k = 0; k < times.arr.length; k++) {
        prof.push(times.arr[k] - prev, times.dep[k] - times.arr[k]);
        prev = times.dep[k];
      }
      const key = prof.join(',');
      let fi = profileIndex.get(key);
      if (fi === undefined) {
        fi = profiles.length;
        profileIndex.set(key, fi);
        profiles.push(prof);
      }
      let bi = -1;
      if (t.block) {
        bi = blockIndex.get(t.block) ?? -1;
        if (bi < 0) {
          bi = blocks.length;
          blockIndex.set(t.block, bi);
          blocks.push(t.block);
        }
      }
      rows.push([t.label, pi, serviceIdx.get(t.service), start, fi, bi]);
    }
  }
  if (dropped) console.warn(`  ${dropped} trips skipped (unusable stop times or shape)`);
  if (!rows.length) throw new Error('No usable trips were found');
  rows.sort((a, b) => a[3] - b[3] || a[1] - b[1]);

  // only stations and shapes that patterns use (stations are re-indexed)
  const usedStations = new Set(patterns.flatMap((p) => p.stations).filter((i) => i >= 0));
  const remap = new Map();
  const stationOut = [];
  stations.forEach((s, i) => {
    if (!usedStations.has(i)) return;
    remap.set(i, stationOut.length);
    stationOut.push({ id: s.id, name: s.name, lon: s.lon, lat: s.lat, lines: [...s.lines].sort((a, b) => order.get(a) - order.get(b)), ...(s.kind ? { kind: s.kind } : {}) });
  });

  return {
    version: 2,
    generatedAt: new Date().toISOString(),
    timezone: 'America/Toronto',
    feeds: feeds.map((f) => {
      const keys = [...f.services.values()];
      let start = '99999999';
      let end = '00000000';
      for (const s of keys) {
        for (const d of [...s.add, ...(s.days.includes('1') ? [s.start, s.end] : [])]) {
          if (d < start) start = d;
          if (d > end) end = d;
        }
      }
      // the dates the feed says it is valid for, else the dates its calendars cover
      return { key: f.src.key, name: f.src.name, url: f.src.url, lastModified: f.src.lastModified, version: f.info.version, start: f.info.start ?? start, end: f.info.end ?? end };
    }),
    lines: lineList.map(({ id, name, short, color, textColor, group, mode, routeIds }) => ({ id, name, short, color, textColor, group, mode, routeIds })),
    stations: stationOut,
    shapes,
    patterns: patterns.map(({ _dist, ...p }) => ({ ...p, stations: p.stations.map((i) => (i < 0 ? -1 : remap.get(i))) })),
    services: serviceList,
    profiles,
    blocks,
    trips: rows,
  };
}
