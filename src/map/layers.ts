import type { ExpressionSpecification, FilterSpecification, Map as MlMap, StyleSpecification } from 'maplibre-gl';
import { GLYPHS } from '../config';
import type { Network } from '../lib/network';

/** OpenFreeMap styles without buildings: a clean street map */
export function withoutBuildings(style: StyleSpecification): StyleSpecification {
  return {
    ...style,
    layers: style.layers.filter((l) => !('source-layer' in l && l['source-layer'] === 'building')),
  };
}

/** an empty map (background only), for offline use: ?basemap=none */
export function blankStyle(): StyleSpecification {
  return {
    version: 8,
    glyphs: GLYPHS,
    sources: {},
    layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#eef0ec' } }],
  };
}

/** the font stack the basemap already uses for labels, in bold when it has one */
function labelFont(map: MlMap): string[] {
  for (const l of map.getStyle().layers) {
    if (l.type !== 'symbol') continue;
    const f = l.layout?.['text-font'];
    if (Array.isArray(f) && f.every((x) => typeof x === 'string')) return (f as string[]).map((x) => x.replace(/Regular|Italic/, 'Bold'));
  }
  return ['Noto Sans Bold'];
}

/** line width by zoom, scaled per line group (streetcars and regional rail are drawn thinner than the subway) */
const groupScale: ExpressionSpecification = ['match', ['get', 'group'], 'streetcar', 0.55, 'go', 0.72, 'via', 0.6, 'airport', 0.8, 'lrt', 0.9, 1];
const zoomed = (a: number, b: number, c: number, d: number): ExpressionSpecification => [
  'interpolate',
  ['exponential', 1.5],
  ['zoom'],
  9,
  ['*', groupScale, a],
  12,
  ['*', groupScale, b],
  15,
  ['*', groupScale, c],
  18,
  ['*', groupScale, d],
];
/** side-by-side lanes for lines sharing track: spread out when zoomed out, back onto the real track close up */
const offset = (a: number, b: number, c: number, d: number): ExpressionSpecification => [
  'interpolate',
  ['linear'],
  ['zoom'],
  9,
  ['*', ['get', 'off'], a],
  12,
  ['*', ['get', 'off'], b],
  14.5,
  ['*', ['get', 'off'], c],
  17,
  ['*', ['get', 'off'], d],
];

export const ROUTE_LAYERS = ['tt-casing', 'tt-line', 'tt-line-ug'] as const;
export const STATION_LAYERS = ['tt-stations', 'tt-stops'] as const;

export function routeFilter(id: (typeof ROUTE_LAYERS)[number], hidden: string[]): FilterSpecification {
  const visible: ExpressionSpecification = ['!', ['in', ['get', 'line'], ['literal', hidden]]];
  const ug: ExpressionSpecification = id === 'tt-line-ug' ? ['==', ['get', 'ug'], true] : ['==', ['get', 'ug'], false];
  return ['all', visible, ug];
}

