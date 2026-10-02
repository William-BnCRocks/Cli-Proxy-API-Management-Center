import { useEffect, useState } from 'react';
import { apiClient } from '@/services/api/client';
import { fetchClaudePoolStatus, type ClaudePoolStatus } from '../claudePool';

/**
 * Optional claude-pool status. Polled at the page's live cadence (it is a local
 * plugin call, not an upstream one) and abandoned for the visit after the first
 * failure so an absent plugin costs one request, not one per minute.
 */
export function useClaudePoolStatus(active: boolean, intervalMs: number): ClaudePoolStatus | null {
  const [status, setStatus] = useState<ClaudePoolStatus | null>(null);

  useEffect(() => {
    if (!active) return;
    const revision = apiClient.getConnectionRevision();
    let cancelled = false;
    let timer: number | undefined;
    const load = async () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        schedule();
        return;
      }
      const next = await fetchClaudePoolStatus();
      if (cancelled || revision !== apiClient.getConnectionRevision()) return;
      setStatus(next);
      if (next) schedule();
    };
    const schedule = () => {
      timer = window.setTimeout(() => void load(), intervalMs > 0 ? intervalMs : 60_000);
    };
    void load();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [active, intervalMs]);

  return active ? status : null;
}
