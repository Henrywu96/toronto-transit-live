import { motion } from 'motion/react';
import { memo } from 'react';
import { snappy } from './presets';

/**
 * The highlight behind the chosen tab, filter or speed. Only the chosen button renders one, and they share a
 * layoutId, so Motion slides it from the old button to the new one. It is memoised so the four-a-second clock
 * updates do not make Motion measure it again; it measures itself when it moves.
 */
export const Ink = memo(function Ink({ id, className }: { id: string; className: string }) {
  return <motion.span layoutId={id} className={className} transition={snappy} aria-hidden="true" />;
});
