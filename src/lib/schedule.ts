import { ARR_DWELL, PRE_SHOW } from '../config';
import type { TransitData } from '../types';
import type { Line, Network, Pattern } from './network';
import { addDays, weekdayOf, type Zone } from './time';

/**
 * Turns the GTFS timetables into trains. For a service date it collects the trips that run,
 * links them into vehicles (by GTFS block_id when the feed has them, otherwise by turning
 * trains back at the terminus first-in-first-out), and answers "where is every train at
 * time t" with a binary search per vehicle — cheap enough to run every animation frame.
 *
 * The four feeds are published separately and cover different dates, so each feed's calendar
 * is looked up on its own: when a date is past the end of one feed, that feed borrows the same
 * weekday from its nearest covered week while the others carry on with their own timetable.
 */

export interface TripRun {
  /** run label (GO/UP train number, VIA train number); empty when the feed's ids mean nothing to riders */
  id: string;
  pattern: Pattern;
  /** first departure, seconds after service-day midnight */
  start: number;
  /** [arr0, dep0, arr1, dep1, …] seconds after `start` */
  t: Int32Array;
  /** arrival at the last stop, seconds after service-day midnight */
  end: number;
  block: number;
  vehicle: Vehicle | null;
}

export type SpanKind = 'standby' | 'trip' | 'arrived';
interface Span {
  a: number;
  b: number;
  kind: SpanKind;
  trip: TripRun;
  hint: number;
}

export interface Vehicle {
  /** unique across days: "<date>:<id>" */
  key: string;
  /** short label, e.g. 1-07, LW-03, VIA 65 */
  id: string;
  line: Line;
  trips: TripRun[];
  spans: Span[];
  plan: DayPlan;
  st: TrainState;
}

export type Mode = 'standby' | 'stop' | 'run' | 'arrived';
export interface TrainState {
  v: Vehicle;
  mode: Mode;
  trip: TripRun;
  /** stop index: where the train is (standby/stop/arrived) or the stop it just left (run) */
  k: number;
  /** distance along the trip's shape */
  dist: number;
  /** 0…1 progress between stop k and k+1 while running */
  u: number;
  /** metres per second */
  speed: number;
  /** service seconds of the next event: departure, or arrival at the next stop */
  nextT: number;
  /** service seconds of this state (in the vehicle's own plan) */
  t: number;
}

interface StopEvent {
  trip: TripRun;
  k: number;
  arr: number;
  dep: number;
  hx: number;
  hy: number;
}

export interface DayPlan {
  /** the calendar date this plan is for (YYYYMMDD) */
  key: string;
  /** feeds that do not cover this date and run the schedule of another date instead */
  borrowed: { feed: string; key: string }[];
  /** epoch ms of this date's service-day midnight */
  base: number;
  trips: TripRun[];
  vehicles: Vehicle[];
  byKey: Map<string, Vehicle>;
  /** stop calls per station, for keeping platforms clear (streetcars: only their terminal stops) */
  events: Map<number, StopEvent[]>;
  /** trips per pattern, in departure order */
  byPattern: Map<number, TripRun[]>;
  special: boolean;
  firstDep: number;
  lastArr: number;
}

export interface Departure {
  ms: number;
  trip: TripRun;
  vehicle: Vehicle | null;
}
export interface DepartureGroup {
  line: Line;
  headsign: string;
  items: Departure[];
}

/**
 * What a train is called on screen: the operator's train number when it has one (GO "LE-9109", UP, VIA "VIA 65"),
 * else the vehicle's own label. GO trains run through Union from one line onto another, so the name and the line
 * shown follow the trip, not the vehicle's first line of the day.
 */
export function trainName(trip: TripRun, v: Vehicle): string {
  const short = trip.pattern.line.short;
  if (!trip.id) return v.id;
  return trip.id.startsWith(short) ? trip.id : `${short}-${trip.id}`;
}

