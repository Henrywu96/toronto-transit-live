import { useEffect } from 'react';
import type { Engine } from '../engine';

/** Space pause · N now · 1/2/3 speed · ←/→ ±10 min · F follow · R random train · C city · O whole region · D downtown · T tilt · Esc close */
export function useShortcuts(engine: Engine) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      const act: Record<string, () => void> = {
        ' ': () => engine.togglePause(),
        n: () => engine.goLive(),
        '1': () => engine.setSpeed(1),
        '2': () => engine.setSpeed(10),
        '3': () => engine.setSpeed(60),
        arrowleft: () => engine.shift(-600),
        arrowright: () => engine.shift(600),
        f: () => {
          if (engine.sel?.kind === 'train') engine.setFollow(!engine.follow);
        },
        r: () => engine.followRandom(),
        c: () => engine.view('city'),
        o: () => engine.view('network'),
        d: () => engine.view('downtown'),
        t: () => engine.view('tilt'),
        escape: () => engine.clearSelection(),
      };
      const fn = act[k];
      if (!fn) return;
      if (k === ' ' && t?.tagName === 'BUTTON') return; // let Space press the focused button
      e.preventDefault();
      fn();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [engine]);
}
