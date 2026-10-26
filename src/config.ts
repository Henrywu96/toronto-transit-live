/** App-wide settings. Data-specific values (lines, stations, times) come from public/data/transit.json. */
import type { LineGroup } from './types';

export type BasemapKey = 'light' | 'gray' | 'dark' | 'none';
export type StyleMode = 'auto' | 'light' | 'gray' | 'dark';

/** OpenFreeMap vector styles: free, no API key, OpenStreetMap data. */
export const BASEMAPS: Record<Exclude<BasemapKey, 'none'>, { url: string; label: string; dark: boolean }> = {
  light: { url: 'https://tiles.openfreemap.org/styles/liberty', label: 'Map', dark: false },
  gray: { url: 'https://tiles.openfreemap.org/styles/positron', label: 'Light', dark: false },
  dark: { url: 'https://tiles.openfreemap.org/styles/dark', label: 'Dark', dark: true },
};
export const GLYPHS = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';

/** Union Station: used for the day/night switch and as the downtown view */
export const CITY = { lon: -79.3806, lat: 43.6453 };

/** the line groups, in display order */
export const GROUPS: { id: LineGroup; label: string; short: string; color: string }[] = [
  { id: 'subway', label: 'Subway', short: 'Sub', color: '#D5C82B' },
  { id: 'lrt', label: 'LRT', short: 'LRT', color: '#FF8000' },
  { id: 'streetcar', label: 'Streetcar', short: 'Car', color: '#ED1C24' },
  { id: 'go', label: 'GO Transit', short: 'GO', color: '#00853E' },
  { id: 'airport', label: 'Airport', short: 'Air', color: '#0075D2' },
  { id: 'via', label: 'VIA Rail', short: 'VIA', color: '#FFCB06' },
];

/**
 * Which parts of each line are in tunnel. GTFS gives track geometry but says nothing about tunnels, so
 * every link between two successive stations is either `base`, or split into tunnel / surface stretches.
 * Fractions run FROM `from` TO `to` along the track; trips the other way round are handled automatically.
 * Station keys are lower-case station names with punctuation removed ("Bloor-Yonge" → "bloor yonge").
 *
 * Open cuts (Rosedale, Davisville) and the Prince Edward Viaduct's lower deck count as surface: the trains
 * are out in the open there. Portal positions are approximate.
 */
export interface TunnelRule {
  lines: string[];
  base: 'tunnel' | 'surface';
  links: { from: string; to: string; tunnel?: [number, number][]; surface?: [number, number][] }[];
}