/* speed profile between stops: ease out of the platform, cruise, ease in (acceleration changes smoothly) */
const PA = 0.22;
const PB = 0.26;
const PV = 1 / (1 - PA / 2 - PB / 2);
const easeIn = (x: number) => x * x * x - (x * x * x * x) / 2; // integral of smoothstep
const smooth = (x: number) => x * x * (3 - 2 * x);
export function prof(u: number): number {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  if (u < PA) return PV * PA * easeIn(u / PA);
  if (u < 1 - PB) return PV * (PA / 2 + (u - PA));
  return 1 - PV * PB * easeIn((1 - u) / PB);
}
function profSpeed(u: number): number {
  if (u <= 0 || u >= 1) return 0;
  if (u < PA) return PV * smooth(u / PA);
  if (u < 1 - PB) return PV;
  return PV * smooth((1 - u) / PB);
}

const MIN_GAP = 12;
const PLAN_CACHE = 4;

interface FeedCal {
  key: string;
  name: string;
  start: string;
  end: string;
  services: number[];
}

export class Schedule {
  private readonly profiles: Int32Array[];
  private readonly plans = new Map<string, DayPlan>();
  private readonly feeds: FeedCal[];
  readonly rangeStart: string;
  readonly rangeEnd: string;

  constructor(
    private readonly data: TransitData,
    private readonly net: Network,
    readonly zone: Zone,
  ) {
    // profiles are stored as differences: rebuild [arr0, dep0, arr1, dep1, …] relative to the first departure
    this.profiles = data.profiles.map((p) => {
      const out = new Int32Array(p.length);
      let t = 0;
      for (let i = 0; i < p.length; i += 2) {
        out[i] = t + p[i];
        out[i + 1] = out[i] + p[i + 1];
        t = out[i + 1];
      }
      return out;
    });
    const byFeed = new Map<string, number[]>();
    data.services.forEach((s, i) => {
      const f = s.id.split(':')[0];
      byFeed.set(f, [...(byFeed.get(f) ?? []), i]);
    });
    this.feeds = [...byFeed].map(([key, services]) => {
      const info = data.feeds?.find((f) => f.key === key);
      let a = '99999999';
      let b = '00000000';
      for (const i of services) {
        const s = data.services[i];
        for (const d of [...s.add, ...(s.days.includes('1') ? [s.start, s.end] : [])]) {
          if (d < a) a = d;
          if (d > b) b = d;
        }
      }
      return { key, name: info?.name ?? key.toUpperCase(), start: info?.start ?? a, end: info?.end ?? b, services };
    });
    this.rangeStart = this.feeds.reduce((m, f) => (f.start < m ? f.start : m), '99999999');
    this.rangeEnd = this.feeds.reduce((m, f) => (f.end > m ? f.end : m), '00000000');
  }

  private serviceOn(i: number, key: string): boolean {
    const s = this.data.services[i];
    const col = (weekdayOf(key) + 6) % 7; // GTFS days start on Monday
    let on = s.start <= key && key <= s.end && s.days[col] === '1';
    if (s.remove.includes(key)) on = false;
    if (s.add.includes(key)) on = true;
    return on;
  }

  /** indexes of the services running on a date, with each feed falling back to its nearest covered week */
  activeServices(key: string): { active: Set<number>; borrowed: { feed: string; key: string }[]; main: Set<number> } {
    const active = new Set<number>();
    const main = new Set<number>();
    const borrowed: { feed: string; key: string }[] = [];
    for (const f of this.feeds) {
      let list = f.services.filter((i) => this.serviceOn(i, key));
      if (!list.length && (key < f.start || key > f.end)) {
        const step = key > f.end ? -7 : 7;
        let k = key;
        for (let i = 0; i < 80; i++) {
          k = addDays(k, step);
          const l = f.services.filter((s) => this.serviceOn(s, k));
          if (l.length) {
            list = l;
            borrowed.push({ feed: f.name, key: k });
            break;
          }
        }
      }
      for (const i of list) active.add(i);
      if (f.key === 'ttc') for (const i of list) main.add(i);
    }
    return { active, borrowed, main };
  }

