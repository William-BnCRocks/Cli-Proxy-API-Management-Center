/**
 * "Updated 12s ago" / "retrying in 40s" line in a quota card footer.
 * Reads the credential's live schedule; ticks every few seconds from a shared clock.
 */

import { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { createSharedClock } from '@/utils/time/sharedClock';
import { agoParts, type AgoParts } from '../liveRefresh';
import { useQuotaLiveStore } from '../liveStore';

/** Coarse on purpose: the label only has to be right to within a few seconds. */
const LIVE_STATUS_CLOCK = createSharedClock({ intervalMs: 5000 });
const frozenNow = Date.now();

export interface QuotaLiveStatusProps {
  liveKey: string;
  className?: string;
  errorClassName?: string;
}

export function QuotaLiveStatus({ liveKey, className, errorClassName }: QuotaLiveStatusProps) {
  const { t } = useTranslation();
  const now = useSyncExternalStore(
    LIVE_STATUS_CLOCK.subscribe,
    LIVE_STATUS_CLOCK.getSnapshot,
    () => frozenNow
  );
  const schedule = useQuotaLiveStore((state) => state.schedules[liveKey]);
  const intervalMs = useQuotaLiveStore((state) => state.intervalMs);

  const span = (parts: AgoParts) =>
    t(`quota_management.live_span_${parts.unit}`, { n: parts.count });

  if (schedule && schedule.failures > 0 && schedule.lastError) {
    const wait = Math.max(0, schedule.nextAt - now);
    const message =
      schedule.lastError.status === 429
        ? t('quota_management.live_rate_limited', { wait: span(agoParts(wait)) })
        : t('quota_management.live_failed', { wait: span(agoParts(wait)) });
    return (
      <span
        className={errorClassName ?? className}
        role="status"
        title={schedule.lastError.message}
      >
        {schedule.updatedAt !== undefined
          ? `${message} · ${t('quota_management.live_updated', {
              ago: span(agoParts(now - schedule.updatedAt)),
            })}`
          : message}
      </span>
    );
  }

  if (!schedule || schedule.updatedAt === undefined) return null;

  // Plugin mode: say how old the cached reading is and whether it came from a poll or from traffic.
  if (schedule.data) {
    const dataAge = Math.max(0, now - schedule.data.at);
    const key =
      schedule.data.source === 'passive'
        ? 'quota_management.live_from_traffic'
        : 'quota_management.live_polled';
    return (
      <span className={className} title={t('quota_management.live_plugin_hint')}>
        {t(key, { ago: span(agoParts(dataAge)) })}
      </span>
    );
  }
  const age = Math.max(0, now - schedule.updatedAt);
  return (
    <span
      className={className}
      title={intervalMs > 0 ? undefined : t('quota_management.live_paused_hint')}
    >
      {age < 5000
        ? t('quota_management.live_updated_now')
        : t('quota_management.live_updated', { ago: span(agoParts(age)) })}
    </span>
  );
}
