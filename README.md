# Toronto Transit Live

© 2026 Henry Wu. All rights reserved.

Every scheduled train in the Toronto area moving on a real street map as a little 3D model, in Toronto time:

- **TTC subway** — Line 1 Yonge–University, Line 2 Bloor–Danforth, Line 4 Sheppard
- **TTC light rail** — Line 5 Eglinton, Line 6 Finch West
- **TTC streetcars** — the 500-series routes and the Blue Night 300-series
- **GO Transit** — Lakeshore West, Milton, Kitchener, Barrie, Richmond Hill, Stouffville, Lakeshore East
- **UP Express** — Union ↔ Pearson Airport
- **VIA Rail** — intercity trains, shown for the part of their run inside the region
- **Terminal Link** — the people mover between Pearson's Terminal 1, Terminal 3 and Viscount

Click a train to see where it is going and its stops, or a station for its next departures.

Built on the same framework as Edmonton LRT Live: **Vite + React + TypeScript**, a **MapLibre GL** map, and the
trains drawn by **three.js** inside the map. The timetables come from the operators' **GTFS feeds**, which every
Vercel build downloads and compacts; a GitHub Action has Vercel rebuild once a day.

> Train positions are worked out from the published timetables, not from GPS. They show where each train is
> scheduled to be, so a delayed train will not appear late here.

## How it works

```
TTC, GO Transit, UP Express, VIA Rail GTFS feeds (zips, all buses and trains)
        │  scripts/build-gtfs.mjs  (on every Vercel build, daily)
        ▼
public/data/transit.json  (about 1 MB, ~250 KB gzipped: lines, stations, track shapes, every train trip, calendars)
        │  fetched once by the browser
        ▼
src/lib/schedule.ts   which trips run today → trains (GTFS blocks) → where each train is at time t
        │  every animation frame
        ▼
src/map/TrainLayer.ts three.js custom layer inside MapLibre: instanced toy trains, one draw call per part
src/components/*      React UI: clock, counts per mode, line and train lists, train card, station departure board
```

What the timetable builder does with the four feeds:

- keeps only trains: TTC route types subway and tram (and drops the streetcar-replacement buses the TTC lists under
  the streetcar routes), GO and VIA rail routes (no buses, no VIA Air Connect shuttle), and UP Express;
- folds GO and UP's one-trip-per-date listings (11 000 and 28 000 dated trips) into one trip per train with a
  calendar of its dates;
- cuts each VIA run down to the stretch inside the region (Stratford/Woodstock – Niagara Falls – Oshawa – Barrie),
  ending it at the edge of the map where the train carries on to Montréal, Ottawa, London or Vancouver;
- merges each place into one station across feeds: TTC and GO at Union, Kipling, Kennedy, Mount Dennis and
  Downsview Park; the two halves of Bloor-Yonge; VIA stops at GO stations ("Oshawa" / "Durham College Oshawa GO");
  UP's Pearson stop and the Terminal Link at Terminal 1; streetcar loops inside subway stations;
- adds a timetable for the Terminal Link (Pearson publishes no GTFS): two independent shuttles, about four minutes
  end to end, every four minutes, 24 hours a day, one train at quiet times.

Each feed's calendar is looked up on its own: when a date is past the end of one feed (the TTC publishes about a
month at a time), that feed borrows the same weekday from its nearest covered week and the app says so.

### Tunnels

GTFS has no tunnel information, so `src/config.ts` lists which parts of each line are underground, link by link
between stations. Tunnelled track is drawn dashed and trains in tunnel are see-through.