  private typical: Map<number, string> | null = null;

  /**
   * A holiday or special day runs a different set of services from the usual one for that weekday. Judged on the
   * TTC calendar, which has explicit holiday service (GO and UP list every date separately anyway).
   */
  private isSpecial(key: string, main: Set<number>): boolean {
    const ttc = this.feeds.find((f) => f.key === 'ttc');
    if (!ttc) return false;
    if (!this.typical) {
      const counts = new Map<number, Map<string, number>>();
      for (let k = ttc.start, i = 0; k <= ttc.end && i < 400; k = addDays(k, 1), i++) {
        const sig = ttc.services
          .filter((s) => this.serviceOn(s, k))
          .sort((a, b) => a - b)
          .join(',');
        if (!sig) continue;
        const wd = weekdayOf(k);
        const m = counts.get(wd) ?? new Map<string, number>();
        m.set(sig, (m.get(sig) ?? 0) + 1);
        counts.set(wd, m);
      }
      this.typical = new Map();
      for (const [wd, m] of counts) this.typical.set(wd, [...m.entries()].sort((a, b) => b[1] - a[1])[0][0]);
    }
    const sig = [...main].sort((a, b) => a - b).join(',');
    const usual = this.typical.get(weekdayOf(key));
    return !!sig && usual !== undefined && sig !== usual;
  }

  plan(key: string): DayPlan {
    let p = this.plans.get(key);
    if (p) {
      this.plans.delete(key); // keep most recently used last
      this.plans.set(key, p);
      return p;
    }
    p = this.build(key);
    this.plans.set(key, p);
    while (this.plans.size > PLAN_CACHE) this.plans.delete(this.plans.keys().next().value!);
    return p;
  }

  /** a plan for this date that is already built (for looking up vehicles by key) */
  cachedPlan(key: string): DayPlan | undefined {
    return this.plans.get(key);
  }

  private build(key: string): DayPlan {
    const { active, borrowed, main } = this.activeServices(key);
    const plan: DayPlan = {
      key,
      borrowed,
      base: this.zone.serviceBase(key),
      trips: [],
      vehicles: [],
      byKey: new Map(),
      events: new Map(),
      byPattern: new Map(),
      special: this.isSpecial(key, main),
      firstDep: Infinity,
      lastArr: -Infinity,
    };
    for (const row of this.data.trips) {
      if (!active.has(row[2])) continue;
      const t = this.profiles[row[4]];
      const trip: TripRun = { id: row[0], pattern: this.net.patterns[row[1]], start: row[3], t, end: row[3] + t[t.length - 2], block: row[5], vehicle: null };
      plan.trips.push(trip);
      plan.firstDep = Math.min(plan.firstDep, trip.start);
      plan.lastArr = Math.max(plan.lastArr, trip.end);
    }
    plan.trips.sort((a, b) => a.start - b.start);

    for (const trip of plan.trips) {
      const p = trip.pattern;
      const list = plan.byPattern.get(p.idx);
      if (list) list.push(trip);
      else plan.byPattern.set(p.idx, [trip]);
      // stop calls for keeping platforms clear; streetcars stop at the kerb, so only their terminals matter
      const n = p.stations.length;
      const streetcar = p.line.group === 'streetcar';
      p.stations.forEach((st, k) => {
        if (st.idx < 0 || (streetcar && k > 0 && k < n - 1)) return;
        const ev = plan.events.get(st.idx) ?? [];
        ev.push({ trip, k, arr: trip.start + trip.t[2 * k], dep: trip.start + trip.t[2 * k + 1], hx: p.hx[k], hy: p.hy[k] });
        plan.events.set(st.idx, ev);
      });
    }
    for (const list of plan.events.values()) list.sort((a, b) => a.arr - b.arr);

    this.makeVehicles(plan);
    for (const v of plan.vehicles) this.makeSpans(plan, v);
    return plan;
  }

