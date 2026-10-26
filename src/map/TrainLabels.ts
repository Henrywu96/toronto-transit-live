import type { Map as MlMap } from 'maplibre-gl';
import { inkFor } from '../lib/color';
import type { LocalFrame } from '../lib/geo';
import { trainName } from '../lib/schedule';
import type { TrainPose } from './TrainLayer';

interface Item {
  el: HTMLButtonElement;
  dot: HTMLElement;
  text: HTMLElement;
  dest: HTMLElement;
  label: string;
  cls: string;
  color: string;
  shown: boolean;
}

interface Candidate {
  key: string;
  pose: TrainPose;
  x: number;
  y: number;
  label: string;
  dest: string;
  sel: boolean;
  w: number;
}

const H = 22;
const GAP = 12;

/**
 * Little name tags above the trains, positioned in the same frame the trains are drawn in.
 * Tags that would overlap one already placed are skipped (the selected train always wins).
 * Elements are recycled and only touched when something changed.
 */
export class TrainLabels {
  private readonly root: HTMLDivElement;
  private readonly items = new Map<string, Item>();
  private readonly cands: Candidate[] = [];
  private readonly placed: number[] = [];

  constructor(container: HTMLElement, onPick: (key: string) => void) {
    this.root = document.createElement('div');
    this.root.className = 'train-labels';
    container.appendChild(this.root);
    this.root.addEventListener('click', (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-key]');
      if (el?.dataset.key) {
        e.stopPropagation();
        onPick(el.dataset.key);
      }
    });
  }

  update(map: MlMap, frame: LocalFrame, poses: TrainPose[], selected: string | null) {
    const zoom = map.getZoom();
    const showAll = zoom >= 12.8;
    const full = zoom >= 14.6;
    const { clientWidth: W, clientHeight: Hc } = map.getContainer();
    // how far up the screen one metre of height goes at this zoom and tilt
    const lift = Math.sin((map.getPitch() * Math.PI) / 180) / frame.metersPerPixel(zoom);

    const cands = this.cands;
    cands.length = 0;
    for (const p of poses) {
      const v = p.state.v;
      const sel = v.key === selected;
      if (!showAll && !sel) continue;
      // streetcars are everywhere downtown: tag them only once zoomed in to street level
      const line = p.state.trip.pattern.line;
      if (!sel && line.group === 'streetcar' && zoom < 14.2) continue;
      const s = map.project(frame.toLngLat(p.x, p.y));
      if (s.x < -80 || s.y < -40 || s.x > W + 80 || s.y > Hc + 60) continue;
      // sit just above the highest point of the model on screen (nose, tail or centre)
      const a = map.project(frame.toLngLat(p.fx, p.fy));
      const b = map.project(frame.toLngLat(p.rx, p.ry));
      const y = Math.min(s.y, a.y, b.y) - p.h * lift - 3;
      const name = trainName(p.state.trip, v);
      const dest = sel || full ? p.state.trip.pattern.headsign : '';
      cands.push({ key: v.key, pose: p, x: s.x, y, label: name, dest, sel, w: 34 + 6.3 * (name.length + dest.length) });
    }
    cands.sort((c, d) => (c.sel === d.sel ? 0 : c.sel ? -1 : 1));

    const placed = this.placed;
    placed.length = 0;
    const seen = new Set<string>();
    for (const c of cands) {
      const x0 = c.x - c.w / 2;
      const y0 = c.y - GAP - H;
      let free = true;
      if (!c.sel) {
        for (let i = 0; i < placed.length; i += 4) {
          if (x0 < placed[i + 2] + 2 && x0 + c.w + 2 > placed[i] && y0 < placed[i + 3] + 2 && y0 + H + 2 > placed[i + 1]) {
            free = false;
            break;
          }
        }
      }
      if (!free) continue;
      placed.push(x0, y0, x0 + c.w, y0 + H);
      seen.add(c.key);
      this.show(c);
    }
    for (const [key, it] of this.items) {
      if (seen.has(key)) continue;
      if (it.shown) {
        it.shown = false;
        it.el.hidden = true;
      }
      // forget trains that are long gone so the list does not grow all day
      if (this.items.size > 400) {
        it.el.remove();
        this.items.delete(key);
      }
    }
  }

  private show(c: Candidate) {
    const v = c.pose.state.v;
    let it = this.items.get(c.key);
    if (!it) {
      const el = document.createElement('button');
      el.type = 'button';
      el.dataset.key = c.key;
      const dot = document.createElement('i');
      const text = document.createElement('b');
      const dest = document.createElement('span');
      el.append(dot, text, dest);
      this.root.appendChild(el);
      it = { el, dot, text, dest, label: '', cls: '', color: '', shown: true };
      this.items.set(c.key, it);
    }
    if (`${c.label}|${c.dest}` !== it.label) {
      it.label = `${c.label}|${c.dest}`;
      it.text.textContent = c.label;
      it.dest.textContent = c.dest;
      it.dest.hidden = !c.dest;
      it.el.title = `${c.pose.state.trip.pattern.line.name} ${trainName(c.pose.state.trip, v)} to ${c.pose.state.trip.pattern.headsign}`;
    }
    const cls = `tl${c.sel ? ' sel' : ''}${c.pose.ug ? ' ug' : ''}`;
    if (cls !== it.cls) {
      it.cls = cls;
      it.el.className = cls;
    }
    const line = c.pose.state.trip.pattern.line;
    if (line.id !== it.color) {
      it.color = line.id;
      it.el.style.setProperty('--c', line.color);
      it.el.style.setProperty('--t', inkFor(line.color));
      it.dot.textContent = line.short;
    }
    it.el.style.transform = `translate3d(${c.x.toFixed(1)}px,${c.y.toFixed(1)}px,0)`;
    if (!it.shown) {
      it.shown = true;
      it.el.hidden = false;
    }
  }

  destroy() {
    this.root.remove();
    this.items.clear();
  }
}
