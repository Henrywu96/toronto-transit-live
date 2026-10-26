import { useState, type CSSProperties, type FormEvent } from 'react';
import type { Engine, Snapshot } from '../engine';
import { Rolling } from './Rolling';
import { MenuIcon, SearchIcon } from './Roundel';

/** the sign band across the top: name, trains running per mode, station search, clock */
export function TopBar({
  snap,
  engine,
  panelOpen,
  onTogglePanel,
  helpOpen,
  onToggleHelp,
}: {
  snap: Snapshot;
  engine: Engine;
  panelOpen: boolean;
  onTogglePanel: () => void;
  helpOpen: boolean;
  onToggleHelp: () => void;
}) {
  const [q, setQ] = useState('');
  const state = snap.live ? 'Live' : snap.paused ? 'Paused' : snap.speed === 1 ? 'Replay' : `${snap.speed}× speed`;
  const onSearch = (e: FormEvent) => {
    e.preventDefault();
    const s = q.trim().toLowerCase();
    if (!s) return;
    const hit = snap.stations.find((st) => st.name.toLowerCase() === s) ?? snap.stations.find((st) => st.name.toLowerCase().includes(s));
    if (hit) {
      engine.selectStation(hit.idx, true);
      setQ('');
      (document.activeElement as HTMLElement | null)?.blur();
    } else engine.say(`No station is called “${q.trim()}”`);
  };
  return (
    <header className="band">
      <button type="button" className="band-btn" aria-pressed={panelOpen} aria-label="Lines and trains" title="Lines and trains" onClick={onTogglePanel}>
        <MenuIcon />
      </button>
      <div className="brand">
        <span className="mark" aria-hidden="true">
          TO
        </span>
        <span className="brand-name">Toronto Transit Live</span>
      </div>
      <ul className="counts" aria-label="Trains on the map now">
        <li className="total">
          <Rolling className="tab" value={snap.total} from={0} />
          <span>trains</span>
        </li>
        {snap.groups.map((g) => (
          <li key={g.id} className={g.hidden ? 'off' : undefined} title={`${g.label}: ${g.count} on the map`}>
            <i style={{ '--c': g.color } as CSSProperties} />
            <span className="kl-long">{g.label}</span>
            <span className="kl-short">{g.short}</span>
            <Rolling className="tab" value={g.count} from={0} />
          </li>
        ))}
      </ul>
      <form className="search" role="search" onSubmit={onSearch}>
        <SearchIcon />
        <input value={q} onChange={(e) => setQ(e.target.value)} list="station-list" placeholder="Find a station" autoComplete="off" aria-label="Find a station" />
        <datalist id="station-list">
          {snap.stations.map((s) => (
            <option key={s.idx} value={s.name} />
          ))}
        </datalist>
      </form>
      <div className="clock" title={snap.date}>
        <time className="tab">{snap.clock}</time>
        <span className={snap.live ? 'state live' : 'state'}>{state}</span>
      </div>
      <button type="button" className="band-btn help-btn" aria-pressed={helpOpen} aria-label="How to read the map" title="How to read the map" onClick={onToggleHelp}>
        ?
      </button>
    </header>
  );
}
