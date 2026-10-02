/**
 * Decides where Claude/Codex numbers come from and, when the claude-pool plugin
 * is there, keeps them fresh from its in-memory cache.
 *
 * - First call on page open is the probe: GET .../quota/cards. 200 with the
 *   documented shape = plugin mode; anything else = direct mode for this visit
 *   (and the direct engine, with its 2-minute default, takes over).
 * - In plugin mode the cards are re-read on the chosen interval. That costs the
 *   upstream nothing, so 30 s / 1 min are offered; hidden tabs are skipped.
 */

import { useEffect } from 'react';
import { apiClient } from '@/services/api/client';
import { useQuotaLiveStore } from '../liveStore';
import { syncPluginCards } from '../pluginSource';

export function usePluginQuotaSource(active: boolean) {
  const source = useQuotaLiveStore((state) => state.source);
  const intervalMs = useQuotaLiveStore((state) => state.intervalMs);

  useEffect(() => {
    if (!active || source === 'direct') return;
    const revision = apiClient.getConnectionRevision();
    let cancelled = false;
    let timer: number | undefined;

    const schedule = () => {
      if (cancelled || intervalMs <= 0) return;
      timer = window.setTimeout(() => void run(), intervalMs);
    };
    const run = async () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        schedule();
        return;
      }
      const response = await syncPluginCards();
      if (cancelled || revision !== apiClient.getConnectionRevision()) return;
      if (!response) {
        // Probe failed -> direct mode. A later transient failure keeps plugin mode and retries.
        if (useQuotaLiveStore.getState().source === 'unknown') {
          useQuotaLiveStore.getState().setSource('direct');
          return;
        }
        schedule();
        return;
      }
      useQuotaLiveStore.getState().setSource('plugin');
      schedule();
    };

    const onVisible = () => {
      if (document.visibilityState === 'visible' && source === 'plugin') {
        if (timer !== undefined) window.clearTimeout(timer);
        void run();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    void run();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [active, source, intervalMs]);
}
