/** dark text on light line colours (Line 1 yellow, VIA yellow), white on the rest */
export function inkFor(hex: string): string {
  const n = parseInt(hex.replace('#', ''), 16);
  const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.62 ? '#14181d' : '#ffffff';
}