export const TUNNELS: TunnelRule[] = [
  {
    // Line 1: in the open from the Clanton Park portal (south of Sheppard West) along the Allen Road
    // (Wilson at grade, over Highway 401 to Yorkdale, Lawrence West and Glencairn in the median) to the
    // portal just north of Eglinton Avenue; and on the Yonge side through the open cuts at Rosedale and Davisville.
    lines: ['l1'],
    base: 'tunnel',
    links: [
      { from: 'sheppard west', to: 'wilson', surface: [[0.3, 1]] },
      { from: 'wilson', to: 'yorkdale', surface: [[0, 1]] },
      { from: 'yorkdale', to: 'lawrence west', surface: [[0, 1]] },
      { from: 'lawrence west', to: 'glencairn', surface: [[0, 1]] },
      { from: 'glencairn', to: 'cedarvale', surface: [[0, 0.6]] },
      { from: 'bloor yonge', to: 'rosedale', surface: [[0.6, 1]] },
      { from: 'rosedale', to: 'summerhill', surface: [[0, 0.55]] },
      { from: 'st clair', to: 'davisville', surface: [[0.5, 1]] },
      { from: 'davisville', to: 'eglinton', surface: [[0, 0.85]] },
    ],
  },
  {
    // Line 2: Kipling at grade, the Humber crossing at Old Mill, the Prince Edward Viaduct over the Don,
    // and the open section from the Thyra portal past Victoria Park and Warden to the Chestnut portal.
    lines: ['l2'],
    base: 'tunnel',
    links: [
      { from: 'kipling', to: 'islington', surface: [[0, 0.4]] },
      { from: 'royal york', to: 'old mill', surface: [[0.85, 1]] },
      { from: 'old mill', to: 'jane', surface: [[0, 0.45]] },
      { from: 'castle frank', to: 'broadview', surface: [[0.18, 0.66]] },
      { from: 'main street', to: 'victoria park', surface: [[0.62, 1]] },
      { from: 'victoria park', to: 'warden', surface: [[0, 1]] },
      { from: 'warden', to: 'kennedy', surface: [[0, 0.55]] },
    ],
  },
  // Line 4 Sheppard is underground all the way
  { lines: ['l4'], base: 'tunnel', links: [] },
  {
    // Line 5: tunnel from east of Mount Dennis (after the bridge over Black Creek Drive) to the Brentcliffe
    // portal east of Laird; again under Don Mills Road at Don Valley; and into Kennedy. The rest runs at grade.
    lines: ['l5'],
    base: 'surface',
    links: [
      { from: 'mount dennis', to: 'keelesdale', tunnel: [[0.55, 1]] },
      { from: 'keelesdale', to: 'caledonia', tunnel: [[0, 1]] },
      { from: 'caledonia', to: 'fairbank', tunnel: [[0, 1]] },
      { from: 'fairbank', to: 'oakwood', tunnel: [[0, 1]] },
      { from: 'oakwood', to: 'cedarvale', tunnel: [[0, 1]] },
      { from: 'cedarvale', to: 'forest hill', tunnel: [[0, 1]] },
      { from: 'forest hill', to: 'chaplin', tunnel: [[0, 1]] },
      { from: 'chaplin', to: 'avenue', tunnel: [[0, 1]] },
      { from: 'avenue', to: 'eglinton', tunnel: [[0, 1]] },
      { from: 'eglinton', to: 'mount pleasant', tunnel: [[0, 1]] },
      { from: 'mount pleasant', to: 'leaside', tunnel: [[0, 1]] },
      { from: 'leaside', to: 'laird', tunnel: [[0, 1]] },
      { from: 'laird', to: 'sunnybrook park', tunnel: [[0, 0.45]] },
      { from: 'sunnybrook park', to: 'don valley', tunnel: [[0.7, 1]] },
      { from: 'don valley', to: 'aga khan park museum', tunnel: [[0, 0.45]] },
      { from: 'ionview', to: 'kennedy', tunnel: [[0.55, 1]] },
    ],
  },
  {
    // Line 6: underground at Finch West and in the tunnel under Keele Street, then at grade
    lines: ['l6'],
    base: 'surface',
    links: [{ from: 'finch west', to: 'sentinel', tunnel: [[0, 0.5]] }],
  },
  {
    // the streetcar tunnel from Union Station under Bay Street to Queens Quay (509, 510 and night 310)
    lines: ['s509', 's510', 's310'],
    base: 'surface',
    links: [
      { from: 'union station', to: 'queens quay ferry docks', tunnel: [[0, 1]] },
      { from: 'queens quay ferry docks', to: 'queens quay west at harbourfront centre', tunnel: [[0, 0.5]] },
    ],
  },
  {
    // the 510 ramps down from Spadina Avenue into Spadina station's underground loop
    lines: ['s510', 's310'],
    base: 'surface',
    links: [{ from: 'spadina ave at sussex ave', to: 'spadina', tunnel: [[0.55, 1]] }],
  },
];

/**
 * Side-by-side offsets (in line widths) for routes that share track: the GO lines, UP Express and VIA
 * run together into Union Station, so each keeps its own lane in the bundle.
 */
export const LINE_OFFSET: Record<string, number> = {
  'go-lw': -3,
  'go-mi': -2,
  'go-ki': -1,
  up: -0.2,
  'go-br': 0.6,
  'go-rh': 1.4,
  'go-st': 2.2,
  'go-le': 3,
  via: 4,
};

/** Seconds a train is shown waiting on the platform before its first departure, and after arriving */
export const PRE_SHOW = 90;
export const ARR_DWELL = 40;
