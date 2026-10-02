/**
 * Claude account-level facts derived from the OAuth profile and usage payloads:
 * plan tier, estimated renewal, money formatting and the extra-usage/credit
 * balance. React-free so tests/claudeAccount.test.ts can consume it directly.
 */

import type {
  ClaudeExtraUsage,
  ClaudeMoney,
  ClaudeProfileResponse,
  ClaudeSpend,
  ClaudeSubscriptionInfo,
  ClaudeUsageBreakdownRow,
} from '@/types';

const finiteNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const parseMs = (value: unknown): number | null => {
  if (typeof value !== 'string' || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
};

/**
 * Refine the coarse `plan_max` label with the rate-limit tier
 * (`default_claude_max_20x` -> `plan_max20`). Falls back to the coarse plan.
 */
export function refineClaudePlanType(
  planType: string | null,
  profile: ClaudeProfileResponse | null
): string | null {
  if (planType !== 'plan_max') return planType;
  const tier = profile?.organization?.rate_limit_tier;
  const match = typeof tier === 'string' ? /max_(\d+)x/i.exec(tier) : null;
  if (match?.[1] === '20') return 'plan_max20';
  if (match?.[1] === '5') return 'plan_max5';
  return planType;
}

/**
 * First instant strictly after `nowMs` that falls on the monthly anniversary of
 * `startedAtMs` (UTC, day clamped to the month length). Null when unparseable.
 */
export function nextMonthlyAnniversaryMs(startedAtMs: number, nowMs: number): number | null {
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(nowMs)) return null;
  const start = new Date(startedAtMs);
  const year = start.getUTCFullYear();
  const month = start.getUTCMonth();
  const day = start.getUTCDate();
  const time = [
    start.getUTCHours(),
    start.getUTCMinutes(),
    start.getUTCSeconds(),
    start.getUTCMilliseconds(),
  ] as const;
  for (let step = 1; step <= 1200; step += 1) {
    const monthIndex = month + step;
    const targetYear = year + Math.floor(monthIndex / 12);
    const targetMonth = monthIndex % 12;
    const daysInMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
    const candidate = Date.UTC(targetYear, targetMonth, Math.min(day, daysInMonth), ...time);
    if (candidate > nowMs) return candidate;
  }
  return null;
}

/**
 * Anthropic exposes no billing-period end to OAuth tokens (the organization
 * billing endpoints reject them), only when the subscription started. A Stripe
 * subscription renews on that day of the month, so the renewal is *estimated*
 * from it. Non-Stripe or inactive subscriptions get no estimate.
 */
export function resolveClaudeSubscription(
  profile: ClaudeProfileResponse | null,
  nowMs: number
): ClaudeSubscriptionInfo | null {
  const org = profile?.organization;
  if (!org) return null;
  const status = typeof org.subscription_status === 'string' ? org.subscription_status : null;
  const billingType = typeof org.billing_type === 'string' ? org.billing_type : null;
  const startedAtMs = parseMs(org.subscription_created_at);
  const renewable =
    status?.toLowerCase() === 'active' &&
    billingType?.toLowerCase().includes('stripe') === true &&
    startedAtMs !== null;
  const renewsAtMs = renewable ? nextMonthlyAnniversaryMs(startedAtMs, nowMs) : null;
  const trialEndsAtMs = parseMs(org.claude_code_trial_ends_at);
  if (status === null && startedAtMs === null && trialEndsAtMs === null) return null;
  return { status, billingType, startedAtMs, renewsAtMs, trialEndsAtMs };
}

/** `amount_minor` / 10^exponent, or null when the money object is empty. */
export function moneyToMajor(money: ClaudeMoney | null | undefined): number | null {
  const minor = finiteNumber(money?.amount_minor);
  if (minor === null) return null;
  const exponent = finiteNumber(money?.exponent) ?? 2;
  return minor / 10 ** exponent;
}

export function formatMoney(amount: number, currency?: string | null, locale?: string): string {
  const code = typeof currency === 'string' && /^[A-Za-z]{3}$/.test(currency) ? currency : 'USD';
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: code.toUpperCase(),
    }).format(amount);
  } catch {
    return `${code.toUpperCase()} ${amount.toFixed(2)}`;
  }
}

export interface ClaudeCreditSummary {
  /** Extra usage / spend is switched on for the account. */
  enabled: boolean;
  currency: string;
  used: number | null;
  limit: number | null;
  /** Prepaid credit balance, when the account has one. */
  balance: number | null;
  limitReached: boolean;
}

/**
 * Combine `extra_usage` (overage billing) and `spend` (prepaid credits) into
 * one summary. Returns null when neither block is present at all.
 */
export function resolveClaudeCredit(
  extra: ClaudeExtraUsage | null | undefined,
  spend: ClaudeSpend | null | undefined
): ClaudeCreditSummary | null {
  if (!extra && !spend) return null;
  const extraOn = extra?.is_enabled === true;
  const spendOn = spend?.enabled === true;
  const currency =
    (extraOn ? extra?.currency : null) ??
    spend?.used?.currency ??
    spend?.limit?.currency ??
    spend?.balance?.currency ??
    'USD';

  let used: number | null = null;
  let limit: number | null = null;
  if (extraOn) {
    const decimals = finiteNumber(extra?.decimal_places) ?? 2;
    const usedCredits = finiteNumber(extra?.used_credits);
    const monthlyLimit = finiteNumber(extra?.monthly_limit);
    used = usedCredits === null ? null : usedCredits / 10 ** decimals;
    limit = monthlyLimit === null ? null : monthlyLimit / 10 ** decimals;
  } else if (spendOn) {
    used = moneyToMajor(spend?.used);
    limit = moneyToMajor(spend?.limit) ?? moneyToMajor(spend?.cap);
  }
  const balance = spendOn ? moneyToMajor(spend?.balance) : null;
  return {
    enabled: extraOn || spendOn,
    currency,
    used,
    limit,
    balance,
    limitReached: extra?.spend_limit_reached === true,
  };
}

export function buildClaudeBreakdown(
  rows: ClaudeUsageBreakdownRow[] | null | undefined
): { key: string; label: string; percent: number }[] {
  if (!Array.isArray(rows)) return [];
  const out: { key: string; label: string; percent: number }[] = [];
  for (const row of rows) {
    const percent = finiteNumber(row?.percent);
    const label = typeof row?.display_name === 'string' ? row.display_name.trim() : '';
    if (percent === null || !label) continue;
    out.push({ key: typeof row.key === 'string' ? row.key : label, label, percent });
  }
  return out.filter((row) => row.percent > 0).sort((a, b) => b.percent - a.percent);
}
