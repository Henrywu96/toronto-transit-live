import type { CSSProperties, ReactNode } from 'react';
import { inkFor } from '../lib/color';

/** a line's roundel, as on TTC signs: the line number in a circle of the line colour (wider for 501, VIA…) */
export const Bullet = ({ color, short, small }: { color: string; short: string; small?: boolean }) => (
  <i className={small ? 'bul sm' : 'bul'} style={{ '--c': color, '--t': inkFor(color) } as CSSProperties}>
    {short}
  </i>
);

const Svg = ({ children, size = 16 }: { children: ReactNode; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    {children}
  </svg>
);

export const PlayIcon = () => (
  <Svg>
    <path d="M4.5 2.8v10.4L13 8z" fill="currentColor" />
  </Svg>
);
export const PauseIcon = () => (
  <Svg>
    <rect x="3.5" y="3" width="3.2" height="10" rx="0.8" fill="currentColor" />
    <rect x="9.3" y="3" width="3.2" height="10" rx="0.8" fill="currentColor" />
  </Svg>
);
export const MenuIcon = () => (
  <Svg size={18}>
    <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </Svg>
);
export const CloseIcon = () => (
  <Svg size={14}>
    <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
  </Svg>
);
export const SearchIcon = () => (
  <Svg size={15}>
    <circle cx="7" cy="7" r="4.4" fill="none" stroke="currentColor" strokeWidth="1.6" />
    <path d="M10.3 10.3l3.2 3.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </Svg>
);
