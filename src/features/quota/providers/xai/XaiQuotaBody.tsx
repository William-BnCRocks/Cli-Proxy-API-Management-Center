/**
 * xAI 额度渲染体：套餐 chip 行（SuperGrok Heavy / 付费档=金卡）、
 * 周/月账单水位条、按量付费余额。
 */

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { XaiBillingSummary, XaiQuotaState } from '@/types';
import { formatCompactNumber } from '@/utils/format';
import {
  buildResetDisplay,
  formatInstantShort,
  formatQuotaResetTime,
  parseIsoToMs,
} from '@/utils/quota';
import { useNow } from '@/hooks/useNow';
import { QuotaMeter } from '../../components/QuotaMeter';
import { QuotaResetLabel } from '../../components/QuotaResetLabel';
import { XAI_WEEKLY_ROW_ID, collectQuotaRowInstants, pickUrgentRowId } from '../../resetSchedule';
import type { QuotaBodyProps } from '../../types';
import styles from './XaiQuotaBody.module.scss';

const formatUsdFromCents = (cents: number | null): string => {
  if (cents === null) return '--';
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
  }).format(cents / 100);
};

const formatXaiRemainingAmount = (billing: XaiBillingSummary): string => {
  const remainingCents =
    billing.monthlyLimitCents !== null && billing.includedUsedCents !== null
      ? Math.max(0, billing.monthlyLimitCents - billing.includedUsedCents)
      : null;
  const remaining = formatUsdFromCents(remainingCents);
  const limit = formatUsdFromCents(billing.monthlyLimitCents);
  if (billing.monthlyLimitCents === null) return remaining;
  return `${remaining} / ${limit}`;
};

const formatXaiOnDemandAmount = (billing: XaiBillingSummary): string => {
  const remainingCents =
    billing.onDemandCapCents !== null && billing.onDemandUsedCents !== null
      ? Math.max(0, billing.onDemandCapCents - billing.onDemandUsedCents)
      : null;
  const remaining = formatUsdFromCents(remainingCents);
  const cap = formatUsdFromCents(billing.onDemandCapCents);
  if (billing.onDemandCapCents === null) return remaining;
  return `${remaining} / ${cap}`;
};

const formatXaiPercent = (value: number | null): string => {
  if (value === null) return '--';
  return `${Math.round(value)}%`;
};

/** `remaining/limit`; an unknown half renders as a dash. Null when neither is known. */
const formatHeadroom = (remaining: number | null, limit: number | null): string | null => {
  if (remaining === null && limit === null) return null;
  const part = (value: number | null) => (value === null ? '--' : formatCompactNumber(value));
  return `${part(remaining)}/${part(limit)}`;
};

const XAI_SUPERGROK_LIMIT_CENTS = 15_000;
const XAI_SUPERGROK_HEAVY_LIMIT_CENTS = 150_000;

const planValueClass = (
  tier: XaiBillingSummary['planTier'],
  classes: QuotaBodyProps<XaiQuotaState>['classes']
) => {
  if (tier === 'elite') return classes.elitePlanValue;
  if (tier === 'premium') return classes.premiumPlanValue;
  return classes.codexPlanValue;
};

const resolveXaiPlan = (
  monthlyLimitCents: number | null
): { labelKey: string; premium: boolean } | null => {
  if (monthlyLimitCents === XAI_SUPERGROK_LIMIT_CENTS) {
    return { labelKey: 'plan_supergrok', premium: false };
  }
  if (monthlyLimitCents === XAI_SUPERGROK_HEAVY_LIMIT_CENTS) {
    return { labelKey: 'plan_supergrok_heavy', premium: true };
  }
  return null;
};

