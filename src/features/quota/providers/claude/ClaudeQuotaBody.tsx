/**
 * Claude 额度渲染体：套餐/续费/额外用量 chip 行 + 重置明细 + 用量窗口水位条 + 美元额度条。
 * 信息密度对齐 Codex：计划、续费日、额度余额、重置到期、各窗口剩余（"X% left"）。
 */

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { ClaudeQuotaState, ClaudeQuotaWindow } from '@/types';
import { buildResetDisplay, formatInstantShort, parseIsoToMs } from '@/utils/quota';
import { resolveTimeZoneLabel } from '@/utils/time/timezone';
import { useNow } from '@/hooks/useNow';
import { QuotaMeter } from '../../components/QuotaMeter';
import { QuotaResetLabel } from '../../components/QuotaResetLabel';
import { collectQuotaRowInstants, pickUrgentRowId } from '../../resetSchedule';
import type { QuotaBodyProps, QuotaClassMap } from '../../types';
import { formatMoney, resolveClaudeCredit } from './account';
import styles from './ClaudeQuotaBody.module.scss';

/** The 7-day account window is the one the account-pool plan applies to. */
const PACE_WINDOW_ID = 'seven-day';

const clampPercent = (value: number) => Math.max(0, Math.min(100, value));

/** Max 20x gets the platinum badge, Max 5x/Max the gold one (mirrors Codex Pro 20x / Pro Lite). */
const getPlanValueClass = (planType: string | null, classes: QuotaClassMap): string => {
  if (planType === 'plan_max20') return classes.elitePlanValue;
  if (planType === 'plan_max5' || planType === 'plan_max') return classes.premiumPlanValue;
  return classes.codexPlanValue;
};

