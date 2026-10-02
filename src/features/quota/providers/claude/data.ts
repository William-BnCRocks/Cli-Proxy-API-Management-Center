/**
 * Claude 额度数据层：用量窗口 + 套餐 + 额外用量。
 * React-free / SCSS-free —— 由 tests/claudeFableQuota.test.ts 直接消费。
 */

import type { TFunction } from 'i18next';
import type {
  AuthFileItem,
  ClaudeExtraUsage,
  ClaudeProfileResponse,
  ClaudeQuotaBudget,
  ClaudeQuotaState,
  ClaudeQuotaWindow,
  ClaudeSpend,
  ClaudeSubscriptionInfo,
  ClaudeUsagePayload,
  ClaudeUsageWindow,
} from '@/types';
import { apiCallApi, getApiCallErrorMessage } from '@/services/api';
import { apiClient } from '@/services/api/client';
import {
  parseAnthropicResetGrantStatus,
  type AnthropicResetGrantStatus,
} from '@/services/api/claudeResetGrants';
import {
  CLAUDE_PROFILE_URL,
  CLAUDE_USAGE_URL,
  CLAUDE_REQUEST_HEADERS,
  CLAUDE_USAGE_WINDOW_KEYS,
  claudePeriodHours,
  normalizeNumberValue,
  normalizeStringValue,
  parseClaudeUsagePayload,
  formatQuotaResetTime,
  resolveResetMs,
  createStatusError,
  parseRetryAfterMs,
  isClaudeFile,
  isDisabledAuthFile,
} from '@/utils/quota';
import { normalizeAuthIndex } from '@/utils/authIndex';
import type { QuotaProviderData } from '../types';
import { buildClaudeBreakdown, refineClaudePlanType, resolveClaudeSubscription } from './account';

export type ClaudeQuotaData = {
  windows: ClaudeQuotaWindow[];
  budgets?: ClaudeQuotaBudget[];
  extraUsage?: ClaudeExtraUsage | null;
  spend?: ClaudeSpend | null;
  subscription?: ClaudeSubscriptionInfo | null;
  resetGrants?: AnthropicResetGrantStatus | null;
  breakdown?: { key: string; label: string; percent: number }[];
  planType?: string | null;
};

/** Usage URL with the banked-reset programme block requested, so one call feeds the whole card. */
const CLAUDE_USAGE_WITH_GRANTS_URL = `${CLAUDE_USAGE_URL}?cedar_ember=1`;

/** Plan and tier change on a scale of months; cache the profile instead of re-reading it each tick. */
const PROFILE_TTL_MS = 30 * 60 * 1000;
const profileCache = new Map<string, { at: number; revision: number; profile: unknown }>();

/** Payload keys that are not usage buckets, so unknown-bucket discovery never touches them. */
const NON_BUCKET_KEYS = new Set([
  'limits',
  'extra_usage',
  'spend',
  'cedar_ember',
  'seven_day_breakdown',
  'member_dashboard_available',
]);
const KNOWN_BUCKET_KEYS = new Set<string>(CLAUDE_USAGE_WINDOW_KEYS.map(({ key }) => key));

/** Windows that stay percent-of-rate-limit rows even if the payload adds dollar fields. */
const RATE_LIMIT_KEYS = new Set(['five_hour', 'seven_day']);

const isUsageBucket = (value: unknown): value is ClaudeUsageWindow =>
  typeof value === 'object' &&
  value !== null &&
  normalizeNumberValue((value as { utilization?: unknown }).utilization) !== null;

const hasDollarLimit = (bucket: ClaudeUsageWindow): boolean =>
  normalizeNumberValue(bucket.limit_dollars) !== null;

const humanizeBucketKey = (key: string): string => key.replace(/_/g, ' ');

const isFableName = (name: string): boolean => name === 'fable' || name === 'fable 5';

const findFableUsageLimit = (payload: ClaudeUsagePayload) => {
  if (!Array.isArray(payload.limits)) return null;

  const candidates = payload.limits.filter((limit) => {
    const kind = (normalizeStringValue(limit?.kind) ?? '').trim().toLowerCase();
    const modelName = (normalizeStringValue(limit?.scope?.model?.display_name) ?? '')
      .trim()
      .toLowerCase();
    return (
      kind === 'weekly_scoped' &&
      isFableName(modelName) &&
      normalizeNumberValue(limit?.percent) !== null
    );
  });

  return candidates.find((limit) => limit.is_active === true) ?? candidates[0] ?? null;
};