export function XaiQuotaBody({ quota, classes }: QuotaBodyProps<XaiQuotaState>) {
  const { t, i18n } = useTranslation();
  // Ahead of the early return below — hooks cannot be conditional.
  const now = useNow();
  const locale = i18n.resolvedLanguage;
  // Only the weekly limit is a quota window; the monthly figure is a billing
  // cycle, so it is never the row that "recovers first".
  const weeklySoon = useMemo(
    () => pickUrgentRowId(collectQuotaRowInstants('xai', quota), now) === XAI_WEEKLY_ROW_ID,
    [quota, now]
  );
  const billing = quota.billing;

  if (!billing) {
    return <div className={classes.quotaMessage}>{t('xai_quota.empty_data')}</div>;
  }

  if (billing.mode === 'paid-health') {
    return (
      <>
        <div className={classes.codexPlan}>
          <span className={classes.codexPlanLabel}>{t('xai_quota.plan_label')}</span>
          <span
            className={
              billing.planLabel
                ? planValueClass(billing.planTier, classes)
                : classes.premiumPlanValue
            }
          >
            {billing.planLabel ?? t('xai_quota.plan_paid')}
          </span>
        </div>
        <div className={classes.quotaMessage}>{t('xai_quota.paid_health')}</div>
      </>
    );
  }

  const clampedUsed =
    billing.usedPercent === null ? null : Math.max(0, Math.min(100, billing.usedPercent));
  const remaining = clampedUsed === null ? null : Math.max(0, Math.min(100, 100 - clampedUsed));
  const percentLabel = formatXaiPercent(remaining);
  const amountLabel = formatXaiRemainingAmount(billing);
  const resetLabel = formatQuotaResetTime(billing.billingPeriodEnd);
  // The monthly row is a billing cycle, so it carries no resetAtMs (that field
  // is derived from periodEnd, the weekly quota window). Parse for the
  // countdown; the summary keeps the two periods deliberately distinct.
  const monthlyResetDisplay = buildResetDisplay(
    resetLabel,
    parseIsoToMs(billing.billingPeriodEnd),
    now,
    locale
  );
  const onDemandCap = billing.onDemandCapCents ?? 0;
  const clampedOnDemandUsed =
    billing.onDemandUsedPercent === null
      ? null
      : Math.max(0, Math.min(100, billing.onDemandUsedPercent));
  const onDemandRemaining =
    clampedOnDemandUsed === null ? null : Math.max(0, Math.min(100, 100 - clampedOnDemandUsed));
  const onDemandPercentLabel = formatXaiPercent(onDemandRemaining);
  const onDemandAmountLabel = formatXaiOnDemandAmount(billing);
  const plan = resolveXaiPlan(billing.monthlyLimitCents);
  const weeklyUsed =
    billing.periodType === 'weekly' && billing.usagePercent !== null
      ? Math.max(0, Math.min(100, billing.usagePercent))
      : null;
  const weeklyRemaining = weeklyUsed === null ? null : Math.max(0, Math.min(100, 100 - weeklyUsed));
  const weeklyResetLabel = formatQuotaResetTime(billing.periodEnd);
  const weeklyResetDisplay = buildResetDisplay(
    weeklyResetLabel === '-' ? null : t('xai_quota.reset_at', { time: weeklyResetLabel }),
    billing.resetAtMs,
    now,
    locale
  );
  const hasWeeklyData =
    billing.periodType === 'weekly' &&
    (weeklyUsed !== null || Boolean(billing.periodEnd) || billing.productUsage.length > 0);
  // The proxy's own counters (account-pool): shown as counts, never as a share of an xAI allowance.
  const measured = billing.measured ?? null;
  const measuredParts: string[] = [];
  if (measured) {
    measuredParts.push(
      t('xai_quota.measured_input', { value: formatCompactNumber(measured.inputTokens) }),
      t('xai_quota.measured_output', { value: formatCompactNumber(measured.outputTokens) })
    );
    if (measured.reasoningTokens > 0) {
      measuredParts.push(
        t('xai_quota.measured_reasoning', { value: formatCompactNumber(measured.reasoningTokens) })
      );
    }
    if (measured.cacheReadTokens > 0 || measured.cacheWriteTokens > 0) {
      measuredParts.push(
        t('xai_quota.measured_cache', {
          read: formatCompactNumber(measured.cacheReadTokens),
          write: formatCompactNumber(measured.cacheWriteTokens),
        })
      );
    }
    measuredParts.push(
      t('xai_quota.measured_failed', { n: measured.failed }),
      t('xai_quota.measured_rate_limited', { n: measured.rateLimited })
    );
    if (measured.sinceMs !== null) {
      measuredParts.push(
        t('xai_quota.measured_since', { time: formatInstantShort(measured.sinceMs) })
      );
    }
  }
  const measuredDetail = measuredParts.join(' · ');
  const measuredTitle = measured ? `${measuredDetail}\n${t('xai_quota.measured_hint')}` : undefined;
  const rateLimit = billing.rateLimit ?? null;
  const headroomRequests = rateLimit
    ? formatHeadroom(rateLimit.remainingRequests, rateLimit.limitRequests)
    : null;
  const headroomTokens = rateLimit
    ? formatHeadroom(rateLimit.remainingTokens, rateLimit.limitTokens)
    : null;
  const rateLimitLine =
    headroomRequests === null && headroomTokens === null
      ? null
      : t('xai_quota.rate_limit_line', {
          value: [
            headroomRequests === null
              ? null
              : t('xai_quota.rate_limit_requests', { value: headroomRequests }),
            headroomTokens === null
              ? null
              : t('xai_quota.rate_limit_tokens', { value: headroomTokens }),
          ]
            .filter((part) => part !== null)
            .join(' · '),
        });
  const hasMonthlyData =
    (billing.monthlyLimitCents !== null ||
      billing.usedCents !== null ||
      Boolean(billing.billingPeriodEnd)) &&
    !(hasWeeklyData && billing.monthlyLimitCents === 0 && billing.usedCents === 0);

  const subscriptionLabel = billing.planLabel ?? (plan ? t(`xai_quota.${plan.labelKey}`) : null);
  const subscriptionClass = billing.planLabel
    ? planValueClass(billing.planTier, classes)
    : plan?.premium
      ? classes.premiumPlanValue
      : classes.codexPlanValue;
  const headerReset = buildResetDisplay(
    null,
    hasWeeklyData ? billing.resetAtMs : parseIsoToMs(billing.billingPeriodEnd),
    now,
    locale
  );

  return (
    <>
      {(subscriptionLabel || headerReset) && (
        <div className={classes.codexPlan}>
          {subscriptionLabel && (
            <span className={classes.codexPlanItem}>
              <span className={classes.codexPlanLabel}>{t('xai_quota.plan_label')}</span>
              <span className={subscriptionClass}>{subscriptionLabel}</span>
            </span>
          )}
          {headerReset && (
            <span className={classes.codexPlanItem}>
              <span className={classes.codexPlanLabel}>{t('xai_quota.resets_label')}</span>
              <span className={classes.codexPlanValue}>{headerReset.absolute}</span>
              {headerReset.relative && (
                <span className={classes.quotaResetRelative}>{headerReset.relative}</span>
              )}
            </span>
          )}
        </div>
      )}
      {typeof billing.prepaidBalanceCents === 'number' && billing.prepaidBalanceCents > 0 && (
        <div className={classes.codexPlan}>
          <span className={classes.codexPlanLabel}>{t('xai_quota.prepaid')}</span>
          <span className={classes.quotaAmount}>
            {formatUsdFromCents(billing.prepaidBalanceCents)}
          </span>
        </div>
      )}
      {hasWeeklyData && (
        <div
          className={classes.quotaRow}
          title={weeklySoon ? t('quota_management.soonest_row_hint') : undefined}
        >
          <div className={classes.quotaRowHeader}>
            <span className={classes.quotaModel}>{t('xai_quota.weekly_limit')}</span>
            <div className={classes.quotaMeta}>
              <span className={classes.quotaPercent}>
                {weeklyUsed === null
                  ? t(measured ? 'xai_quota.usage_not_reported' : 'xai_quota.usage_unavailable')
                  : t('xai_quota.used_percent', { percent: formatXaiPercent(weeklyUsed) })}
              </span>
              {weeklyResetDisplay && (
                <QuotaResetLabel display={weeklyResetDisplay} classes={classes} soon={weeklySoon} />
              )}
            </div>
          </div>
          {weeklyRemaining !== null && (
            <QuotaMeter percent={weeklyRemaining} classes={classes} index={0} />
          )}
        </div>
      )}
      {(measured || rateLimitLine) && (
        <div className={classes.quotaRow} title={measuredTitle}>
          {measured && (
            <>
              <div className={classes.quotaRowHeader}>
                <span className={classes.quotaModel}>
                  {t(
                    billing.periodType === 'weekly'
                      ? 'xai_quota.measured_label_week'
                      : 'xai_quota.measured_label_period'
                  )}
                </span>
                <div className={classes.quotaMeta}>
                  <span className={classes.quotaAmount}>
                    {t('xai_quota.measured_summary', {
                      count: measured.requests,
                      requests: formatCompactNumber(measured.requests),
                      tokens: formatCompactNumber(measured.totalTokens),
                    })}
                  </span>
                </div>
              </div>
              <div className={styles.rowDetail}>{measuredDetail}</div>
            </>
          )}
          {rateLimitLine && <div className={styles.rowDetail}>{rateLimitLine}</div>}
        </div>
      )}
      {billing.productUsage.map((item, index) => {
        const used =
          item.usagePercent === null ? null : Math.max(0, Math.min(100, item.usagePercent));
        const remainingPercent = used === null ? null : Math.max(0, Math.min(100, 100 - used));
        return (
          <div key={`product-${item.product}`} className={classes.quotaRow}>
            <div className={classes.quotaRowHeader}>
              <span className={classes.quotaModel}>
                {t('xai_quota.product_usage', { product: item.product })}
              </span>
              <div className={classes.quotaMeta}>
                <span className={classes.quotaPercent}>
                  {t('xai_quota.used_percent', {
                    percent: formatXaiPercent(used),
                  })}
                </span>
              </div>
            </div>
            <QuotaMeter percent={remainingPercent} classes={classes} index={index + 1} />
          </div>
        );
      })}
      {onDemandCap > 0 ? (
        <div className={classes.quotaRow}>
          <div className={classes.quotaRowHeader}>
            <span className={classes.quotaModel}>{t('xai_quota.pay_as_you_go_label')}</span>
            <div className={classes.quotaMeta}>
              <span className={classes.quotaPercent}>{onDemandPercentLabel}</span>
              <span className={classes.quotaAmount}>{onDemandAmountLabel}</span>
            </div>
          </div>
          <QuotaMeter
            percent={onDemandRemaining}
            classes={classes}
            index={billing.productUsage.length + 1}
          />
        </div>
      ) : (
        <div className={classes.codexPlan}>
          <span className={classes.codexPlanLabel}>{t('xai_quota.pay_as_you_go_label')}</span>
          <span className={classes.codexPlanValue}>{t('xai_quota.pay_as_you_go_disabled')}</span>
        </div>
      )}
      {hasMonthlyData && (
        <div className={classes.quotaRow}>
          <div className={classes.quotaRowHeader}>
            <span className={classes.quotaModel}>{t('xai_quota.monthly_credits')}</span>
            <div className={classes.quotaMeta}>
              <span className={classes.quotaPercent}>{percentLabel}</span>
              <span className={classes.quotaAmount}>{amountLabel}</span>
              {monthlyResetDisplay && (
                <QuotaResetLabel display={monthlyResetDisplay} classes={classes} />
              )}
            </div>
          </div>
          <QuotaMeter
            percent={remaining}
            classes={classes}
            index={billing.productUsage.length + 2}
          />
        </div>
      )}
    </>
  );
}
