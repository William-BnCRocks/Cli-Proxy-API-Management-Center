/**
 * Live-refresh scheduling for the quota page: pure rules, no React, no network.
 *
 * Each credential carries a small schedule (`LiveSchedule`). A success pushes
 * the next fetch one interval out; a failure backs off exponentially, and a 429
 * backs off harder (honouring Retry-After). tests/quotaLiveRefresh.test.ts
 * exercises every rule directly.
 */

/**
 * Where a card's numbers come from.
 * - plugin: the account-pool plugin's cache (no upstream call from the browser), so a short interval is free.
 * - direct: the browser asks Anthropic / ChatGPT / xAI / ... through api-call, so the default is gentler.
 */
export type QuotaSourceMode = 'plugin' | 'direct';

/** Auto-refresh choices in ms per source; 0 = paused (initial load still happens once). */
export const PLUGIN_INTERVALS_MS = [0, 30_000, 60_000, 120_000, 300_000] as const;
export const DIRECT_INTERVALS_MS = [0, 120_000, 300_000] as const;
export const LIVE_INTERVALS_MS = PLUGIN_INTERVALS_MS;
export const DEFAULT_PLUGIN_INTERVAL_MS = 60_000;
export const DEFAULT_DIRECT_INTERVAL_MS = 120_000;
export const DEFAULT_LIVE_INTERVAL_MS = DEFAULT_DIRECT_INTERVAL_MS;

export const intervalsFor = (mode: QuotaSourceMode): readonly number[] =>
  mode === 'plugin' ? PLUGIN_INTERVALS_MS : DIRECT_INTERVALS_MS;
export const defaultIntervalFor = (mode: QuotaSourceMode): number =>
  mode === 'plugin' ? DEFAULT_PLUGIN_INTERVAL_MS : DEFAULT_DIRECT_INTERVAL_MS;
/** Upstream calls in flight at once, across the whole page. */
export const LIVE_CONCURRENCY = 3;
export const MAX_BACKOFF_MS = 15 * 60_000;
/** A server-provided Retry-After is honoured further than our own guess, but not forever. */
export const MAX_RETRY_AFTER_MS = 60 * 60_000;
/** Never retry faster than this, whatever the chosen interval. */
export const MIN_RETRY_MS = 30_000;
/** Spread of the next due time so credentials do not all fire in the same second. */
export const LIVE_JITTER_RATIO = 0.1;

export interface LiveSchedule {
  /** Last successful fetch, epoch ms. */
  updatedAt?: number;
  /** Earliest time the next automatic fetch may start, epoch ms. */
  nextAt: number;
  /** Consecutive failures since the last success. */
  failures: number;
  lastError?: { status?: number; message: string; at: number };
  /** Plugin mode: where the cached numbers came from and when (epoch ms). */
  data?: { source: string; at: number };
}

export const isLiveInterval = (value: unknown, mode: QuotaSourceMode = 'plugin'): value is number =>
  typeof value === 'number' && intervalsFor(mode).includes(value);

/**
 * Delay before retrying after the `failures`-th consecutive failure (>= 1).
 * - 429: at least double the base on the first hit, doubling per repeat, and
 *   never sooner than the server's Retry-After (up to an hour).
 * - other errors: retry at the base cadence first, then double.
 */
export function backoffDelayMs(
  intervalMs: number,
  failures: number,
  status?: number,
  retryAfterMs?: number | null
): number {
  const base = Math.max(intervalMs, MIN_RETRY_MS);
  const steps = Math.max(0, failures - (status === 429 ? 0 : 1));
  const exponential = Math.min(MAX_BACKOFF_MS, base * 2 ** Math.min(steps, 10));
  const hinted = typeof retryAfterMs === 'number' && retryAfterMs > 0 ? retryAfterMs : 0;
  return Math.max(exponential, Math.min(MAX_RETRY_AFTER_MS, hinted));
}

/** `random` is injectable for tests; returns a value in [0, ratio * delay). */
const jitter = (delayMs: number, random: () => number) =>
  Math.floor(delayMs * LIVE_JITTER_RATIO * random());

export function scheduleAfterSuccess(
  now: number,
  intervalMs: number,
  random: () => number = Math.random,
  data?: LiveSchedule['data']
): LiveSchedule {
  return {
    updatedAt: now,
    ...(data ? { data } : {}),
    // Paused: park the next fetch far away; the pause check in isDue is what matters.
    nextAt:
      intervalMs > 0 ? now + intervalMs + jitter(intervalMs, random) : Number.MAX_SAFE_INTEGER,
    failures: 0,
  };
}

export function scheduleAfterFailure(
  previous: LiveSchedule | undefined,
  now: number,
  intervalMs: number,
  error: { status?: number; message: string; retryAfterMs?: number | null },
  random: () => number = Math.random
): LiveSchedule {
  const failures = (previous?.failures ?? 0) + 1;
  const delay = backoffDelayMs(
    intervalMs || DEFAULT_LIVE_INTERVAL_MS,
    failures,
    error.status,
    error.retryAfterMs
  );
  return {
    updatedAt: previous?.updatedAt,
    nextAt: now + delay + jitter(delay, random),
    failures,
    lastError: { status: error.status, message: error.message, at: now },
  };
}

/**
 * Should an automatic fetch start now?
 * - `loading`: something (a manual refresh) is already fetching it.
 * - never fetched: always due, even when paused (that is the "load on open").
 * - paused: otherwise never due.
 */
export function isLiveDue(
  schedule: LiveSchedule | undefined,
  now: number,
  intervalMs: number,
  state: { status?: string } | undefined
): boolean {
  if (state?.status === 'loading') return false;
  if (!schedule) {
    return state?.status !== 'success' || intervalMs > 0;
  }
  if (intervalMs <= 0) return false;
  return now >= schedule.nextAt;
}

/** Entries to start now: due ones, oldest-first, bounded by the free concurrency slots. */
export function pickDueKeys(
  candidates: { key: string; schedule: LiveSchedule | undefined; due: boolean }[],
  inFlight: ReadonlySet<string>,
  concurrency: number = LIVE_CONCURRENCY
): string[] {
  const slots = Math.max(0, concurrency - inFlight.size);
  return candidates
    .filter((c) => c.due && !inFlight.has(c.key))
    .sort((a, b) => (a.schedule?.nextAt ?? 0) - (b.schedule?.nextAt ?? 0))
    .slice(0, slots)
    .map((c) => c.key);
}

/** Map with a worker-pool limit; results keep input order. Never rejects if `fn` does not. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

export interface AgoParts {
  unit: 'seconds' | 'minutes' | 'hours';
  count: number;
}

/** Coarse "how long ago" for the card footer; truncates like the countdowns do. */
export function agoParts(ageMs: number): AgoParts {
  const seconds = Math.max(0, Math.floor(ageMs / 1000));
  if (seconds < 60) return { unit: 'seconds', count: seconds };
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return { unit: 'minutes', count: minutes };
  return { unit: 'hours', count: Math.floor(minutes / 60) };
}
