import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { BasemapKey } from './config';
import { Engine } from './engine';
import { intro } from './lib/motion';
import { useStore } from './lib/store';
import type { TransitData } from './types';
import { Inspector } from './components/Inspector';
import { LinePanel, type PanelTab, type TrainFilter } from './components/LinePanel';
import { noticeMotion, press, toastMotion } from './components/presets';
import { Toolbar } from './components/Toolbar';
import { TopBar } from './components/TopBar';
import { useShortcuts } from './components/useShortcuts';

const BASEMAP_PARAM: BasemapKey[] = ['light', 'gray', 'dark', 'none'];

export default function App() {
  const [engine, setEngine] = useState<Engine | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const url = `${import.meta.env.BASE_URL}data/transit.json`;
    fetch(url, { cache: 'no-cache' })
      .then((r) => {
        if (!r.ok) throw new Error(`Could not load ${url} (HTTP ${r.status}).`);
        return r.json() as Promise<TransitData>;
      })
      .then((data) => {
        if (!alive) return;
        if (!data.trips?.length) throw new Error('The timetable file has no trips.');
        const q = new URLSearchParams(window.location.search);
        const bm = q.get('basemap') as BasemapKey | null;
        setEngine(
          new Engine(data, {
            at: Engine.parseAt(q.get('at'), data.timezone),
            speed: Number(q.get('speed')) || undefined,
            basemap: bm && BASEMAP_PARAM.includes(bm) ? bm : null,
          }),
        );
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, []);

  if (error)
    return (
      <div className="splash">
        <div className="splash-card">
          <span className="mark" aria-hidden="true">
            TO
          </span>
          <h1>The timetable did not load</h1>
          <p>{error}</p>
          <p className="muted">
            Build it with <code>npm run data</code>, which reads the TTC, GO Transit, UP Express and VIA Rail feeds. GitHub Actions does this on every deploy.
          </p>
        </div>
      </div>
    );
  if (!engine)
    return (
      <div className="splash">
        <div className="splash-card">
          <span className="mark loading" aria-hidden="true">
            TO
          </span>
          <h1>Loading the timetable</h1>
        </div>
      </div>
    );
  return <Main engine={engine} />;
}

function Main({ engine }: { engine: Engine }) {
  const snap = useStore(engine.store);
  const mapEl = useRef<HTMLDivElement>(null);
  const appEl = useRef<HTMLDivElement>(null);
  const [panelOpen, setPanelOpen] = useState(() => window.innerWidth >= 760);
  const [helpOpen, setHelpOpen] = useState(false);
  // kept here, not in the panel, so they survive the panel closing and opening again
  const [tab, setTab] = useState<PanelTab>('lines');
  const [filter, setFilter] = useState<TrainFilter>('all');

  useEffect(() => engine.mount(mapEl.current!), [engine]);
  // the entrance, once the timetable is in
  useLayoutEffect(() => {
    if (appEl.current) intro(appEl.current);
  }, []);
  useEffect(() => {
    // handy in the browser console while developing: __tt.clock, __tt.map, __tt.sched …
    if (import.meta.env.DEV) (window as unknown as { __tt?: Engine }).__tt = engine;
  }, [engine]);
  // the panels follow the map: dark at night (or with the dark map), light otherwise
  useEffect(() => {
    document.documentElement.dataset.theme = snap.dark ? 'dark' : 'light';
  }, [snap.dark]);
  useShortcuts(engine);

  return (
    // Motion follows the system's reduce-motion setting, like the anime.js side does
    <MotionConfig reducedMotion="user">
    <div className="app" ref={appEl}>
      <div ref={mapEl} className="map" aria-label="Map of Toronto with the trains moving on it" />
      <TopBar
        snap={snap}
        engine={engine}
        panelOpen={panelOpen}
        onTogglePanel={() => setPanelOpen((o) => !o)}
        helpOpen={helpOpen && !snap.detail}
        onToggleHelp={() => {
          if (snap.detail) engine.clearSelection();
          setHelpOpen((o) => !o || !!snap.detail);
        }}
      />
      <AnimatePresence>
        {panelOpen && (
          <LinePanel
            key="side"
            snap={snap}
            engine={engine}
            tab={tab}
            onTab={setTab}
            filter={filter}
            onFilter={setFilter}
            onPick={() => window.innerWidth < 760 && setPanelOpen(false)}
          />
        )}
      </AnimatePresence>
      <Inspector snap={snap} engine={engine} helpOpen={helpOpen} onCloseHelp={() => setHelpOpen(false)} />
      <AnimatePresence>
        {snap.ready && snap.total === 0 && snap.detail === null && (
          <motion.div className="quiet" role="status" key="quiet" {...noticeMotion}>
            <b>No trains are running right now</b>
            <p>{snap.nextService ? `The first trains leave around ${snap.nextService}.` : 'The subway runs from about 6 am until about 1:30 am, Toronto time.'}</p>
            <div>
              <motion.button type="button" onClick={() => engine.setTimeOfDay(8 * 3600, true)} {...press}>
                Show 8:00 am
              </motion.button>
              <motion.button type="button" onClick={() => engine.setTimeOfDay(17 * 3600, true)} {...press}>
                Show 5:00 pm
              </motion.button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <Toolbar snap={snap} engine={engine} />
      <AnimatePresence>
        {snap.toast && (
          <motion.div className="toast" role="status" key={snap.toast.id} {...toastMotion}>
            {snap.toast.text}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
    </MotionConfig>
  );
}
