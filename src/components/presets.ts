import type { Transition } from 'motion/react';

/**
 * Motion for React presets: how panels and cards come and go, and the springs behind the sliding indicators.
 * Cards come in from the right on wide screens and from below on phones (where they are bottom sheets).
 */
export const narrow = () => typeof window !== 'undefined' && window.innerWidth < 760;

export const snappy: Transition = { type: 'spring', stiffness: 520, damping: 40, mass: 0.8 };
export const settle: Transition = { type: 'spring', stiffness: 360, damping: 34 };
const quickOut: Transition = { duration: 0.16, ease: [0.4, 0, 1, 1] };

/** the card on the right (a train, a station, the help) */
export const cardMotion = () => {
  const n = narrow();
  return {
    initial: n ? { opacity: 0, y: 32 } : { opacity: 0, x: 28, scale: 0.98 },
    animate: { opacity: 1, x: 0, y: 0, scale: 1, transition: settle },
    exit: n ? { opacity: 0, y: 24, transition: quickOut } : { opacity: 0, x: 20, scale: 0.98, transition: quickOut },
  };
};

/** the side panel with the lines and trains */
export const sideMotion = () => {
  const n = narrow();
  return {
    initial: n ? { opacity: 0, y: -16 } : { opacity: 0, x: -24 },
    animate: { opacity: 1, x: 0, y: 0, transition: settle },
    exit: n ? { opacity: 0, y: -12, transition: quickOut } : { opacity: 0, x: -20, transition: quickOut },
  };
};

/** switching between the panel's tabs */
export const tabPage = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.22, ease: [0, 0, 0.2, 1] } },
  exit: { opacity: 0, y: -6, transition: { duration: 0.12 } },
} as const;

/** messages near the bottom of the screen */
export const toastMotion = {
  initial: { opacity: 0, y: 14, scale: 0.95 },
  animate: { opacity: 1, y: 0, scale: 1, transition: snappy },
  exit: { opacity: 0, y: 8, transition: { duration: 0.18 } },
} as const;

/** the "no trains right now" notice */
export const noticeMotion = {
  initial: { opacity: 0, scale: 0.94 },
  animate: { opacity: 1, scale: 1, transition: settle },
  exit: { opacity: 0, scale: 0.96, transition: { duration: 0.15 } },
} as const;

/** press feedback on buttons */
export const press = { whileTap: { scale: 0.94 } } as const;
export const pressSoft = { whileTap: { scale: 0.97 } } as const;
