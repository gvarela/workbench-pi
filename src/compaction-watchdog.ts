/**
 * compaction-watchdog — proactive, tier-aware compaction for small context windows.
 *
 * Live failure that motivated this (2026-07-09): a qwen session reached ~50k tokens
 * against a 32k window with ZERO compactions. pi's threshold machinery failed
 * silently three ways: the reserve/keepRecent defaults no-op in a band above the
 * trigger; error-terminated messages (timeouts) break its context accounting; and
 * by the time it does fire, the summarization request itself is a 30k+ prefill that
 * times out on the same swamped hardware.
 *
 * The watchdog sidesteps all three: on the small tier it triggers a MANUAL compact
 * (with preserve-instructions) at 80% of the window — early enough that the
 * summarization request is survivable, and independent of pi's threshold path,
 * which remains untouched as a backstop. At 95% (compactions evidently not
 * landing) it escalates to a visible warning instead of another silent failure.
 * Percentage-based, so it adapts to whatever window the active model has; the
 * capable tier never triggers — pi's own machinery is trusted there.
 */

import type { Tier } from "./tier.ts";

/** Trigger a proactive compact at this fraction of the context window. */
export const WATCHDOG_THRESHOLD = 0.8;
/** Above this fraction compaction is evidently failing — surface it to the human. */
export const WATCHDOG_WARN = 0.95;

export type WatchdogAction = "compact" | "warn" | undefined;

export function watchdogAction(
  tier: Tier,
  tokens: number | null,
  contextWindow: number,
  compactInFlight: boolean,
): WatchdogAction {
  if (tier !== "small" || tokens === null || contextWindow <= 0) return undefined;
  const fraction = tokens / contextWindow;
  if (fraction >= WATCHDOG_WARN) return "warn";
  if (fraction >= WATCHDOG_THRESHOLD && !compactInFlight) return "compact";
  return undefined;
}
