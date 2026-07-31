/**
 * format.ts — how numbers, money and time are written in this UI.
 *
 * These existed as private copies in six components, and the copies had drifted
 * into disagreement — which is why this file exists at all. The differences were
 * not stylistic:
 *
 *   usd  four variants. `ProjectFilter` used `toFixed(0)` above $1, so $5.50
 *        rendered as "$6" — cents rounded away at exactly the magnitudes where
 *        they carry meaning. `Summary` alone had a `>= 100` tier.
 *   dur  three variants in TWO DIFFERENT UNITS. Two took milliseconds, one took
 *        seconds. Passing the wrong one is silently wrong by a factor of 1000
 *        and looks entirely plausible on screen.
 *
 * So the unit is now in the parameter name, and there is one implementation to
 * be right or wrong about.
 */

/**
 * Money, with precision that follows magnitude.
 *
 * Three tiers, generalised from `Summary`'s version because it was the only one
 * that got the large end right: whole dollars above $100 (nobody reads
 * "$13023.00"), cents in the ordinary range, and a third decimal below $1 —
 * per-turn costs live there and rounding them to cents collapses most of the
 * distribution onto "$0.01".
 */
export const usd = (n: number): string =>
  n >= 100 ? `$${n.toFixed(0)}` : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`;

/** A share of a total, or an em dash when the total is zero. */
export const pct = (n: number, of: number): string =>
  of > 0 ? `${((n / of) * 100).toFixed(1)}%` : "—";

/**
 * A duration in MILLISECONDS — the unit is in the name deliberately.
 *
 * Floors at "1m" rather than reporting "0m": a session that ran for forty
 * seconds did happen, and "0m" reads as a bug in the data rather than as a
 * short session. Callers holding seconds must convert; `Sessions.tsx` does.
 */
export const dur = (ms: number): string =>
  ms >= 86400_000
    ? `${(ms / 86400_000).toFixed(1)}d`
    : ms >= 3600_000
      ? `${(ms / 3600_000).toFixed(1)}h`
      : `${Math.max(1, Math.round(ms / 60_000))}m`;

/** A timestamp as `YYYY-MM-DD HH:MM`, UTC. */
export const when = (t: number): string => new Date(t).toISOString().slice(0, 16).replace("T", " ");

/** A timestamp as `YYYY-MM-DD`, UTC. */
export const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