export function ClaudeQuotaBody({ quota, classes, accountPool }: QuotaBodyProps<ClaudeQuotaState>) {
  const { t, i18n } = useTranslation();
  const now = useNow();
  const locale = i18n.resolvedLanguage;
  const soonestRowId = useMemo(
    () => pickUrgentRowId(collectQuotaRowInstants('claude', quota), now),
    [quota, now]
  );
  const windows = quota.windows ?? [];
  const budgets = quota.budgets ?? [];
  const planType = quota.planType ?? null;
  const subscription = quota.subscription ?? null;
  const breakdown = quota.breakdown ?? [];
  const credit = useMemo(
    () => resolveClaudeCredit(quota.extraUsage, quota.spend),
    [quota.extraUsage, quota.spend]
  );
  const grants = (quota.resetGrants?.grants ?? []).filter((grant) => grant.resetsLeft > 0);
  const resetsLeft = quota.resetGrants
    ? quota.resetGrants.grants.reduce((sum, grant) => sum + grant.resetsLeft, 0)
    : null;

  const renewal = subscription?.renewsAtMs
    ? buildResetDisplay(null, subscription.renewsAtMs, now, locale)
    : null;
  const trial = subscription?.trialEndsAtMs
    ? buildResetDisplay(null, subscription.trialEndsAtMs, now, locale)
    : null;
  const subscriptionStatus =
    subscription?.status && subscription.status.toLowerCase() !== 'active'
      ? subscription.status.replace(/_/g, ' ')
      : null;

  const money = (amount: number) => formatMoney(amount, credit?.currency, locale);
  const creditValue = !credit
    ? null
    : !credit.enabled
      ? t('claude_quota.extra_usage_off')
      : credit.balance !== null && credit.limit === null
        ? money(credit.balance)
        : credit.used !== null && credit.limit !== null
          ? t('claude_quota.credit_used_of', {
              used: money(credit.used),
              limit: money(credit.limit),
            })
          : credit.used !== null
            ? t('claude_quota.credit_used', { used: money(credit.used) })
            : t('claude_quota.extra_usage_on');
  const creditLabel =
    credit?.enabled && credit.balance !== null && credit.limit === null
      ? t('claude_quota.credit_balance_label')
      : t('claude_quota.extra_usage_label');

  const percentLeft = (usedPercent: number | null) => {
    const clampedUsed = usedPercent === null ? null : clampPercent(usedPercent);
    const remaining = clampedUsed === null ? null : clampPercent(100 - clampedUsed);
    return {
      remaining,
      label:
        remaining === null
          ? '--'
          : t('quota_management.percent_left', { percent: Math.round(remaining) }),
    };
  };

  const renderRow = (
    row: Pick<ClaudeQuotaWindow, 'id' | 'usedPercent' | 'resetLabel' | 'resetAtMs'>,
    label: string,
    index: number,
    extra?: { detail?: string; marker?: number | null; markerLabel?: string }
  ) => {
    const { remaining, label: percentLabel } = percentLeft(row.usedPercent);
    const resetDisplay = buildResetDisplay(row.resetLabel, row.resetAtMs, now, locale);
    const soon = row.id === soonestRowId;
    return (
      <div
        key={row.id}
        className={classes.quotaRow}
        title={soon ? t('quota_management.soonest_row_hint') : undefined}
      >
        <div className={classes.quotaRowHeader}>
          <span className={classes.quotaModel}>{label}</span>
          <div className={classes.quotaMeta}>
            <span className={classes.quotaPercent}>{percentLabel}</span>
            {resetDisplay && (
              <QuotaResetLabel display={resetDisplay} classes={classes} soon={soon} />
            )}
          </div>
        </div>
        <QuotaMeter
          percent={remaining}
          classes={classes}
          index={index}
          marker={extra?.marker}
          markerLabel={extra?.markerLabel}
        />
        {extra?.detail && <div className={styles.rowDetail}>{extra.detail}</div>}
      </div>
    );
  };

  const hasChips =
    planType ||
    renewal ||
    trial ||
    subscriptionStatus ||
    creditValue ||
    resetsLeft !== null ||
    accountPool?.rank;

  return (
    <>
      {hasChips && (
        <div className={classes.codexPlan}>
          {planType && (
            <span className={classes.codexPlanItem}>
              <span className={classes.codexPlanLabel}>{t('claude_quota.plan_label')}</span>
              <span className={getPlanValueClass(planType, classes)}>
                {t(`claude_quota.${planType}`)}
              </span>
            </span>
          )}
          {subscriptionStatus && (
            <span className={classes.codexPlanItem}>
              <span className={classes.codexPlanLabel}>{t('claude_quota.status_label')}</span>
              <span className={classes.codexPlanValue}>{subscriptionStatus}</span>
            </span>
          )}
          {renewal && (
            <span className={classes.codexPlanItem} title={t('claude_quota.renews_hint')}>
              <span className={classes.codexPlanLabel}>{t('claude_quota.renews_label')}</span>
              <span className={classes.codexPlanValue}>{renewal.absolute}</span>
              {renewal.relative && (
                <span className={classes.quotaResetRelative}>{renewal.relative}</span>
              )}
            </span>
          )}
          {trial && (
            <span className={classes.codexPlanItem}>
              <span className={classes.codexPlanLabel}>{t('claude_quota.trial_ends_label')}</span>
              <span className={classes.codexPlanValue}>{trial.absolute}</span>
              {trial.relative && (
                <span className={classes.quotaResetRelative}>{trial.relative}</span>
              )}
            </span>
          )}
          {creditValue && (
            <span className={classes.codexPlanItem}>
              <span className={classes.codexPlanLabel}>{creditLabel}</span>
              <span className={classes.codexPlanValue}>{creditValue}</span>
              {credit?.limitReached && (
                <span className={styles.warnTag}>{t('claude_quota.credit_limit_reached')}</span>
              )}
            </span>
          )}
          {resetsLeft !== null && (
            <span className={classes.codexPlanItem}>
              <span className={classes.codexPlanLabel}>{t('claude_reset.remaining')}</span>
              <span className={classes.codexPlanValue}>{resetsLeft}</span>
            </span>
          )}
          {accountPool?.rank != null && (
            <span className={classes.codexPlanItem} title={t('claude_quota.pool_rank_hint')}>
              <span className={classes.codexPlanLabel}>{t('claude_quota.pool_rank_label')}</span>
              <span className={classes.codexPlanValue}>
                {t('claude_quota.pool_rank_value', {
                  rank: accountPool.rank,
                  count: accountPool.rankedCount,
                })}
              </span>
            </span>
          )}
        </div>
      )}
      {accountPool && (accountPool.isNext || !accountPool.eligible) && (
        <div className={styles.badges}>
          {accountPool.isNext && (
            <span className={styles.nextBadge} title={t('claude_quota.pool_next_hint')}>
              {t('claude_quota.pool_next_label')}
            </span>
          )}
          {!accountPool.eligible && (
            <span
              className={styles.mutedBadge}
              title={accountPool.reason ?? accountPool.kind ?? undefined}
            >
              {t('claude_quota.pool_ineligible')}
            </span>
          )}
        </div>
      )}
      {grants.length > 0 && (
        <div className={classes.codexResetCredits}>
          <div className={classes.codexResetCreditsTitle}>
            {t('claude_reset.expiry_title', { timezone: resolveTimeZoneLabel() })}
          </div>
          {grants.map((grant) => {
            const endsAtMs = parseIsoToMs(grant.endsAt);
            const expires =
              endsAtMs === null
                ? null
                : buildResetDisplay(formatInstantShort(endsAtMs), endsAtMs, now, locale);
            return (
              <div key={grant.id} className={classes.codexResetCreditRow} title={grant.label}>
                <span className={classes.codexResetCreditLabel}>
                  {t('claude_reset.grant_row', {
                    left: grant.resetsLeft,
                    total: grant.resetsTotal,
                  })}
                </span>
                <span className={classes.codexResetCreditTime}>
                  {expires ? (
                    <QuotaResetLabel display={expires} classes={classes} soon={false} />
                  ) : (
                    t('claude_reset.no_expiry')
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}
      {windows.length === 0 && budgets.length === 0 ? (
        <div className={classes.quotaMessage}>{t('claude_quota.empty_windows')}</div>
      ) : (
        <>
          {windows.map((window, index) => {
            const label = window.labelKey ? t(window.labelKey) : window.label;
            let detail: string | undefined;
            if (window.limitDollars != null) {
              detail = t('claude_quota.budget_left', {
                left: formatMoney(window.remainingDollars ?? 0, 'USD', locale),
                limit: formatMoney(window.limitDollars, 'USD', locale),
              });
            }
            let marker: number | null | undefined;
            let markerLabel: string | undefined;
            if (
              window.id === PACE_WINDOW_ID &&
              accountPool?.plannedUsedPercent != null &&
              accountPool.actualUsedPercent != null
            ) {
              const planned = clampPercent(accountPool.plannedUsedPercent);
              const actual = clampPercent(accountPool.actualUsedPercent);
              marker = 100 - planned;
              const points = Math.round(Math.abs(actual - planned));
              markerLabel = t('claude_quota.pace_tooltip', {
                planned: Math.round(planned),
                actual: Math.round(actual),
              });
              detail =
                points === 0
                  ? t('claude_quota.pace_on_plan')
                  : t(actual > planned ? 'claude_quota.pace_over' : 'claude_quota.pace_under', {
                      points,
                      planned: Math.round(planned),
                    });
            }
            return renderRow(window, label, index, { detail, marker, markerLabel });
          })}
          {budgets.map((budget, index) =>
            renderRow(
              { ...budget, id: budget.id },
              budget.labelKey ? t(budget.labelKey) : budget.label,
              windows.length + index,
              {
                detail:
                  budget.limitDollars === null
                    ? undefined
                    : t('claude_quota.budget_left', {
                        left: formatMoney(budget.remainingDollars ?? 0, 'USD', locale),
                        limit: formatMoney(budget.limitDollars, 'USD', locale),
                      }),
              }
            )
          )}
        </>
      )}
      {breakdown.length > 0 && (
        <div className={styles.breakdown} title={t('claude_quota.breakdown_hint')}>
          <span className={classes.codexPlanLabel}>{t('claude_quota.breakdown_label')}</span>{' '}
          {breakdown.map((row) => `${row.label} ${Math.round(row.percent)}%`).join(' · ')}
        </div>
      )}
    </>
  );
}