export const buildClaudeQuotaWindows = (
  payload: ClaudeUsagePayload,
  t: TFunction
): ClaudeQuotaWindow[] => {
  const windows: ClaudeQuotaWindow[] = [];
  const fableLimit = findFableUsageLimit(payload);

  for (const { key, id, labelKey } of CLAUDE_USAGE_WINDOW_KEYS) {
    const window = payload[key as keyof ClaudeUsagePayload];
    if (!window || typeof window !== 'object' || !('utilization' in window)) continue;
    const typedWindow = window as ClaudeUsageWindow;
    // Money-denominated buckets are allowances, not rate-limit windows (see buildClaudeQuotaBudgets).
    if (!RATE_LIMIT_KEYS.has(key) && hasDollarLimit(typedWindow)) continue;
    if (key === 'iguana_necktie' && fableLimit) continue;
    const usedPercent = normalizeNumberValue(typedWindow.utilization);
    const resetLabel = formatQuotaResetTime(typedWindow.resets_at ?? undefined);
    const dollars = hasDollarLimit(typedWindow)
      ? {
          usedDollars: normalizeNumberValue(typedWindow.used_dollars),
          limitDollars: normalizeNumberValue(typedWindow.limit_dollars),
          remainingDollars: normalizeNumberValue(typedWindow.remaining_dollars),
        }
      : {};
    windows.push({
      id,
      label: t(labelKey),
      labelKey,
      usedPercent,
      resetLabel,
      ...dollars,
      // Claude states the period nowhere in the payload, so it comes from the
      // key: `five_hour` is the rolling window, everything else is weekly.
      resetAtMs: resolveResetMs([typedWindow.resets_at]),
      periodHours: claudePeriodHours(key),
    });
  }

  if (fableLimit) {
    const usedPercent = normalizeNumberValue(fableLimit.percent);
    if (usedPercent !== null) {
      windows.push({
        id: 'seven-day-fable',
        label: t('claude_quota.seven_day_fable'),
        labelKey: 'claude_quota.seven_day_fable',
        usedPercent,
        resetLabel: formatQuotaResetTime(fableLimit.resets_at ?? undefined),
        // `weekly_scoped` is a 7-day window by definition, so the timeline can
        // place this row alongside the ones derived from the named keys.
        resetAtMs: resolveResetMs([fableLimit.resets_at]),
        periodHours: claudePeriodHours('seven_day'),
      });
    }
  }

  // Buckets this panel has no name for: show them when populated, hide them when null.
  for (const [key, value] of Object.entries(payload)) {
    if (KNOWN_BUCKET_KEYS.has(key) || NON_BUCKET_KEYS.has(key)) continue;
    if (!isUsageBucket(value) || hasDollarLimit(value)) continue;
    windows.push({
      id: `other-${key}`,
      label: t('claude_quota.window_other', { name: humanizeBucketKey(key) }),
      usedPercent: normalizeNumberValue(value.utilization),
      resetLabel: formatQuotaResetTime(value.resets_at ?? undefined),
      resetAtMs: resolveResetMs([value.resets_at]),
      periodHours: null,
    });
  }

  return windows;
};

/**
 * Money-denominated allowances. `iguana_necktie` is the Fable 5 credit: a
 * monthly dollar budget (limit/used/remaining_dollars) that is distinct from
 * the weekly Fable window living under `limits[]`.
 */
export const buildClaudeQuotaBudgets = (
  payload: ClaudeUsagePayload,
  t: TFunction
): ClaudeQuotaBudget[] => {
  const budgets: ClaudeQuotaBudget[] = [];
  for (const [key, value] of Object.entries(payload)) {
    if (NON_BUCKET_KEYS.has(key) || RATE_LIMIT_KEYS.has(key)) continue;
    if (!isUsageBucket(value) || !hasDollarLimit(value)) continue;
    const known = CLAUDE_USAGE_WINDOW_KEYS.find((entry) => entry.key === key);
    const limitDollars = normalizeNumberValue(value.limit_dollars);
    const usedDollars = normalizeNumberValue(value.used_dollars);
    const remainingDollars =
      normalizeNumberValue(value.remaining_dollars) ??
      (limitDollars !== null && usedDollars !== null ? limitDollars - usedDollars : null);
    const labelKey = key === 'iguana_necktie' ? 'claude_quota.fable_budget' : known?.labelKey;
    budgets.push({
      id: `budget-${key}`,
      label: labelKey
        ? t(labelKey)
        : t('claude_quota.window_other', { name: humanizeBucketKey(key) }),
      labelKey,
      usedPercent: normalizeNumberValue(value.utilization),
      resetLabel: formatQuotaResetTime(value.resets_at ?? undefined),
      resetAtMs: resolveResetMs([value.resets_at]),
      usedDollars,
      limitDollars,
      remainingDollars,
    });
  }
  return budgets;
};

const normalizeFlagValue = (value: unknown): boolean | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const trimmed = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'on'].includes(trimmed)) return true;
    if (['false', '0', 'no', 'n', 'off'].includes(trimmed)) return false;
  }
  return undefined;
};

const parseClaudeProfilePayload = (payload: unknown): ClaudeProfileResponse | null => {
  if (payload === undefined || payload === null) return null;
  if (typeof payload === 'string') {
    const trimmed = payload.trim();
    if (!trimmed) return null;
    try {
      return JSON.parse(trimmed) as ClaudeProfileResponse;
    } catch {
      return null;
    }
  }
  if (typeof payload === 'object') {
    return payload as ClaudeProfileResponse;
  }
  return null;
};

