import { AnimatePresence, motion } from 'motion/react';
import { useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { StyleMode } from '../config';
import type { Engine, ServiceProfile, Snapshot } from '../engine';
import { Ink } from './Ink';
import { press, snappy } from './presets';
import { PauseIcon, PlayIcon } from './Roundel';

const SPEEDS = [1, 10, 60];
const STYLES: { id: StyleMode; label: string }[] = [
  { id: 'auto', label: 'Day and night' },
  { id: 'light', label: 'Street map' },
  { id: 'gray', label: 'Light map' },
  { id: 'dark', label: 'Dark map' },
];
const hhmm = (sec: number) => {
  const m = Math.round(sec / 60);
  return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

/** the deck along the bottom: playback, the service-day timeline, and the view controls */
export function Toolbar({ snap, engine }: { snap: Snapshot; engine: Engine }) {
  return (
    <footer className="deck" role="toolbar" aria-label="Time and view">
      <div className="deck-play">
        <motion.button type="button" className="icon-btn" title={snap.paused ? 'Play (Space)' : 'Pause (Space)'} aria-label={snap.paused ? 'Play' : 'Pause'} onClick={() => engine.togglePause()} {...press}>
          {/* the play and pause symbols swap with a quick turn */}
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span
              key={snap.paused ? 'play' : 'pause'}
              className="icon-swap"
              initial={{ opacity: 0, scale: 0.4, rotate: -90 }}
              animate={{ opacity: 1, scale: 1, rotate: 0, transition: snappy }}
              exit={{ opacity: 0, scale: 0.4, rotate: 90, transition: { duration: 0.12 } }}
            >
              {snap.paused ? <PlayIcon /> : <PauseIcon />}
            </motion.span>
          </AnimatePresence>
        </motion.button>
        <motion.button type="button" className={snap.live ? 'now on' : 'now'} title="Back to the real time (N)" onClick={() => engine.goLive()} {...press}>
          {snap.live ? (
            'Live'
          ) : (
            <>
              <span className="full">Back to now</span>
              <span className="short">Now</span>
            </>
          )}
        </motion.button>
        <div className="seg" role="group" aria-label="Playback speed">
          {SPEEDS.map((s) => {
            const on = !snap.paused && snap.speed === s;
            return (
              <button key={s} type="button" aria-pressed={on} title={`${s}× speed`} onClick={() => engine.setSpeed(s)}>
                {on && <Ink id="speed-ink" className="seg-ink" />}
                <span className="tab-label">{s}×</span>
              </button>
            );
          })}
        </div>
      </div>
      <Ribbon snap={snap} engine={engine} />
      <div className="deck-view">
        <div className="seg" role="group" aria-label="View">
          <button type="button" title="Subway and LRT (C)" onClick={() => engine.view('city')}>
            City
          </button>
          <button type="button" title="The whole GO network (O)" onClick={() => engine.view('network')}>
            Region
          </button>
          <button type="button" title="Around Union Station (D)" onClick={() => engine.view('downtown')}>
            Downtown
          </button>
          <button type="button" title="Tilt between flat and 3D (T)" onClick={() => engine.view('tilt')}>
            {snap.pitched ? 'Flat' : '3D'}
          </button>
        </div>
        <select className="style-pick" value={snap.styleMode} onChange={(e) => engine.setStyleMode(e.target.value as StyleMode)} aria-label="Map style">
          {STYLES.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
        <motion.button type="button" className="primary" title="Follow a random train (R)" onClick={() => engine.followRandom()} {...press}>
          <span className="full">Follow a train</span>
          <span className="short">Follow</span>
        </motion.button>
      </div>
    </footer>
  );
}

const W = 1000;
const H = 44;

/** stacked areas of trains in service by mode across the service day, built once per day */
function areas(p: ServiceProfile) {
  const n = p.bins.length;
  const x = (i: number) => ((i + 0.5) / n) * W;
  const y = (v: number) => H - (v / p.max) * (H - 3);
  const base = new Array<number>(n).fill(0);
  return p.groups.map((g, gi) => {
    const lo = base.slice();
    for (let i = 0; i < n; i++) base[i] += p.bins[i][gi];
    let d = `M0 ${y(lo[0]).toFixed(1)} L0 ${y(base[0]).toFixed(1)}`;
    for (let i = 0; i < n; i++) d += ` L${x(i).toFixed(1)} ${y(base[i]).toFixed(1)}`;
    d += ` L${W} ${y(base[n - 1]).toFixed(1)} L${W} ${y(lo[n - 1]).toFixed(1)}`;
    for (let i = n - 1; i >= 0; i--) d += ` L${x(i).toFixed(1)} ${y(lo[i]).toFixed(1)}`;
    return { id: g.id, color: g.color, d: `${d} Z` };
  });
}

/** the timeline: trains in service through the day; drag or click to move the clock */
function Ribbon({ snap, engine }: { snap: Snapshot; engine: Engine }) {
  const p = snap.profile;
  const paths = useMemo(() => areas(p), [p]);
  const span = p.step * p.bins.length;
  const box = useRef<HTMLDivElement>(null);
  // a press that does not move is a click (the trains race to the new time); a press that moves is a drag
  const pressing = useRef<{ x: number; moved: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);
  const at = Math.min(1, Math.max(0, (snap.scrub - p.from) / span));
  const toTime = (clientX: number, glide: boolean) => {
    const r = box.current!.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    engine.setTimeOfDay(Math.round((p.from + f * span) / 60) * 60, glide);
  };
  const down = (e: PointerEvent<HTMLDivElement>) => {
    pressing.current = { x: e.clientX, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const pr = pressing.current;
    if (!pr) return;
    if (!pr.moved && Math.abs(e.clientX - pr.x) < 4) return;
    if (!pr.moved) setDragging(true);
    pr.moved = true;
    toTime(e.clientX, false);
  };
  const up = (e: PointerEvent<HTMLDivElement>) => {
    const pr = pressing.current;
    pressing.current = null;
    setDragging(false);
    if (pr && !pr.moved) toTime(e.clientX, true);
  };
  const cancel = () => {
    pressing.current = null;
    setDragging(false);
  };
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 3600 : 600;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') engine.shift(-step);
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') engine.shift(step);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  const ticks = [5, 8, 11, 14, 17, 20, 23, 26];
  return (
    <div className="ribbon">
      <div className="ribbon-cap">
        <span className={snap.special ? 'special' : undefined}>{snap.service}</span>
        <span>{snap.date}</span>
      </div>
      <div
        ref={box}
        className="ribbon-chart"
        role="slider"
        tabIndex={0}
        aria-label="Time of day"
        aria-valuemin={p.from}
        aria-valuemax={p.from + span}
        aria-valuenow={snap.scrub}
        aria-valuetext={hhmm(snap.scrub)}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={cancel}
        onKeyDown={key}
        title="Trains in service through the day: click or drag to change the time"
      >
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
          {paths.map((a) => (
            <path key={a.id} d={a.d} fill={a.color} />
          ))}
        </svg>
        <div className="ticks" aria-hidden="true">
          {ticks.map((h) => (
            <span key={h} style={{ left: `${(((h * 3600 - p.from) / span) * 100).toFixed(2)}%` }}>
              {String(h % 24).padStart(2, '0')}
            </span>
          ))}
        </div>
        {/* the playhead glides between the four-a-second updates, and follows the pointer exactly while dragging */}
        <motion.div
          className={at > 0.9 ? 'playhead flip' : 'playhead'}
          initial={false}
          animate={{ left: `${(at * 100).toFixed(2)}%` }}
          transition={dragging ? { duration: 0 } : { duration: 0.26, ease: 'linear' }}
          aria-hidden="true"
        >
          <b className="tab">{hhmm(snap.scrub)}</b>
        </motion.div>
      </div>
    </div>
  );
}
