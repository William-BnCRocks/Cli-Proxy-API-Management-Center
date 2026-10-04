/**
 * OpenCode Go usage panel on the Quota page.
 *
 * An estimate: proxy-recorded tokens priced at OpenCode Go's list prices and set
 * against Go's per-model caps. Never presented as official usage. Per model:
 * three meters (5-hour / weekly / monthly) for capped models, a plain usage line
 * for uncapped ones, tokens and "price unknown" for unpriced ones. The plugin
 * already sorts the most constrained model first; the order is kept.
 *
 * Bodies take their class map as a prop (no stylesheet import for the shared
 * rows), so tests render this directly; the connected wrapper binds it.
 */

import { useTranslation } from 'react-i18next';
import { IconRefreshCw } from '@/components/ui/icons';
import { formatCompactNumber } from '@/utils/format';
import { formatInstantShort } from '@/utils/quota';
import {
  windowRemainingPercent,
  type OpencodeGoData,
  type OpencodeGoModel,
  type OpencodeGoWindow,
} from '../opencodeGo';
import { agoParts } from '../liveRefresh';
import type { QuotaClassMap } from '../types';
import { QuotaMeter } from './QuotaMeter';
import styles from './OpencodeGoCard.module.scss';

/** At most this many limit events are listed, newest first. */
const MAX_LIMIT_EVENTS = 5;
const MAX_EVENT_MESSAGE_CHARS = 160;

const WINDOW_LABEL_KEYS: Record<string, string> = {
  'five-hour': 'opencode_go.window_five_hour',
  weekly: 'opencode_go.window_weekly',
  monthly: 'opencode_go.window_monthly',
};

const formatUsd = (value: number): string => {
  if (value > 0 && value < 0.01) return '<$0.01';
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(value);
};

const percentText = (value: number): string => `${Math.round(value)}%`;

export interface OpencodeGoCardProps {
  data: OpencodeGoData;
  classes: QuotaClassMap;
  /** Epoch ms for the "updated … ago" footer; omit to leave the footer out. */
  now?: number;
  /** Re-reads the plugin's cards (there is no upstream poll for this card). */
  onRefresh?: () => void;
  refreshing?: boolean;
}

function ModelBlock({
  model,
  classes,
  indexBase,
}: {
  model: OpencodeGoModel;
  classes: QuotaClassMap;
  indexBase: number;
}) {
  const { t } = useTranslation();
  const metered = model.unpriced
    ? []
    : model.windows.filter((window) => window.capUsd !== null && window.usedUsd !== null);
  // Free / uncapped: no meter, just what was used (the monthly window when present).
  const uncapped = !model.unpriced && model.capUsd === null && metered.length === 0;
  const uncappedUsed =
    model.windows.find((window) => window.id === 'monthly')?.usedUsd ??
    model.windows[model.windows.length - 1]?.usedUsd ??
    0;

  const tokenParts = [
    t('opencode_go.tokens_input', { value: formatCompactNumber(model.tokens.input) }),
    t('opencode_go.tokens_output', { value: formatCompactNumber(model.tokens.output) }),
  ];
  if (model.tokens.cacheRead > 0 || model.tokens.cacheWrite > 0) {
    tokenParts.push(
      t('opencode_go.tokens_cache', {
        read: formatCompactNumber(model.tokens.cacheRead),
        write: formatCompactNumber(model.tokens.cacheWrite),
      })
    );
  }
  const usageParts = [
    t('opencode_go.requests', {
      count: model.requests,
      requests: formatCompactNumber(model.requests),
    }),
  ];
  if (model.lastRequestAtMs !== null) {
    usageParts.push(
      t('opencode_go.last_used', { time: formatInstantShort(model.lastRequestAtMs) })
    );
  }

  const windowLabel = (window: OpencodeGoWindow) =>
    WINDOW_LABEL_KEYS[window.id] ? t(WINDOW_LABEL_KEYS[window.id]) : window.label;

  return (
    <article className={styles.model} data-model={model.model}>
      <header className={styles.modelHead}>
        <span className={classes.quotaModel} title={model.model}>
          {model.label}
        </span>
        {model.unpriced ? (
          <span className={styles.tag} title={t('opencode_go.unpriced_hint')}>
            {t('opencode_go.unpriced')}
          </span>
        ) : model.capUsd !== null ? (
          <span className={styles.tag}>
            {t('opencode_go.model_cap', { cap: formatUsd(model.capUsd) })}
          </span>
        ) : (
          <span className={styles.tag}>{t('opencode_go.uncapped')}</span>
        )}
      </header>

      {metered.map((window, index) => {
        const remaining = windowRemainingPercent(window);
        return (
          <div key={window.id} className={classes.quotaRow}>
            <div className={classes.quotaRowHeader}>
              <span className={classes.quotaModel}>{windowLabel(window)}</span>
              <div className={classes.quotaMeta}>
                {remaining !== null && (
                  <span className={classes.quotaPercent}>
                    {t('opencode_go.left_percent', { percent: percentText(remaining) })}
                  </span>
                )}
                <span className={classes.quotaAmount}>
                  {`${formatUsd(window.usedUsd ?? 0)} / ${formatUsd(window.capUsd ?? 0)}`}
                </span>
              </div>
            </div>
            <QuotaMeter percent={remaining} classes={classes} index={indexBase + index} />
          </div>
        );
      })}

      {uncapped && (
        <div className={classes.quotaRowHeader}>
          <span className={classes.quotaModel}>{t('opencode_go.window_monthly')}</span>
          <div className={classes.quotaMeta}>
            <span className={classes.quotaAmount}>
              {t('opencode_go.used_only', { usd: formatUsd(uncappedUsed) })}
            </span>
          </div>
        </div>
      )}

      <div className={styles.detail}>{usageParts.join(' · ')}</div>
      <div className={styles.detail}>{tokenParts.join(' · ')}</div>
    </article>
  );
}

