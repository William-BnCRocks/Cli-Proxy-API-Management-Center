import { describe, expect, test } from 'bun:test';
import {
  LIVE_CONCURRENCY,
  MAX_BACKOFF_MS,
  MIN_RETRY_MS,
  agoParts,
  backoffDelayMs,
  isLiveDue,
  mapWithConcurrency,
  pickDueKeys,
  scheduleAfterFailure,
  scheduleAfterSuccess,
  type LiveSchedule,
} from '@/features/quota/liveRefresh';
import { parseRetryAfterMs } from '@/utils/quota';

const never = () => 0;

describe('live refresh schedule', () => {
  test('success pushes the next fetch one interval out, with bounded jitter', () => {
    expect(scheduleAfterSuccess(1000, 60_000, never)).toEqual({
      updatedAt: 1000,
      nextAt: 61_000,
      failures: 0,
    });
    const jittered = scheduleAfterSuccess(1000, 60_000, () => 0.999);
    expect(jittered.nextAt).toBeGreaterThan(61_000);
    expect(jittered.nextAt).toBeLessThan(1000 + 60_000 * 1.1);
  });

  test('paused success never comes due on its own', () => {
    const schedule = scheduleAfterSuccess(1000, 0, never);
    expect(isLiveDue(schedule, Number.MAX_SAFE_INTEGER - 1, 0, { status: 'success' })).toBe(false);
  });

  test('errors retry at the base cadence first, then double up to the cap', () => {
    expect(backoffDelayMs(60_000, 1, 500)).toBe(60_000);
    expect(backoffDelayMs(60_000, 2, 500)).toBe(120_000);
    expect(backoffDelayMs(60_000, 3, 500)).toBe(240_000);
    expect(backoffDelayMs(60_000, 30, 500)).toBe(MAX_BACKOFF_MS);
    // A short interval never retries faster than the floor.
    expect(backoffDelayMs(1000, 1, 500)).toBe(MIN_RETRY_MS);
  });

  test('429 backs off harder and honours Retry-After', () => {
    expect(backoffDelayMs(60_000, 1, 429)).toBe(120_000);
    expect(backoffDelayMs(60_000, 2, 429)).toBe(240_000);
    expect(backoffDelayMs(60_000, 1, 429, 600_000)).toBe(600_000);
    expect(backoffDelayMs(60_000, 1, 429, 99 * 60_000)).toBe(MAX_BACKOFF_MS);
  });

  test('a failure keeps the last success time and counts consecutive failures', () => {
    const ok = scheduleAfterSuccess(1000, 60_000, never);
    const first = scheduleAfterFailure(ok, 70_000, 60_000, { status: 429, message: 'x' }, never);
    expect(first).toMatchObject({ updatedAt: 1000, failures: 1, nextAt: 70_000 + 120_000 });
    const second = scheduleAfterFailure(
      first,
      200_000,
      60_000,
      { status: 429, message: 'x' },
      never
    );
    expect(second.failures).toBe(2);
    expect(second.nextAt).toBe(200_000 + 240_000);
    // Success resets the streak.
    expect(scheduleAfterSuccess(300_000, 60_000, never).failures).toBe(0);
  });
});

describe('live refresh due rules', () => {
  const schedule = (nextAt: number): LiveSchedule => ({ nextAt, failures: 0, updatedAt: 0 });

  test('a never-fetched credential is due immediately, even when paused', () => {
    expect(isLiveDue(undefined, 0, 60_000, undefined)).toBe(true);
    expect(isLiveDue(undefined, 0, 0, { status: 'idle' })).toBe(true);
    expect(isLiveDue(undefined, 0, 0, { status: 'error' })).toBe(true);
  });

  test('cached data with no schedule refreshes only while live', () => {
    expect(isLiveDue(undefined, 0, 60_000, { status: 'success' })).toBe(true);
    expect(isLiveDue(undefined, 0, 0, { status: 'success' })).toBe(false);
  });

  test('scheduled credentials wait for nextAt and never run when paused', () => {
    expect(isLiveDue(schedule(5000), 4999, 60_000, { status: 'success' })).toBe(false);
    expect(isLiveDue(schedule(5000), 5000, 60_000, { status: 'success' })).toBe(true);
    expect(isLiveDue(schedule(5000), 9999, 0, { status: 'success' })).toBe(false);
  });

  test('does not start a fetch while a manual refresh is loading', () => {
    expect(isLiveDue(undefined, 0, 60_000, { status: 'loading' })).toBe(false);
    expect(isLiveDue(schedule(0), 10, 60_000, { status: 'loading' })).toBe(false);
  });

  test('picks the most overdue keys within the free concurrency slots', () => {
    const candidates = [
      { key: 'a', schedule: schedule(300), due: true },
      { key: 'b', schedule: schedule(100), due: true },
      { key: 'c', schedule: schedule(200), due: true },
      { key: 'd', schedule: schedule(50), due: true },
      { key: 'e', schedule: schedule(10), due: false },
    ];
    expect(pickDueKeys(candidates, new Set())).toEqual(['d', 'b', 'c']);
    expect(pickDueKeys(candidates, new Set(['x']))).toEqual(['d', 'b']);
    expect(pickDueKeys(candidates, new Set(['d', 'x']))).toEqual(['b']);
    expect(pickDueKeys(candidates, new Set(['p', 'q', 'r']))).toEqual([]);
    expect(LIVE_CONCURRENCY).toBe(3);
  });
});

describe('helpers', () => {
  test('mapWithConcurrency bounds parallelism and keeps order', async () => {
    let active = 0;
    let peak = 0;
    const out = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14]);
    expect(peak).toBe(3);
    expect(await mapWithConcurrency([], 3, async (n: number) => n)).toEqual([]);
  });

  test('agoParts picks the coarsest unit', () => {
    expect(agoParts(4_200)).toEqual({ unit: 'seconds', count: 4 });
    expect(agoParts(125_000)).toEqual({ unit: 'minutes', count: 2 });
    expect(agoParts(3 * 3_600_000 + 5000)).toEqual({ unit: 'hours', count: 3 });
    expect(agoParts(-5)).toEqual({ unit: 'seconds', count: 0 });
  });

  test('parseRetryAfterMs reads seconds and HTTP dates, case-insensitively', () => {
    expect(parseRetryAfterMs({ 'Retry-After': ['30'] })).toBe(30_000);
    expect(
      parseRetryAfterMs(
        { 'retry-after': ['Wed, 21 Oct 2026 07:28:30 GMT'] },
        Date.parse('2026-10-21T07:28:00Z')
      )
    ).toBe(30_000);
    expect(parseRetryAfterMs({ 'Content-Type': ['x'] })).toBeNull();
    expect(parseRetryAfterMs(undefined)).toBeNull();
  });
});
