import { animate, createTimeline, stagger, type JSAnimation } from 'animejs';

/**
 * The app's motion is shared between two libraries, each doing what it is best at:
 *
 *  - Motion for React (`motion/react`, see components/presets.ts) moves what React mounts and unmounts: cards
 *    and panels sliding in and out, the indicators that slide between tabs and speeds, press feedback.
 *  - anime.js (this file) runs timelines and anything outside React: the entrance, rolling numbers, the
 *    gliding clock, the ripple on the map, and the staggered contents of a card.
 *
 * Every animation answers something the viewer did, plus one entrance when the timetable has loaded.
 * People who ask their system for reduced motion get the end state straight away (Motion reads the same
 * setting through MotionConfig reducedMotion="user").
 */

export const reducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** a number that rolls to its new value instead of jumping (the train counts in the sign band) */
export function rollNumber(el: HTMLElement, from: number, to: number, prev?: JSAnimation | null): JSAnimation | null {
  prev?.pause();
  if (reducedMotion() || from === to) {
    el.textContent = String(to);
    return null;
  }
  const o = { v: from };
  el.textContent = String(from);
  return animate(o, {
    v: to,
    duration: Math.min(900, 380 + Math.abs(to - from) * 6),
    ease: 'outQuart',
    onUpdate: () => {
      el.textContent = String(Math.round(o.v));
    },
  });
}

/** the one entrance: the sign band's mark and counts, then the day's service filling the timeline */
export function intro(root: HTMLElement) {
  if (reducedMotion()) return;
  const q = (s: string) => [...root.querySelectorAll<HTMLElement | SVGElement>(s)];
  const tl = createTimeline({ defaults: { ease: 'outQuart' } });
  const mark = q('.band .mark');
  if (mark.length) tl.add(mark, { scale: [0.4, 1], opacity: [0, 1], rotate: ['-90deg', '0deg'], duration: 650 }, 0);
  const name = q('.band .brand-name');
  if (name.length) tl.add(name, { opacity: [0, 1], x: [-10, 0], duration: 500 }, 120);
  const counts = q('.counts li');
  if (counts.length) tl.add(counts, { opacity: [0, 1], y: [-8, 0], duration: 450, delay: stagger(55) }, 200);
  // each mode's band of the timeline rises from the baseline in turn: subway, LRT, streetcar, GO …
  const layers = q('.ribbon-chart path');
  if (layers.length) tl.add(layers, { scaleY: [0, 1], duration: 900, delay: stagger(110), ease: 'outExpo' }, 250);
  const head = q('.playhead');
  if (head.length) tl.add(head, { opacity: [0, 1], y: [-10, 0], duration: 400 }, 850);
  const rows = q('.side .lgroup');
  if (rows.length) tl.add(rows, { opacity: [0, 1], y: [8, 0], duration: 420, delay: stagger(60) }, 380);
}

/**
 * A card's contents settling in after the card itself has slid in (Motion moves the card):
 * the strip map lights up stop by stop, a station wall's trim stripes draw across, departures follow.
 */
export function enterContents(card: HTMLElement) {
  if (reducedMotion()) return;
  const stops = [...card.querySelectorAll<HTMLElement>('.strip li')].filter((li) => li.offsetTop - (li.parentElement?.scrollTop ?? 0) < 520);
  if (stops.length) animate(stops, { opacity: [0, 1], x: [-6, 0], duration: 320, delay: stagger(22, { start: 140 }), ease: 'outQuad' });
  const trim = card.querySelectorAll<HTMLElement>('.trim i');
  if (trim.length) animate(trim, { scaleX: [0, 1], duration: 500, delay: stagger(60, { start: 100 }), ease: 'outExpo' });
  const rows = card.querySelectorAll<HTMLElement>('.bgrp, .chip, .legend li');
  if (rows.length) animate(rows, { opacity: [0, 1], y: [6, 0], duration: 340, delay: stagger(45, { start: 160 }), ease: 'outQuad' });
}

/**
 * Tween numbers over time and hand every frame's values to `apply` (the gliding clock and the
 * station ripple on the map use this). Returns the animation so it can be stopped.
 */
export function tween(
  from: Record<string, number>,
  to: Record<string, number | number[]>,
  opts: { duration: number; ease?: string; loop?: number; apply: (v: Record<string, number>) => void; done?: () => void },
): JSAnimation {
  const o = { ...from };
  return animate(o, {
    ...to,
    duration: opts.duration,
    ease: opts.ease ?? 'inOutCubic',
    loop: opts.loop ?? 0,
    onUpdate: () => opts.apply(o),
    onComplete: () => opts.done?.(),
  });
}