export const resolveClaudePlanType = (profile: ClaudeProfileResponse | null): string | null => {
  if (!profile) return null;

  const organizationType = normalizeStringValue(
    profile.organization?.organization_type
  )?.toLowerCase();
  const subscriptionStatus = normalizeStringValue(
    profile.organization?.subscription_status
  )?.toLowerCase();

  if (organizationType === 'claude_team' && subscriptionStatus === 'active') {
    return 'plan_team';
  }

  // Account flags include personal subscriptions even for a Team-scoped token.
  const hasClaudeMax = normalizeFlagValue(profile.account?.has_claude_max);
  if (hasClaudeMax) return 'plan_max';

  const hasClaudePro = normalizeFlagValue(profile.account?.has_claude_pro);
  if (hasClaudePro) return 'plan_pro';

  if (hasClaudeMax === false && hasClaudePro === false) return 'plan_free';

  return null;
};

const readClaudeProfile = async (authIndex: string): Promise<ClaudeProfileResponse | null> => {
  const revision = apiClient.getConnectionRevision();
  const cached = profileCache.get(authIndex);
  const usable = cached && cached.revision === revision ? cached : undefined;
  if (usable && Date.now() - usable.at < PROFILE_TTL_MS) {
    return usable.profile as ClaudeProfileResponse | null;
  }
  try {
    const result = await apiCallApi.request({
      authIndex,
      method: 'GET',
      url: CLAUDE_PROFILE_URL,
      header: { ...CLAUDE_REQUEST_HEADERS },
    });
    if (result.statusCode >= 200 && result.statusCode < 300) {
      const profile = parseClaudeProfilePayload(result.body ?? result.bodyText);
      if (profile) {
        profileCache.set(authIndex, { at: Date.now(), revision, profile });
        return profile;
      }
    }
  } catch {
    // Plan and subscription are decorative: fall back to a stale copy, if any.
  }
  return (usable?.profile as ClaudeProfileResponse | undefined) ?? null;
};

const fetchClaudeQuota = async (file: AuthFileItem, t: TFunction): Promise<ClaudeQuotaData> => {
  const rawAuthIndex = file['auth_index'] ?? file.authIndex;
  const authIndex = normalizeAuthIndex(rawAuthIndex);
  if (!authIndex) {
    throw new Error(t('claude_quota.missing_auth_index'));
  }

  const [usageResult, profileResult] = await Promise.allSettled([
    apiCallApi.request({
      authIndex,
      method: 'GET',
      url: CLAUDE_USAGE_WITH_GRANTS_URL,
      header: { ...CLAUDE_REQUEST_HEADERS },
    }),
    readClaudeProfile(authIndex),
  ]);

  if (usageResult.status === 'rejected') {
    throw usageResult.reason;
  }

  const result = usageResult.value;

  if (result.statusCode < 200 || result.statusCode >= 300) {
    throw createStatusError(
      getApiCallErrorMessage(result),
      result.statusCode,
      parseRetryAfterMs(result.header)
    );
  }

  const payload = parseClaudeUsagePayload(result.body ?? result.bodyText);
  if (!payload) {
    throw new Error(t('claude_quota.empty_windows'));
  }

  const windows = buildClaudeQuotaWindows(payload, t);
  const profile = profileResult.status === 'fulfilled' ? profileResult.value : null;
  const planType = refineClaudePlanType(resolveClaudePlanType(profile), profile);

  return {
    windows,
    budgets: buildClaudeQuotaBudgets(payload, t),
    extraUsage: payload.extra_usage,
    spend: payload.spend ?? null,
    subscription: resolveClaudeSubscription(profile, Date.now()),
    resetGrants: parseAnthropicResetGrantStatus(payload.cedar_ember),
    breakdown: buildClaudeBreakdown(payload.seven_day_breakdown?.rows),
    planType,
  };
};

export const CLAUDE_CONFIG: QuotaProviderData<ClaudeQuotaState, ClaudeQuotaData> = {
  type: 'claude',
  i18nPrefix: 'claude_quota',
  filterFn: (file) => isClaudeFile(file) && !isDisabledAuthFile(file),
  fetchQuota: fetchClaudeQuota,
  storeSelector: (state) => state.claudeQuota,
  storeSetter: 'setClaudeQuota',
  buildLoadingState: () => ({ status: 'loading', windows: [] }),
  buildSuccessState: (data) => ({
    status: 'success',
    windows: data.windows,
    budgets: data.budgets,
    extraUsage: data.extraUsage,
    spend: data.spend,
    subscription: data.subscription,
    resetGrants: data.resetGrants,
    breakdown: data.breakdown,
    planType: data.planType,
  }),
  buildErrorState: (message, status) => ({
    status: 'error',
    windows: [],
    error: message,
    errorStatus: status,
  }),
};
