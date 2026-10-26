import { AnimatePresence, motion } from 'motion/react';
import type { CSSProperties } from 'react';
import type { Engine, Snapshot } from '../engine';
import type { LineGroup } from '../types';
import { Ink } from './Ink';
import { pressSoft, sideMotion, tabPage } from './presets';
import { Bullet } from './Roundel';

/** streetcar routes and GO lines are many: show them as compact roundels instead of full rows */
const COMPACT = new Set<LineGroup>(['streetcar', 'go']);
const MAX_ROWS = 150;

export type PanelTab = 'lines' | 'trains';
export type TrainFilter = LineGroup | 'all';

/**
 * The side panel. App mounts it inside AnimatePresence, so it slides in when opened and out when closed;
 * its tab and filter live in App so they survive closing it.
 */
export function LinePanel({
  snap,
  engine,
  tab,
  onTab,
  filter,
  onFilter,
  onPick,
}: {
  snap: Snapshot;
  engine: Engine;
  tab: PanelTab;
  onTab: (t: PanelTab) => void;
  filter: TrainFilter;
  onFilter: (f: TrainFilter) => void;
  onPick: () => void;
}) {
  const selKey = snap.detail?.kind === 'train' ? snap.detail.key : null;
  const built = new Date(engine.data.generatedAt);
  const trains = filter === 'all' ? snap.trains : snap.trains.filter((t) => t.line.group === filter);
  const shown = trains.slice(0, MAX_ROWS);
  return (
    <motion.aside className="panel side" aria-label="Lines and trains" {...sideMotion()}>
      <div className="tabs" role="tablist">
        {(['lines', 'trains'] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => onTab(t)}>
            {/* the indicator is one shared element: Motion slides it from tab to tab */}
            {tab === t && <Ink id="tab-ink" className="tab-ink" />}
            <span className="tab-label">
              {t === 'lines' ? (
                'Lines'
              ) : (
                <>
                  Trains <span className="tab">{snap.total}</span>
                </>
              )}
            </span>
          </button>
        ))}
      </div>

      <AnimatePresence mode="wait" initial={false}>
        {tab === 'lines' ? (
          <motion.div key="lines" className="scroll lines" role="tabpanel" {...tabPage}>
            <p className="lede">Choose what the map shows. Counts are trains on the map right now.</p>
            {snap.groups.map((g) => {
              const lines = snap.lines.filter((l) => l.group === g.id);
              return (
                <section className="lgroup" key={g.id} style={{ '--c': g.color } as CSSProperties}>
                  <motion.button
                    type="button"
                    className="lg-head"
                    aria-pressed={!g.hidden}
                    onClick={() => engine.toggleGroup(g.id)}
                    title={g.hidden ? `Show all ${g.label}` : `Hide all ${g.label}`}
                    {...pressSoft}
                  >
                    <i className="lg-dot" />
                    <span>{g.label}</span>
                    <b className="tab">{g.count}</b>
                  </motion.button>
                  {COMPACT.has(g.id) ? (
                    <div className="lchips">
                      {lines.map((l) => (
                        <motion.button
                          key={l.id}
                          type="button"
                          aria-pressed={!l.hidden}
                          onClick={() => engine.toggleLine(l.id)}
                          title={`${l.name}: ${l.count} on the map${l.hidden ? ' (hidden)' : ''}`}
                          {...pressSoft}
                        >
                          <Bullet color={l.color} short={l.short} small />
                          <span className="tab">{l.count}</span>
                        </motion.button>
                      ))}
                    </div>
                  ) : (
                    <div className="lrows">
                      {lines.map((l) => (
                        <motion.button key={l.id} type="button" aria-pressed={!l.hidden} onClick={() => engine.toggleLine(l.id)} title={l.hidden ? `Show ${l.name}` : `Hide ${l.name}`} {...pressSoft}>
                          <Bullet color={l.color} short={l.short} />
                          <span className="lname">{l.name.replace(/^Line \d+ /, '')}</span>
                          <span className="tab lcount">{l.count}</span>
                        </motion.button>
                      ))}
                    </div>
                  )}
                </section>
              );
            })}
          </motion.div>
        ) : (
          <motion.div key="trains" className="scroll trains-tab" role="tabpanel" {...tabPage}>
            <div className="tfilter" aria-label="Show trains of">
              {(['all', ...snap.groups.map((g) => g.id)] as TrainFilter[]).map((id) => (
                <button key={id} type="button" aria-pressed={filter === id} onClick={() => onFilter(id)}>
                  {filter === id && <Ink id="filter-ink" className="filter-ink" />}
                  <span className="tab-label">{id === 'all' ? 'All' : snap.groups.find((g) => g.id === id)?.label}</span>
                </button>
              ))}
            </div>
            {trains.length === 0 ? (
              <p className="empty">No trains of this kind are running at this time. Drag the timeline to a busier hour.</p>
            ) : (
              <ul className="trains">
                {shown.map((t) => (
                  <li key={t.key}>
                    <button
                      type="button"
                      className={t.key === selKey ? 'row on' : 'row'}
                      onClick={() => {
                        engine.selectTrain(t.key, true);
                        onPick();
                      }}
                    >
                      <Bullet color={t.line.color} short={t.line.short} />
                      <span className="rdest">{t.headsign}</span>
                      <span className="reta tab">{t.eta}</span>
                      <span className="rstat">
                        <span className="rid">{t.id}</span> {t.status}
                        {t.ug ? <em className="ug-tag">in tunnel</em> : null}
                      </span>
                    </button>
                  </li>
                ))}
                {trains.length > shown.length && <li className="more">{trains.length - shown.length} more trains. Pick a kind above to see them.</li>}
              </ul>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      <footer className="source">
        {snap.fallback && <p className="note">{snap.fallback}</p>}
        <p>
          Positions come from the timetables, not GPS:{' '}
          {engine.data.feeds
            .filter((f) => f.key !== 'tl')
            .map((f) => `${f.name} to ${fmtDate(f.end)}`)
            .join(', ')}
          . Terminal Link from Pearson's published frequencies. Built {built.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })}.
        </p>
      </footer>
    </motion.aside>
  );
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDate = (k: string) => `${MONTHS[+k.slice(4, 6) - 1]} ${+k.slice(6, 8)}`;
