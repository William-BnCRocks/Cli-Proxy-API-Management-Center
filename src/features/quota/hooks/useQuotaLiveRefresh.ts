/**
 * Automatic quota loading for the quota page.
 *
 * - On open, every credential on the current page is loaded without a click.
 * - After that each one refreshes on the chosen interval, a few at a time
 *   (LIVE_CONCURRENCY), skipping while the tab is hidden.
 * - A refresh failure keeps the last good data on the card and backs the
 *   credential off (429 harder), so a rate-limited account is not hammered.
 *
 * Scheduling rules live in ../liveRefresh.ts; this file only wires them to the
 * quota cache and a 1-second tick.
 */

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { captureQuotaCacheGeneration, commitIfQuotaCacheCurrent } from '@/stores';
import { getStatusFromError } from '@/utils/quota';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import { isLiveDue, pickDueKeys, LIVE_CONCURRENCY } from '../liveRefresh';
import { isPluginBackedType } from '../pluginCards';
import { currentLiveKey, useQuotaLiveStore } from '../liveStore';
import type { QuotaFileEntry } from '../logic';
import { QUOTA_ADAPTERS, getQuotaMap, getQuotaSetter } from '../providers';
import { enrichQuotaInBackground } from '../quotaEnrichment';

/** Module-level so a remount (tab switch, page change) cannot start a duplicate fetch. */
const inFlight = new Set<string>();

const TICK_MS = 1000;

export function useQuotaLiveRefresh(entries: QuotaFileEntry[], enabled: boolean) {
  const { t } = useTranslation();

  useEffect(() => {
    if (!enabled || entries.length === 0) return;

    const fetchOne = async (entry: QuotaFileEntry, key: string) => {
      const adapter = QUOTA_ADAPTERS[entry.type];
      const file = entry.file;
      const cacheKey = getQuotaCacheKey(file);
      const setQuota = getQuotaSetter(adapter);
      const generation = captureQuotaCacheGeneration(file.name);
      const hasData = () => getQuotaMap(adapter)[cacheKey]?.status === 'success';

      // Skeleton only for a card that has nothing to show yet; refreshes stay silent.
      const existing = getQuotaMap(adapter)[cacheKey];
      if (!existing || existing.status === 'idle') {
        commitIfQuotaCacheCurrent(generation, () =>
          setQuota((prev) => ({ ...prev, [cacheKey]: adapter.buildLoadingState() }))
        );
      }

      inFlight.add(key);
      try {
        const data = await adapter.fetchQuota(file, t);
        commitIfQuotaCacheCurrent(generation, () => {
          const state = adapter.buildSuccessState(data);
          setQuota((prev) => ({ ...prev, [cacheKey]: state }));
          void enrichQuotaInBackground(adapter, file, data, state, t);
          useQuotaLiveStore.getState().recordSuccess(key);
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : t('common.unknown_error');
        const status = getStatusFromError(err);
        const retryAfterMs =
          typeof err === 'object' && err !== null && 'retryAfterMs' in err
            ? Number((err as { retryAfterMs?: unknown }).retryAfterMs)
            : undefined;
        commitIfQuotaCacheCurrent(generation, () => {
          if (!hasData()) {
            setQuota((prev) => ({ ...prev, [cacheKey]: adapter.buildErrorState(message, status) }));
          }
          useQuotaLiveStore.getState().recordFailure(key, { status, message, retryAfterMs });
        });
      } finally {
        inFlight.delete(key);
      }
    };

    const tick = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      if (inFlight.size >= LIVE_CONCURRENCY) return;
      const { intervalMs, schedules, source } = useQuotaLiveStore.getState();
      const now = Date.now();
      const byKey = new Map<string, QuotaFileEntry>();
      const candidates = entries
        // Claude/Codex/xAI numbers come from the account-pool cache when it exists, and are not
        // fetched directly until the probe has said which source applies.
        .filter((entry) => !entry.file.disabled)
        .filter((entry) => source === 'direct' || !isPluginBackedType(entry.type))
        .map((entry) => {
          const key = currentLiveKey(entry.type, getQuotaCacheKey(entry.file));
          byKey.set(key, entry);
          const schedule = schedules[key];
          const state = getQuotaMap(QUOTA_ADAPTERS[entry.type])[getQuotaCacheKey(entry.file)];
          return { key, schedule, due: isLiveDue(schedule, now, intervalMs, state) };
        });
      for (const key of pickDueKeys(candidates, inFlight)) {
        const entry = byKey.get(key);
        if (entry) void fetchOne(entry, key);
      }
    };

    tick();
    const timer = window.setInterval(tick, TICK_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [enabled, entries, t]);
}