  private makeVehicles(plan: DayPlan) {
    const chains: TripRun[][] = [];
    const loose: TripRun[] = [];
    const byBlock = new Map<number, TripRun[]>();
    for (const t of plan.trips) {
      if (t.block < 0) loose.push(t);
      else {
        const list = byBlock.get(t.block);
        if (list) list.push(t);
        else byBlock.set(t.block, [t]);
      }
    }
    for (const list of byBlock.values()) {
      // a block should never overlap itself; if the data says otherwise, split it
      let cur: TripRun[] = [];
      for (const t of list) {
        if (cur.length && t.start < cur[cur.length - 1].end) {
          loose.push(t);
          continue;
        }
        cur.push(t);
      }
      chains.push(cur);
    }

    // no block: a train arriving at a terminus takes the next trip out of that station, first in first out
    if (loose.length) {
      loose.sort((a, b) => a.start - b.start);
      const pool = new Map<string, { chain: TripRun[]; ready: number }[]>();
      for (const t of loose) {
        const st = t.pattern.stations;
        const from = `${t.pattern.line.id}:${st[0].edge ? `e${t.pattern.idx}` : st[0].group[0]}`;
        const q = pool.get(from) ?? [];
        let best = -1;
        for (let i = 0; i < q.length; i++) if (q[i].ready <= t.start && (best < 0 || q[i].ready < q[best].ready)) best = i;
        let chain: TripRun[];
        if (best >= 0) chain = q.splice(best, 1)[0].chain;
        else chains.push((chain = []));
        chain.push(t);
        pool.set(from, q);
        if (!t.pattern.leaves) {
          const to = `${t.pattern.line.id}:${st[st.length - 1].group[0]}`;
          pool.set(to, [...(pool.get(to) ?? []), { chain, ready: t.end + 120 }]);
        }
      }
    }

    chains.sort((a, b) => a[0].start - b[0].start);
    const counters = new Map<string, number>();
    for (const trips of chains) {
      if (!trips.length) continue;
      const line = trips[0].pattern.line;
      let id: string;
      if (line.group === 'via') {
        // VIA trains are known by their number (the block is "via:VIA 65")
        const b = trips[0].block >= 0 ? this.data.blocks[trips[0].block] : '';
        id = b.slice(b.indexOf(':') + 1) || trips[0].id || 'VIA';
      } else {
        const n = (counters.get(line.id) ?? 0) + 1;
        counters.set(line.id, n);
        id = `${line.short}-${String(n).padStart(2, '0')}`;
      }
      let key = `${plan.key}:${id}`;
      for (let i = 2; plan.byKey.has(key); i++) key = `${plan.key}:${id}#${i}`;
      const v: Vehicle = { key, id, line, trips, spans: [], plan, st: null as unknown as TrainState };
      v.st = { v, mode: 'standby', trip: trips[0], k: 0, dist: 0, u: 0, speed: 0, nextT: 0, t: 0 };
      for (const t of trips) t.vehicle = v;
      plan.vehicles.push(v);
      plan.byKey.set(v.key, v);
    }
  }

  /** is another train using the same side of the platform? (travelling the same way through the station) */
  private clearFrom(plan: DayPlan, trip: TripRun, k: number, from: number, until: number): number {
    const st = trip.pattern.stations[k];
    const hx = trip.pattern.hx[k];
    const hy = trip.pattern.hy[k];
    let a = from;
    for (const idx of st.group) {
      for (const e of plan.events.get(idx) ?? []) {
        if (e.trip === trip || e.hx * hx + e.hy * hy < 0.3) continue;
        if (e.arr < until && e.dep + MIN_GAP > a) a = Math.max(a, e.dep + MIN_GAP);
      }
    }
    return Math.min(a, until);
  }
  private clearUntil(plan: DayPlan, trip: TripRun, from: number, until: number): number {
    const p = trip.pattern;
    const k = p.stations.length - 1;
    let b = until;
    for (const idx of p.stations[k].group) {
      for (const e of plan.events.get(idx) ?? []) {
        if (e.trip === trip || e.hx * p.hx[k] + e.hy * p.hy[k] < 0.3) continue;
        if (e.arr >= from && e.arr - MIN_GAP < b) b = Math.max(from + 5, e.arr - MIN_GAP);
      }
    }
    return b;
  }

