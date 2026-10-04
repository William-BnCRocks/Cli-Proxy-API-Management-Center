/**
 * Live-refresh state shared by the quota page, the cards and the manual-refresh
 * paths: the data source (account-pool plugin cache vs direct api-call), the
 * chosen interval for each source, and one `LiveSchedule` per credential.
 *
 * Keys carry the quota cache generation, so a reconnect (which bumps it) starts
 * every credential from a clean slate without an explicit reset.
 */

import { create } from 'zustand';
import { useQuotaStore } from '@/stores/useQuotaStore';
import {
  defaultIntervalFor,
  isLiveInterval,
  scheduleAfterFailure,
  scheduleAfterSuccess,
  type LiveSchedule,
  type QuotaSourceMode,
} from './liveRefresh';

const storageKey = (mode: QuotaSourceMode) => `quotaPage.liveIntervalMs.${mode}`;

export const readStoredLiveInterval = (mode: QuotaSourceMode): number => {
  const fallback = defaultIntervalFor(mode);
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(storageKey(mode));
    if (raw === null) return fallback;
    const value = Number(raw);
    return isLiveInterval(value, mode) ? value : fallback;
  } catch {
    return fallback;
  }
};

const writeStoredLiveInterval = (mode: QuotaSourceMode, value: number) => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(storageKey(mode), String(value));
  } catch {
    // ignore
  }
};

export const liveKey = (generation: number, type: string, cacheKey: string): string =>
  `${generation}:${type}:${cacheKey}`;

/** Key for a credential under the current cache generation. */
export const currentLiveKey = (type: string, cacheKey: string): string =>
  liveKey(useQuotaStore.getState().cacheGeneration, type, cacheKey);

/** Healthy credentials follow a new cadence at once; backed-off ones keep their delay. */
const rescheduled = (schedules: Record<string, LiveSchedule>, intervalMs: number) => {
  const next: Record<string, LiveSchedule> = {};
  for (const [key, schedule] of Object.entries(schedules)) {
    next[key] =
      schedule.failures === 0 && schedule.updatedAt !== undefined
        ? {
            ...schedule,
            nextAt: intervalMs > 0 ? schedule.updatedAt + intervalMs : Number.MAX_SAFE_INTEGER,
          }
        : schedule;
  }
  return next;
};

interface QuotaLiveState {
  /**
   * `unknown` until the account-pool probe answers; Claude, Codex and xAI are not
   * fetched before that, so a page open never touches Anthropic/ChatGPT/xAI by accident.
   */
  source: QuotaSourceMode | 'unknown';
  /** Effective interval for the current source. */
  intervalMs: number;
  schedules: Record<string, LiveSchedule>;
  setSource: (mode: QuotaSourceMode) => void;
  setIntervalMs: (value: number) => void;
  recordSuccess: (key: string, now?: number, data?: LiveSchedule['data']) => void;
  recordFailure: (
    key: string,
    error: { status?: number; message: string; retryAfterMs?: number | null },
    now?: number
  ) => void;
}

export const useQuotaLiveStore = create<QuotaLiveState>((set, get) => ({
  source: 'unknown',
  intervalMs: readStoredLiveInterval('direct'),
  schedules: {},
  setSource: (mode) => {
    if (get().source === mode) return;
    const intervalMs = readStoredLiveInterval(mode);
    set((state) => ({
      source: mode,
      intervalMs,
      schedules: rescheduled(state.schedules, intervalMs),
    }));
  },
  setIntervalMs: (value) => {
    const mode = get().source === 'plugin' ? 'plugin' : 'direct';
    if (!isLiveInterval(value, mode)) return;
    writeStoredLiveInterval(mode, value);
    set((state) => ({ intervalMs: value, schedules: rescheduled(state.schedules, value) }));
  },
  recordSuccess: (key, now = Date.now(), data) =>
    set((state) => ({
      schedules: {
        ...state.schedules,
        [key]: scheduleAfterSuccess(now, get().intervalMs, Math.random, data),
      },
    })),
  recordFailure: (key, error, now = Date.now()) =>
    set((state) => ({
      schedules: {
        ...state.schedules,
        [key]: scheduleAfterFailure(state.schedules[key], now, get().intervalMs, error),
      },
    })),
}));
