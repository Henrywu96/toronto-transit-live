/** Wall-clock time in the agencies' time zone (America/Toronto), independent of the viewer's own zone. */

export interface Wall {
  y: number;
  mo: number;
  d: number;
  /** 0 = Sunday */
  wd: number;
  h: number;
  mi: number;
  s: number;
  /** YYYYMMDD, as GTFS writes dates */
  key: string;
}

export const pad = (n: number) => String(n).padStart(2, '0');
export const dateKey = (y: number, m: number, d: number) => `${y}${pad(m)}${pad(d)}`;
const keyParts = (key: string) => [+key.slice(0, 4), +key.slice(4, 6), +key.slice(6, 8)] as const;

export function addDays(key: string, n: number): string {
  const [y, m, d] = keyParts(key);
  const t = new Date(Date.UTC(y, m - 1, d) + n * 86400000);
  return dateKey(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}
/** 0 = Sunday … 6 = Saturday */
export function weekdayOf(key: string): number {
  const [y, m, d] = keyParts(key);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const keyLabel = (key: string) => {
  const [y, m, d] = keyParts(key);
  return `${WEEKDAYS[weekdayOf(key)].slice(0, 3)}, ${MONTHS[m - 1]} ${d}, ${y}`;
};

export class Zone {
  private readonly dtf: Intl.DateTimeFormat;
  private cacheKey = NaN;
  private cacheOff = 0;

  constructor(readonly tz: string) {
    this.dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
  }

  /** milliseconds to add to UTC to get local wall-clock time at instant `ms` */
  offsetExact(ms: number): number {
    const o: Record<string, string> = {};
    for (const p of this.dtf.formatToParts(ms)) o[p.type] = p.value;
    const wall = Date.UTC(+o.year, +o.month - 1, +o.day, +o.hour % 24, +o.minute, +o.second);
    return wall - Math.floor(ms / 1000) * 1000;
  }

  /** same as offsetExact, cached per quarter hour (zone changes happen on the hour) */
  offset(ms: number): number {
    const k = Math.floor(ms / 900000);
    if (k !== this.cacheKey) {
      this.cacheKey = k;
      this.cacheOff = this.offsetExact(ms);
    }
    return this.cacheOff;
  }

  wall(ms: number): Wall {
    const t = new Date(ms + this.offset(ms));
    const y = t.getUTCFullYear();
    const mo = t.getUTCMonth() + 1;
    const d = t.getUTCDate();
    return { y, mo, d, wd: t.getUTCDay(), h: t.getUTCHours(), mi: t.getUTCMinutes(), s: t.getUTCSeconds(), key: dateKey(y, mo, d) };
  }

  /** epoch ms of local midnight-ish for a date: GTFS counts stop times from "noon minus 12 h" */
  serviceBase(key: string): number {
    const [y, m, d] = keyParts(key);
    const noonUtc = Date.UTC(y, m - 1, d, 12);
    let e = noonUtc - this.offsetExact(noonUtc);
    e = noonUtc - this.offsetExact(e);
    return e - 12 * 3600 * 1000;
  }

  /** epoch ms for a local date + seconds after its service-day midnight */
  at(key: string, seconds: number): number {
    return this.serviceBase(key) + seconds * 1000;
  }
}

export const hm = (w: Pick<Wall, 'h' | 'mi'>) => `${pad(w.h)}:${pad(w.mi)}`;
export const hms = (w: Pick<Wall, 'h' | 'mi' | 's'>) => `${pad(w.h)}:${pad(w.mi)}:${pad(w.s)}`;

/** "now", "1 min", "12 min" */
export function untilLabel(sec: number): string {
  if (sec < 25) return 'now';
  if (sec < 90) return '1 min';
  if (sec < 3600) return `${Math.round(sec / 60)} min`;
  const h = Math.floor(sec / 3600);
  return `${h} h ${Math.round((sec - h * 3600) / 60)} min`;
}
