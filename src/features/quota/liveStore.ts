/**
 * Live-refresh state shared by the quota page, the cards and the manual-refresh
 * paths: the chosen interval plus one `LiveSchedule` per credential.
 *
 * Keys carry the quota cache generation, so a reconnect (which bumps it) starts
 * every credential from a clean slate without an explicit reset.
 */

import { create } from 'zustand';
import { useQuotaStore } from '@/stores/useQuotaStore';
import {
  DEFAULT_LIVE_INTERVAL_MS,
  isLiveInterval,
  scheduleAfterFailure,
  scheduleAfterSuccess,
  type LiveSchedule,
} from './liveRefresh';

const INTERVAL_STORAGE_KEY = 'quotaPage.liveIntervalMs';

export const readStoredLiveInterval = (): number => {
  if (typeof window === 'undefined') return DEFAULT_LIVE_INTERVAL_MS;
  try {
    const raw = window.localStorage.getItem(INTERVAL_STORAGE_KEY);
    if (raw === null) return DEFAULT_LIVE_INTERVAL_MS;
    const value = Number(raw);
    return isLiveInterval(value) ? value : DEFAULT_LIVE_INTERVAL_MS;
  } catch {
    return DEFAULT_LIVE_INTERVAL_MS;
  }
};

const writeStoredLiveInterval = (value: number) => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(INTERVAL_STORAGE_KEY, String(value));
  } catch {
    // ignore
  }
};

export const liveKey = (generation: number, type: string, cacheKey: string): string =>
  `${generation}:${type}:${cacheKey}`;

/** Key for a credential under the current cache generation. */
export const currentLiveKey = (type: string, cacheKey: string): string =>
  liveKey(useQuotaStore.getState().cacheGeneration, type, cacheKey);

interface QuotaLiveState {
  intervalMs: number;
  schedules: Record<string, LiveSchedule>;
  setIntervalMs: (value: number) => void;
  recordSuccess: (key: string, now?: number) => void;
  recordFailure: (
    key: string,
    error: { status?: number; message: string; retryAfterMs?: number | null },
    now?: number
  ) => void;
}

export const useQuotaLiveStore = create<QuotaLiveState>((set, get) => ({
  intervalMs: readStoredLiveInterval(),
  schedules: {},
  setIntervalMs: (value) => {
    if (!isLiveInterval(value)) return;
    writeStoredLiveInterval(value);
    set((state) => {
      // Healthy credentials follow the new cadence at once instead of waiting
      // out the old (possibly 5-minute) delay; backed-off ones keep their delay.
      const schedules: Record<string, LiveSchedule> = {};
      for (const [key, schedule] of Object.entries(state.schedules)) {
        schedules[key] =
          schedule.failures === 0 && schedule.updatedAt !== undefined
            ? {
                ...schedule,
                nextAt: value > 0 ? schedule.updatedAt + value : Number.MAX_SAFE_INTEGER,
              }
            : schedule;
      }
      return { intervalMs: value, schedules };
    });
  },
  recordSuccess: (key, now = Date.now()) =>
    set((state) => ({
      schedules: { ...state.schedules, [key]: scheduleAfterSuccess(now, get().intervalMs) },
    })),
  recordFailure: (key, error, now = Date.now()) =>
    set((state) => ({
      schedules: {
        ...state.schedules,
        [key]: scheduleAfterFailure(state.schedules[key], now, get().intervalMs, error),
      },
    })),
}));
