import { AnimatePresence, motion } from 'motion/react';
import { useLayoutEffect, useRef, type CSSProperties, type RefObject } from 'react';
import type { Engine, Snapshot, StationDetail, TrainDetail } from '../engine';
import { enterContents } from '../lib/motion';
import { cardMotion, press } from './presets';
import { Bullet, CloseIcon } from './Roundel';

/** once a card has mounted, anime.js brings its contents in (Motion has already slid the card itself in) */
function useEnter(ref: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    if (ref.current) enterContents(ref.current);
  }, [ref]);
}

/**
 * The card on the right. Each train, station or the help is its own keyed card inside AnimatePresence:
 * the old one slides away before the new one comes in, and closing it slides it out.
 */
export function Inspector({ snap, engine, helpOpen, onCloseHelp }: { snap: Snapshot; engine: Engine; helpOpen: boolean; onCloseHelp: () => void }) {
  const d = snap.detail;
  const which = d ? (d.kind === 'train' ? `t:${d.key}` : `s:${d.idx}`) : helpOpen ? 'help' : '';
  return (
    <AnimatePresence mode="wait">
      {which && (
        <motion.aside
          key={which}
          className={d ? 'panel card' : 'panel card help'}
          aria-live={d ? 'polite' : undefined}
          aria-label={d ? undefined : 'How to read the map'}
          {...cardMotion()}
        >
          {d ? d.kind === 'train' ? <TrainCard d={d} snap={snap} engine={engine} /> : <StationCard d={d} engine={engine} /> : <Help onClose={onCloseHelp} />}
        </motion.aside>
      )}
    </AnimatePresence>
  );
}