/** route lines under the basemap's labels, stations on top; the train layer goes between the two */
export function addNetworkLayers(map: MlMap, net: Network, opts: { dark: boolean; hidden: string[] }) {
  // under the basemap's text labels (one-way arrows and other icon-only symbols do not count)
  const firstSymbol = map.getStyle().layers.find((l) => l.type === 'symbol' && l.layout?.['text-field'] !== undefined)?.id;
  map.addSource('tt-routes', { type: 'geojson', data: net.routeGeoJSON() });
  map.addSource('tt-stations', { type: 'geojson', data: net.stationGeoJSON() });
  const off = offset(1.4, 2.3, 2.6, 0.6);
  // streetcars under the subway, regional rail under everything (drawn first)
  const sortKey: ExpressionSpecification = ['get', 'z'];
  map.addLayer(
    {
      id: 'tt-casing',
      type: 'line',
      source: 'tt-routes',
      filter: routeFilter('tt-casing', opts.hidden),
      layout: { 'line-join': 'round', 'line-cap': 'round', 'line-sort-key': sortKey },
      paint: { 'line-color': opts.dark ? '#0b1320' : '#ffffff', 'line-width': zoomed(3.4, 5.6, 10, 18), 'line-offset': off },
    },
    firstSymbol,
  );
  map.addLayer(
    {
      id: 'tt-line',
      type: 'line',
      source: 'tt-routes',
      filter: routeFilter('tt-line', opts.hidden),
      layout: { 'line-join': 'round', 'line-cap': 'round', 'line-sort-key': sortKey },
      paint: { 'line-color': ['get', 'color'], 'line-width': zoomed(2, 3.4, 6.6, 12), 'line-offset': off },
    },
    firstSymbol,
  );
  map.addLayer(
    {
      id: 'tt-line-ug',
      type: 'line',
      source: 'tt-routes',
      filter: routeFilter('tt-line-ug', opts.hidden),
      layout: { 'line-join': 'round', 'line-sort-key': sortKey },
      paint: { 'line-color': ['get', 'color'], 'line-width': zoomed(1.8, 3, 5.6, 10), 'line-dasharray': [1.3, 1], 'line-opacity': 0.85, 'line-offset': off },
    },
    firstSymbol,
  );
  const big = ['>', ['get', 'n'], 1] as ExpressionSpecification;
  map.addLayer({
    id: 'tt-stops',
    type: 'circle',
    source: 'tt-stations',
    minzoom: 12.6,
    filter: ['==', ['get', 'stop'], true],
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 12.6, 1.8, 15, 3.6, 18, 6],
      'circle-color': opts.dark ? '#0f1826' : '#ffffff',
      'circle-stroke-color': ['get', 'color'],
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 12.6, 1, 16, 2],
    },
  });
  map.addLayer({
    id: 'tt-stations',
    type: 'circle',
    source: 'tt-stations',
    filter: ['==', ['get', 'stop'], false],
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, ['case', big, 2.4, 1.6], 13, ['case', big, 6, 4.6], 17, ['case', big, 10, 8]],
      'circle-color': opts.dark ? '#0f1826' : '#ffffff',
      'circle-stroke-color': ['get', 'color'],
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 8, 1, 14, 2.6],
    },
  });
  // ripples sent out from a station when it is picked (animated by the engine)
  map.addLayer({
    id: 'tt-station-ripple',
    type: 'circle',
    source: 'tt-stations',
    filter: ['in', ['get', 'idx'], ['literal', []]],
    paint: {
      'circle-radius': 10,
      'circle-color': 'rgba(0,0,0,0)',
      'circle-stroke-color': opts.dark ? '#ffffff' : '#000000',
      'circle-stroke-width': 2,
      'circle-stroke-opacity': 0,
    },
  });
  map.addLayer({
    id: 'tt-station-sel',
    type: 'circle',
    source: 'tt-stations',
    filter: ['in', ['get', 'idx'], ['literal', []]],
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 7, 13, 11, 17, 16],
      'circle-color': 'rgba(0,0,0,0)',
      'circle-stroke-color': opts.dark ? '#ffffff' : '#000000',
      'circle-stroke-width': 2.5,
    },
  });
}

/** station names: added after the train layer so they sit on top of everything; streetcar stops only close up */
export function addStationLabels(map: MlMap, dark: boolean) {
  const name = ['get', 'name'] as ExpressionSpecification;
  const rank = ['get', 'rank'] as ExpressionSpecification;
  map.addLayer({
    id: 'tt-station-labels',
    type: 'symbol',
    source: 'tt-stations',
    minzoom: 10.2,
    layout: {
      'text-field': ['step', ['zoom'], ['case', ['==', rank, 0], name, ''], 11.6, ['case', ['<=', rank, 2], name, ''], 15.4, name],
      'text-font': labelFont(map),
      'text-size': ['interpolate', ['linear'], ['zoom'], 10.2, ['case', ['==', rank, 3], 9, 10.5], 15, ['case', ['==', rank, 3], 11, 13.5]],
      'text-variable-anchor': ['left', 'right', 'top', 'bottom'],
      'text-radial-offset': 0.9,
      'text-justify': 'auto',
      'text-padding': 4,
      'symbol-sort-key': rank,
    },
    paint: {
      'text-color': dark ? '#e6edf5' : '#1d2633',
      'text-halo-color': dark ? '#0b1320' : '#ffffff',
      'text-halo-width': 1.6,
    },
  });
}
