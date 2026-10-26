const RAD = Math.PI / 180;

/** Sun elevation in degrees (low-precision solar position, good to a fraction of a degree). */
export function sunElevation(ms: number, lat: number, lon: number): number {
  const d = ms / 86400000 - 10957.5; // days since J2000.0
  const g = (357.529 + 0.98560028 * d) * RAD;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
  const e = (23.439 - 0.00000036 * d) * RAD;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = (((18.697374558 + 24.06570982441908 * d) % 24) + 24) % 24;
  const ha = gmst * 15 * RAD + lon * RAD - ra;
  return Math.asin(Math.sin(lat * RAD) * Math.sin(dec) + Math.cos(lat * RAD) * Math.cos(dec) * Math.cos(ha)) / RAD;
}

/** Dark enough for the night map: sun more than 3° below the horizon (civil twilight). */
export const isDark = (ms: number, lat: number, lon: number) => sunElevation(ms, lat, lon) < -3;
