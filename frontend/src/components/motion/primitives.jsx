/**
 * Motion primitives — the single animation vocabulary of the product.
 * Import motion only from here in pages, so animation stays consistent.
 *
 * Principles: opacity/transform only, 150–300ms micro, gentle springs for
 * larger moves. All transitions honor prefers-reduced-motion globally via
 * <MotionConfig reducedMotion="user"> in App.jsx.
 */
import { motion } from 'motion/react';

/** Shared easing/timing — expensive, intentional, never bouncy. */
export const EASE = [0.22, 1, 0.36, 1]; // easeOutQuint-like, used everywhere
export const MICRO = 0.18; // micro-interactions (hover/press/feedback)
export const ENTER = 0.32; // page/section entrances

/** Page entrance: content fades in and rises 8px. Never from far away. */
export function PageTransition({ children, className = '', ...rest }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: ENTER, ease: EASE }}
      className={className}
      {...rest}
    >
      {children}
    </motion.div>
  );
}

/** Generic one-shot fade-up on mount. */
export function FadeIn({ delay = 0, y = 8, className = '', children, ...rest }) {
  return (
    <motion.div
      initial={{ opacity: 0, y }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: ENTER, delay, ease: EASE }}
      className={className}
      {...rest}
    >
      {children}
    </motion.div>
  );
}

/**
 * Stagger — parent orchestrates children's entrance.
 * <Stagger> wraps cards; direct children (or <StaggerItem>) cascade in.
 */
export function Stagger({ children, className = '', delay = 0, gap = 0.06, ...rest }) {
  return (
    <motion.div
      initial="hidden"
      animate="show"
      variants={{
        hidden: {},
        show: { transition: { staggerChildren: gap, delayChildren: delay } },
      }}
      className={className}
      {...rest}
    >
      {children}
    </motion.div>
  );
}

/** Child of <Stagger> — fades up slightly, inheriting the parent cascade. */
export function StaggerItem({ children, className = '', ...rest }) {
  return (
    <motion.div
      variants={{
        hidden: { opacity: 0, y: 10 },
        show: { opacity: 1, y: 0, transition: { duration: ENTER, ease: EASE } },
      }}
      className={className}
      {...rest}
    >
      {children}
    </motion.div>
  );
}

/**
 * Reveal — scroll-triggered fade-up for long marketing/landing sections.
 * Fires once when 15% visible; no constant looping.
 */
export function Reveal({ children, className = '', y = 16, delay = 0, ...rest }) {
  return (
    <motion.div
      initial={{ opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.15 }}
      transition={{ duration: ENTER, delay, ease: EASE }}
      className={className}
      {...rest}
    >
      {children}
    </motion.div>
  );
}

/** Card hover affordance — a whisper of lift, never a jump. */
export const cardHover = {
  whileHover: { y: -2 },
  transition: { duration: MICRO, ease: EASE },
};