export function OpencodeGoCard({ data, classes, now, onRefresh, refreshing }: OpencodeGoCardProps) {
  const { t } = useTranslation();
  const events = [...data.limitEvents]
    .sort((a, b) => (b.atMs ?? 0) - (a.atMs ?? 0))
    .slice(0, MAX_LIMIT_EVENTS);
  const rule = data.rule;
  const percentOf = (value: number | null) =>
    value === null ? '--' : String(Math.round(value * 100));
  const ageSpan =
    now !== undefined && data.dataAtMs !== null ? agoParts(Math.max(0, now - data.dataAtMs)) : null;

  return (
    <section className={styles.section} aria-label={t('opencode_go.title')}>
      <header className={styles.head}>
        <div className={styles.titleRow}>
          <h3 className={styles.title}>{t('opencode_go.title')}</h3>
          {data.planLabel && (
            <span className={classes.codexPlanItem}>
              <span className={classes.codexPlanLabel}>{t('opencode_go.plan_label')}</span>
              <span className={classes.codexPlanValue}>{data.planLabel}</span>
            </span>
          )}
        </div>
        <p className={styles.note}>{t('opencode_go.estimate_note')}</p>
        <p className={styles.note}>
          {[
            data.pricingAsOf ? t('opencode_go.pricing_as_of', { date: data.pricingAsOf }) : null,
            rule
              ? t('opencode_go.rule', {
                  five: percentOf(rule.fiveHour),
                  weekly: percentOf(rule.weekly),
                  monthly: percentOf(rule.monthly),
                })
              : null,
            data.rolling ? t('opencode_go.rolling') : null,
          ]
            .filter((part) => part !== null)
            .join(' · ')}
        </p>
        {data.totalMonthlyUsd !== null && (
          <p className={styles.total}>
            {t('opencode_go.total_summary', {
              count: data.totalRequests ?? 0,
              usd: formatUsd(data.totalMonthlyUsd),
              requests: formatCompactNumber(data.totalRequests ?? 0),
            })}
          </p>
        )}
      </header>

      {data.models.length === 0 ? (
        <div className={classes.quotaMessage}>{t('opencode_go.no_data')}</div>
      ) : (
        <div className={styles.models}>
          {data.models.map((model, index) => (
            <ModelBlock key={model.model} model={model} classes={classes} indexBase={index * 3} />
          ))}
        </div>
      )}

      {events.length > 0 && (
        <div className={styles.events}>
          <div className={classes.quotaModel}>{t('opencode_go.limit_events')}</div>
          <ul className={styles.eventList}>
            {events.map((event, index) => {
              const message =
                event.message && event.message.length > MAX_EVENT_MESSAGE_CHARS
                  ? `${event.message.slice(0, MAX_EVENT_MESSAGE_CHARS)}…`
                  : event.message;
              return (
                <li key={`${event.atMs ?? 'x'}-${index}`} className={styles.event}>
                  <span className={styles.eventHead}>
                    {[
                      event.atMs === null ? null : formatInstantShort(event.atMs),
                      event.model,
                      event.status === null ? null : `HTTP ${event.status}`,
                    ]
                      .filter((part) => part !== null)
                      .join(' · ')}
                  </span>
                  {message && (
                    <span className={styles.eventMessage} title={event.message ?? undefined}>
                      {message}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {(ageSpan || onRefresh) && (
        <footer className={styles.footer}>
          {ageSpan && (
            <span className={styles.updated}>
              {t('opencode_go.updated', {
                ago: t(`quota_management.live_span_${ageSpan.unit}`, { n: ageSpan.count }),
              })}
            </span>
          )}
          {onRefresh && (
            <button
              type="button"
              className={styles.refresh}
              disabled={refreshing}
              onClick={onRefresh}
            >
              <IconRefreshCw
                size={13}
                aria-hidden="true"
                className={refreshing ? styles.spinning : undefined}
              />
              {t('opencode_go.refresh')}
            </button>
          )}
        </footer>
      )}
    </section>
  );
}