  /** a vehicle's day: waiting on the platform, running each trip, standing after arrival; hidden in between */
  private makeSpans(plan: DayPlan, v: Vehicle) {
    const spans: Span[] = [];
    let free = -Infinity;
    v.trips.forEach((tr, i) => {
      const nx = v.trips[i + 1];
      const p = tr.pattern;
      // a VIA train coming in from beyond the map appears at the edge already moving, and vanishes there
      if (!p.enters) {
        const a = this.clearFrom(plan, tr, 0, Math.max(tr.start - PRE_SHOW, free), tr.start);
        if (a < tr.start) spans.push({ a, b: tr.start, kind: 'standby', trip: tr, hint: 0 });
      }
      spans.push({ a: tr.start, b: tr.end, kind: 'trip', trip: tr, hint: 0 });
      let b = tr.end;
      if (!p.leaves) {
        b = tr.end + ARR_DWELL;
        if (nx) b = Math.min(b, nx.start);
        b = this.clearUntil(plan, tr, tr.end, b);
        if (b > tr.end) spans.push({ a: tr.end, b, kind: 'arrived', trip: tr, hint: 0 });
      }
      free = Math.max(b, tr.end);
    });
    v.spans = spans;
  }

  /** the vehicle's state at service time t of its plan, or null when it is out of sight */
  stateAt(v: Vehicle, t: number): TrainState | null {
    const S = v.spans;
    let lo = 0;
    let hi = S.length - 1;
    let idx = -1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (S[m].a <= t) {
        idx = m;
        lo = m + 1;
      } else hi = m - 1;
    }
    if (idx < 0 || t > S[idx].b) return null;
    const sp = S[idx];
    const tr = sp.trip;
    const p = tr.pattern;
    const n = p.stations.length;
    const o = v.st;
    o.trip = tr;
    o.t = t;
    o.u = 0;
    o.speed = 0;
    if (sp.kind === 'standby') {
      o.mode = 'standby';
      o.k = 0;
      o.dist = p.dist[0];
      o.nextT = tr.start;
      return o;
    }
    if (sp.kind === 'arrived') {
      o.mode = 'arrived';
      o.k = n - 1;
      o.dist = p.dist[n - 1];
      o.nextT = sp.b;
      return o;
    }
    const T = tr.t;
    const rel = t - tr.start;
    let k = sp.hint;
    while (k < n - 1 && T[2 * (k + 1)] <= rel) k++;
    while (k > 0 && T[2 * k] > rel) k--;
    sp.hint = k;
    if (k >= n - 1) {
      if (p.leaves) return null;
      o.mode = 'arrived';
      o.k = n - 1;
      o.dist = p.dist[n - 1];
      o.nextT = tr.end;
      return o;
    }
    const dep = T[2 * k + 1];
    o.k = k;
    if (rel < dep) {
      o.mode = 'stop';
      o.dist = p.dist[k];
      o.nextT = tr.start + dep;
      return o;
    }
    const arr = T[2 * (k + 1)];
    const dur = arr - dep;
    const u = dur > 0 ? (rel - dep) / dur : 1;
    const d0 = p.dist[k];
    const d1 = p.dist[k + 1];
    o.mode = 'run';
    o.u = u;
    // an edge point is not a stop: run through it at line speed rather than braking to a halt
    const entering = k === 0 && p.enters;
    const leaving = k + 1 === n - 1 && p.leaves;
    let f: number;
    let sp2: number;
    if (entering && leaving) {
      f = u;
      sp2 = 1;
    } else if (entering) {
      // cruise in, brake for the first real stop
      const cruise = 1 / (1 - PB / 2);
      f = u < 1 - PB ? cruise * u : 1 - cruise * PB * easeIn((1 - u) / PB);
      sp2 = u < 1 - PB ? cruise : cruise * smooth((1 - u) / PB);
    } else if (leaving) {
      const cruise = 1 / (1 - PA / 2);
      f = u < PA ? cruise * PA * easeIn(u / PA) : cruise * (PA / 2 + (u - PA));
      sp2 = u < PA ? cruise * smooth(u / PA) : cruise;
    } else {
      f = prof(u);
      sp2 = profSpeed(u);
    }
    o.dist = d0 + (d1 - d0) * f;
    o.speed = dur > 0 ? ((d1 - d0) / dur) * sp2 : 0;
    o.nextT = tr.start + arr;
    return o;
  }

  /** the plans that can have trains at this instant: today's, and yesterday's after-midnight runs */
  plansAt(ms: number): DayPlan[] {
    const today = this.zone.wall(ms).key;
    return [this.plan(addDays(today, -1)), this.plan(today)];
  }

  /** every visible train at instant `ms` (the state objects are reused between calls) */
  states(ms: number, out: TrainState[]): TrainState[] {
    out.length = 0;
    for (const plan of this.plansAt(ms)) {
      const t = (ms - plan.base) / 1000;
      if (t < plan.firstDep - PRE_SHOW - 60 || t > plan.lastArr + ARR_DWELL + 60) continue;
      for (const v of plan.vehicles) {
        const st = this.stateAt(v, t);
        if (st) out.push(st);
      }
    }
    return out;
  }

  findVehicle(key: string): Vehicle | undefined {
    const day = key.slice(0, 8);
    return (this.cachedPlan(day) ?? this.plan(day)).byKey.get(key);
  }

  /** upcoming departures from a station (and same-named neighbours), grouped by line and destination */
  departures(stations: number[], ms: number, per = 3): DepartureGroup[] {
    const today = this.zone.wall(ms).key;
    const groups = new Map<string, DepartureGroup>();
    const calls = stations.flatMap((i) => this.net.calls[i] ?? []);
    for (const key of [addDays(today, -1), today, addDays(today, 1)]) {
      const plan = this.plan(key);
      const t = (ms - plan.base) / 1000;
      if (t > plan.lastArr + 60) continue;
      for (const { pattern: p, k } of calls) {
        if (k === p.stations.length - 1 || p.headsign === 'Not in service') continue;
        const trips = plan.byPattern.get(p.idx);
        if (!trips) continue;
        const gk = `${p.line.id}|${p.headsign}`;
        let g = groups.get(gk);
        let taken = 0;
        for (const trip of trips) {
          const dep = trip.start + trip.t[2 * k + 1];
          if (dep < t - 10) continue;
          if (dep > t + 20 * 3600) break; // nothing further ahead than tomorrow's first trains
          if (!g) groups.set(gk, (g = { line: p.line, headsign: p.headsign, items: [] }));
          g.items.push({ ms: plan.base + dep * 1000, trip, vehicle: trip.vehicle });
          if (++taken >= per) break;
        }
      }
    }
    const out = [...groups.values()];
    for (const g of out) {
      g.items.sort((a, b) => a.ms - b.ms);
      g.items.length = Math.min(g.items.length, per);
    }
    return out.sort((a, b) => a.line.order - b.line.order || (a.items[0]?.ms ?? 0) - (b.items[0]?.ms ?? 0));
  }

  /** the next first departure of the day after `ms` (for the "no trains right now" notice) */
  nextService(ms: number): number | null {
    const today = this.zone.wall(ms).key;
    for (const key of [today, addDays(today, 1)]) {
      const plan = this.plan(key);
      if (!plan.trips.length) continue;
      const at = plan.base + plan.firstDep * 1000;
      if (at > ms) return at;
    }
    return null;
  }
}
