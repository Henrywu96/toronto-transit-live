import { useLayoutEffect, useRef } from 'react';
import type { JSAnimation } from 'animejs';
import { rollNumber } from '../lib/motion';

/**
 * A count that rolls to its new value. React renders an empty element and anime.js owns its text, so the
 * four-times-a-second UI updates never fight the animation. `from` sets where the first roll starts (0 for
 * the entrance), otherwise the first value appears as it is.
 */
export function Rolling({ value, className, from }: { value: number; className?: string; from?: number }) {
  const el = useRef<HTMLElement>(null);
  const shown = useRef<number | null>(null);
  const anim = useRef<JSAnimation | null>(null);
  useLayoutEffect(() => {
    const node = el.current;
    if (!node) return;
    const start = shown.current ?? from ?? value;
    anim.current = rollNumber(node, start, value, anim.current);
    shown.current = value;
  }, [value, from]);
  useLayoutEffect(
    () => () => {
      anim.current?.pause();
    },
    [],
  );
  return <b ref={el} className={className} />;
}