| Line | In the open | Underground |
| --- | --- | --- |
| 1 Yonge–University | Clanton Park portal south of Sheppard West → Wilson (at grade) → over Highway 401 → Yorkdale, Lawrence West, Glencairn (Allen Road median) → portal north of Eglinton West; open cuts around Rosedale (Ellis–Price portals) and Davisville (Muir–Berwick portals) | everything else, VMC → Sheppard West, Cedarvale → Bloor-Yonge, Summerhill → St Clair, Eglinton → Finch |
| 2 Bloor–Danforth | Kipling; Old Mill and the Humber crossing; the Prince Edward Viaduct (lower deck) between Castle Frank and Broadview; Thyra portal → Victoria Park → Warden → Chestnut portal | Islington → Royal York, Jane → Castle Frank, Broadview → Main Street, Kennedy |
| 4 Sheppard | — | all of it |
| 5 Eglinton | Mount Dennis (over Black Creek Drive); Brentcliffe portal → Sunnybrook Park and the Don valley bridge; east of Don Valley → Ionview at grade | Keelesdale → Laird, Don Valley station, Kennedy |
| 6 Finch West | Sentinel → Humber College at grade | Finch West and the tunnel under Keele Street |
| 509 / 510 streetcars | — | Union → Queens Quay/Ferry Docks tunnel, the ramp into Spadina station |
| GO, UP, VIA, Terminal Link | all of it (UP's airport spur and the Terminal Link are elevated) | — |

Portal positions are approximate fractions of the distance between stations.

Details worth knowing:

- **Smooth motion.** Between stops each train follows an S-shaped speed curve (gentle start, cruise, gentle
  stop), track geometry is resampled into an even table, and the clock advances by the real frame time. All
  positions are computed in double precision relative to the middle of the city, so trains do not jitter.
- **Trains as vehicles.** Trips are linked into trains using GTFS `block_id`. GO trains run through Union from
  one line onto another, so a train's name and colour follow the trip it is on. GO and VIA trains lead with the
  cab car towards Union and with the locomotive away from it.
- **Readable at any zoom.** Trains are true scale when you zoom in and become small tokens when you zoom out, so
  the network stays legible with several hundred trains on the map.
- **Day / night.** In *Auto* the map switches to the dark style between dusk and dawn in Toronto, and the panels
  follow it.
- **Motion** (Motion for React and anime.js). [Motion](https://motion.dev) handles the interface: the side panel
  and the cards spring in and out (a new train's card waits for the old one to leave), the highlight slides between
  tabs, filters and speeds, the play and pause symbols swap with a turn, the playhead glides along the timeline,
  and buttons give a little when pressed. [anime.js](https://animejs.com) (`src/lib/motion.ts`) handles the rest:
  moving the clock — clicking the timeline, ←/→, *Back to now* — lets the trains race to the new time instead of
  jumping; counts roll to their new values; a card's stops and departures come in one after another; a picked
  station sends two ripples out on the map; and one entrance plays when the timetable has loaded. Both follow the
  system's *reduce motion* setting.

## Run it on your computer

Requires Node.js 20.19+ (22 recommended).

```bash
npm install
npm run dev        # builds the timetable the first time, then starts http://localhost:5173
npm run data       # rebuild the timetable (public/data/transit.json)
npm run build      # production build into dist/
npm run preview    # serve the production build
npm run typecheck  # TypeScript check
```

`npm run data` reads the feeds from a `gtfs/` folder when there is one (each feed as a zip or an unzipped folder,
named like the downloads: `GO-GTFS`, `UP-GTFS`, `VIA-GTFS`, `TTC Routes and Schedules Data`), and otherwise
downloads them. `npm run data:download` always downloads fresh copies. Other options: `--dir <folder>`,
`--out <file>`, and the `TTC_GTFS_URL`, `GO_GTFS_URL`, `UP_GTFS_URL`, `VIA_GTFS_URL` environment variables to use
other download addresses.

If the TTC's own address fails, the builder asks the City's open data catalogue, then tries the copy the
[Mobility Database](https://mobilitydatabase.org/feeds/gtfs/mdb-732) keeps. If a feed still can't be downloaded,
a Vercel build keeps the timetable the live site is serving (`/data/transit.json` on the production domain)
instead of failing, so code changes still deploy and the next daily rebuild tries again. `FALLBACK_DATA_URL` points
it at another copy; `--no-fallback` makes it fail instead.

### URL parameters

| Parameter | Example | Effect |
| --- | --- | --- |
| `at` | `?at=2026-10-26T08:15` | start at a given Toronto date and time instead of now |
| `speed` | `?speed=60` | start playing faster (1, 10, 60 …) |
| `basemap` | `?basemap=dark` | force a map style: `light`, `gray`, `dark`, or `none` (no tiles, works offline) |

Keyboard: <kbd>Space</kbd> pause · <kbd>N</kbd> back to now · <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> speed ·
<kbd>←</kbd> <kbd>→</kbd> ±10 min · <kbd>R</kbd> follow a random train · <kbd>F</kbd> follow the selected
train · <kbd>C</kbd> city · <kbd>O</kbd> whole region · <kbd>D</kbd> downtown · <kbd>T</kbd> 2D/3D · <kbd>Esc</kbd> close.

## Project layout

```
.github/workflows/deploy.yml   asks Vercel to rebuild once a day (fresh timetables)
vercel.json                    Vercel build: download the feeds, build the timetable, build the site
scripts/build-gtfs.mjs         four GTFS feeds + Terminal Link → public/data/transit.json
src/
  App.tsx, main.tsx            React entry: loads the timetable, lays out the HUD
  engine.ts                    owns map, clock, timetable and train layer; runs the frame loop
  config.ts                    map styles, line groups, tunnel sections, route offsets, timings
  lib/schedule.ts              service calendars per feed, trains from trips, train state at any time
  lib/network.ts               lines, stations, track geometry, tunnels, route lines for the map
  lib/geo.ts                   local metric frame matching MapLibre's Mercator, resampled paths
  lib/time.ts, clock.ts, sun.ts  Toronto time, simulation clock, sunrise/sunset
  lib/motion.ts                anime.js animations: entrance, rolling counts, time glide, card contents
  map/TrainLayer.ts            three.js custom layer
  map/trainModels.ts           train models: Toronto Rocket, T1, Flexity Freedom, Citadis Spirit, Flexity Outlook,
                               GO bilevels, UP DMU, VIA Venture, Terminal Link
  map/TrainLabels.ts           name tags above the trains
  map/layers.ts                route, station and label layers
  components/                  TopBar, LinePanel, Inspector, Toolbar, keyboard shortcuts;
                               presets.ts and Ink.tsx hold the Motion for React settings
```

## Next step: real-time positions

The TTC, GO Transit and UP Express also publish **GTFS-Realtime** feeds (vehicle positions, trip updates). A web page
cannot read them directly (binary protobuf, some behind API keys), so they need a small proxy — for example a
Cloudflare Worker or Vercel function that fetches the feeds every 15–30 s and returns JSON. The schedule engine keeps
the GTFS trips, so delays from trip updates can be applied to the timetable positions.

## Credits

- Timetables: [TTC Routes and Schedules](https://open.toronto.ca/dataset/ttc-routes-and-schedules/) (City of Toronto
  Open Data Licence), [GO Transit and UP Express GTFS](https://www.gotransit.com/en/information-resources/software-developers)
  (Metrolinx Open Data), [VIA Rail GTFS](https://www.viarail.ca/en/developer-resources).
- Map: © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, tiles by
  [OpenFreeMap](https://openfreemap.org/) / [OpenMapTiles](https://openmaptiles.org/).
- Libraries: MapLibre GL JS (BSD-3-Clause), three.js (MIT), anime.js (MIT), Motion (MIT), React (MIT), Vite (MIT).

This is an unofficial fan project and is not affiliated with the TTC, Metrolinx, VIA Rail or the Greater Toronto
Airports Authority.

## Copyright

© 2026 Henry Wu. All rights reserved.