function Help({ onClose }: { onClose: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  useEnter(root);
  return (
    <div ref={root}>
      <div className="card-top">
        <h2 className="card-title">How to read the map</h2>
        <button type="button" className="close" aria-label="Close" onClick={onClose}>
          <CloseIcon />
        </button>
      </div>
      <p className="lede">
        Every TTC subway, LRT and streetcar, GO train, UP Express, VIA train and the Pearson Terminal Link, placed from their timetables. Click a train to see where it is going, or a
        station for its next departures.
      </p>
      <ul className="legend">
        <li>
          <span className="sw-solid" /> Track in the open, on a bridge or in a cutting
        </li>
        <li>
          <span className="sw-dash" /> Track in tunnel
        </li>
        <li>
          <span className="sw-ghost" /> Train underground, drawn see-through
        </li>
        <li>
          <span className="sw-halo" /> The train you picked
        </li>
      </ul>
      <p className="lede">Trains are drawn bigger than life when you zoom out. The timeline at the bottom shows how many trains run through the day: drag it to any time.</p>
      <dl className="keys">
        <div>
          <dt>
            <kbd>Space</kbd>
          </dt>
          <dd>pause</dd>
        </div>
        <div>
          <dt>
            <kbd>N</kbd>
          </dt>
          <dd>back to now</dd>
        </div>
        <div>
          <dt>
            <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd>
          </dt>
          <dd>speed</dd>
        </div>
        <div>
          <dt>
            <kbd>←</kbd> <kbd>→</kbd>
          </dt>
          <dd>10 minutes</dd>
        </div>
        <div>
          <dt>
            <kbd>R</kbd>
          </dt>
          <dd>follow a train</dd>
        </div>
        <div>
          <dt>
            <kbd>C</kbd>
          </dt>
          <dd>city</dd>
        </div>
        <div>
          <dt>
            <kbd>O</kbd>
          </dt>
          <dd>whole region</dd>
        </div>
        <div>
          <dt>
            <kbd>D</kbd>
          </dt>
          <dd>downtown</dd>
        </div>
        <div>
          <dt>
            <kbd>T</kbd>
          </dt>
          <dd>flat or 3D</dd>
        </div>
      </dl>
    </div>
  );
}

function TrainCard({ d, snap, engine }: { d: TrainDetail; snap: Snapshot; engine: Engine }) {
  const root = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLOListElement>(null);
  // bring the train's current stop into view when a train is picked (before the entrance looks for the stops in view)
  useLayoutEffect(() => {
    const list = strip.current;
    const el = list?.querySelector<HTMLElement>('li.now, li.next');
    if (list && el) list.scrollTop = el.offsetTop - list.clientHeight / 2;
  }, [d.key]);
  useEnter(root);
  return (
    <div className="train-card" style={{ '--c': d.line.color } as CSSProperties} ref={root}>
      <div className="card-top">
        <div className="line-id">
          <Bullet color={d.line.color} short={d.line.short} />
          <span>{d.line.name}</span>
        </div>
        <button type="button" className="close" aria-label="Close" onClick={() => engine.clearSelection()}>
          <CloseIcon />
        </button>
      </div>
      <h2 className="card-title">To {d.headsign}</h2>
      <p className="status">
        <b>
          {d.status}
          {d.ug ? ', underground' : ''}
        </b>
        <span>{d.sub}</span>
      </p>
      <div className="actions">
        <motion.button type="button" aria-pressed={snap.follow} disabled={!d.visible} onClick={() => engine.setFollow(!snap.follow)} {...press}>
          {snap.follow ? 'Following' : 'Follow'}
        </motion.button>
        <motion.button type="button" disabled={!d.visible} onClick={() => engine.selectTrain(d.key, true)} {...press}>
          Zoom to train
        </motion.button>
      </div>
      <dl className="facts">
        <div>
          <dt>Train</dt>
          <dd>{d.run || d.id}</dd>
        </div>
        <div>
          <dt>Speed</dt>
          <dd className="tab">{d.speed}</dd>
        </div>
        <div className="wide">
          <dt>Cars</dt>
          <dd>{d.stock}</dd>
        </div>
        <div className="wide">
          <dt>After this trip</dt>
          <dd>{d.next ?? 'Nothing more today'}</dd>
        </div>
      </dl>
      {d.stops.length > 0 && (
        <ol className="strip" ref={strip}>
          {d.stops.map((s, i) => (
            <li key={i} className={s.state}>
              <span className="nm">{s.name}</span>
              <time className="tab">{s.time}</time>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function StationCard({ d, engine }: { d: StationDetail; engine: Engine }) {
  const root = useRef<HTMLDivElement>(null);
  useEnter(root);
  const main = d.lines[0]?.color ?? '#888888';
  return (
    <div className="station-card" ref={root}>
      <div className="wall" style={{ '--c': main } as CSSProperties}>
        <div className="trim" aria-hidden="true">
          {d.lines.slice(0, 8).map((l) => (
            <i key={l.id} style={{ '--c': l.color } as CSSProperties} />
          ))}
        </div>
        <button type="button" className="close" aria-label="Close" onClick={() => engine.clearSelection()}>
          <CloseIcon />
        </button>
        <h2 className="wall-name">{d.name}</h2>
        <div className="wall-lines">
          <span>{d.stop ? 'Streetcar stop' : 'Station'}</span>
          {d.lines.map((l) => (
            <Bullet key={l.id} color={l.color} short={l.short} small />
          ))}
        </div>
      </div>
      {d.here.length > 0 && (
        <div className="here">
          {d.here.map((h) => (
            <button type="button" key={h.key} className="chip" onClick={() => engine.selectTrain(h.key, true)}>
              <Bullet color={h.line.color} short={h.line.short} small />
              <span>
                {h.id} to {h.headsign}
              </span>
              {h.what ? <small>{h.what}</small> : null}
            </button>
          ))}
        </div>
      )}
      <div className="board">
        {d.groups.length === 0 && <p className="empty">No more departures in the timetable today.</p>}
        {d.groups.map((g) => (
          <section className="bgrp" key={`${g.line.id}|${g.headsign}`}>
            <h3 className="bhead">
              <Bullet color={g.line.color} short={g.line.short} small />
              <span>to {g.headsign}</span>
            </h3>
            {g.items.map((it, i) => (
              <div className="brow" key={i}>
                <span className={i === 0 ? 'until soon' : 'until'}>{it.until}</span>
                <time className="tab">{it.time}</time>
                {it.key ? (
                  <button type="button" onClick={() => engine.selectTrain(it.key!, true)}>
                    Show train
                  </button>
                ) : (
                  <span />
                )}
              </div>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
