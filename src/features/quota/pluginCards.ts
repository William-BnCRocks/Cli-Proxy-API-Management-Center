/**
 * account-pool quota-card source.
 *
 * When the account-pool plugin is present the browser stops asking Anthropic and
 * ChatGPT for quota: the plugin is the only poller and serves its cache from
 * memory at `GET /v0/management/plugins/account-pool/quota/cards`. This module
 * parses that response (shape in the plugin's API.md) and converts each card
 * into the same `ClaudeQuotaData` / `CodexQuotaData` / `XaiBillingSummary` the
 * direct api-call path produces, so the card bodies render identically from
 * either source.
 *
 * React-free; tests/pluginCards.test.ts consumes it directly.
 */

import { apiClient } from '@/services/api/client';
import type {
  ClaudeExtraUsage,
  ClaudeMoney,
  ClaudeQuotaBudget,
  ClaudeQuotaWindow,
  ClaudeSpend,
  ClaudeSubscriptionInfo,
  CodexQuotaWindow,
  CodexRateLimitResetCredit,
  XaiBillingConfig,
  XaiBillingSummary,
  XaiMeasuredUsage,
  XaiRateLimitHeadroom,
} from '@/types';
import type { AnthropicResetGrantStatus } from '@/services/api/claudeResetGrants';
import {
  buildXaiBillingSummary,
  formatInstantShort,
  getStatusFromError,
  mergeXaiBillingSummaries,
  resolveXaiSubscriptionPlan,
} from '@/utils/quota';
import { currentPoolBase, isLegacyPoolBase, poolGet } from './accountPool';
import type { ClaudeQuotaData } from './providers/claude/data';
import type { CodexQuotaData } from './providers/codex/data';

export const PLUGIN_QUOTA_CARDS_PATH = '/v0/management/plugins/account-pool/quota/cards';
export const PLUGIN_QUOTA_REFRESH_PATH = '/v0/management/plugins/account-pool/quota/refresh';

/** xAI credentials whose card the plugin served with kind "off" (xai-poll disabled): the browser polls those itself. */
let pluginOffXaiNames: ReadonlySet<string> = new Set();

/** Record which xAI credentials the plugin is not polling; called with every cards response. */
export function notePluginOffCards(cards: readonly PluginCard[]): void {
  pluginOffXaiNames = new Set(
    cards.filter((card) => card.provider === 'xai' && card.kind === 'off').map((card) => card.name)
  );
}

/**
 * Provider types whose numbers the account-pool plugin caches (so the browser need not
 * poll upstream). The legacy claude-pool plugin only ever served Claude and Codex, so
 * xAI stays on the direct path while only the legacy routes answer. With `name`, an xAI
 * credential the plugin reports as "off" is also not plugin-backed (direct path).
 */
export const isPluginBackedType = (type: string, name?: string): boolean =>
  type === 'claude' ||
  type === 'codex' ||
  (type === 'xai' && !isLegacyPoolBase() && !(name !== undefined && pluginOffXaiNames.has(name)));

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const str = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value : null;
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
/** Unix seconds -> epoch ms. */
const ms = (value: unknown): number | null => {
  const seconds = num(value);
  return seconds === null ? null : seconds * 1000;
};
const iso = (value: unknown): string | null => {
  const millis = ms(value);
  return millis === null ? null : new Date(millis).toISOString();
};

export interface PluginCard {
  provider: 'claude' | 'codex' | 'xai' | 'opencode-go';
  name: string;
  disabled: boolean;
  /** `poll` (the plugin asked upstream) or `passive` (read from real traffic's response headers). */
  source: string;
  /** Epoch ms of the newest data, or null before the first reading. */
  dataAtMs: number | null;
  passiveAtMs: number | null;
  /** Epoch ms before which POST quota/refresh answers 429. */
  refreshAllowedAtMs: number | null;
  backoffUntilMs: number | null;
  lastError: string | null;
  kind: string | null;
  /** Why the card has no data (kind off / no_data), when the plugin says. */
  reason: string | null;
  normalized: Json;
  /** Upstream payloads as the plugin received them (xAI: billing_weekly, billing_monthly, user). */
  raw: Json;
}

export interface PluginCardsResponse {
  nowMs: number | null;
  forceGapS: number | null;
  cards: PluginCard[];
}

export function parsePluginCards(raw: unknown): PluginCardsResponse | null {
  if (!isRecord(raw) || !Array.isArray(raw.cards)) return null;
  const cards: PluginCard[] = [];
  for (const item of raw.cards) {
    if (!isRecord(item)) continue;
    const name = str(item.name);
    const provider =
      item.provider === 'claude' ||
      item.provider === 'codex' ||
      item.provider === 'xai' ||
      item.provider === 'opencode-go'
        ? item.provider
        : null;
    if (!name || !provider) continue;
    const error = isRecord(item.last_error) ? str(item.last_error.msg) : null;
    cards.push({
      provider,
      name,
      disabled: item.disabled === true,
      source: str(item.source) ?? 'poll',
      dataAtMs: ms(item.data_at),
      passiveAtMs: ms(item.passive_at),
      refreshAllowedAtMs: ms(item.refresh_allowed_at),
      backoffUntilMs: ms(item.backoff_until),
      lastError: error,
      kind: str(item.kind),
      reason: str(item.reason),
      normalized: isRecord(item.normalized) ? item.normalized : {},
      raw: isRecord(item.raw) ? item.raw : {},
    });
  }
  return { nowMs: ms(raw.now), forceGapS: num(raw.force_gap_s), cards };
}

/* ------------------------------ Claude ------------------------------ */

const CLAUDE_WINDOW_LABEL_KEYS: Record<string, string> = {
  'five-hour': 'claude_quota.five_hour',
  'seven-day': 'claude_quota.seven_day',
  'seven-day-oauth-apps': 'claude_quota.seven_day_oauth_apps',
  'seven-day-opus': 'claude_quota.seven_day_opus',
  'seven-day-sonnet': 'claude_quota.seven_day_sonnet',
  'seven-day-cowork': 'claude_quota.seven_day_cowork',
  'seven-day-fable': 'claude_quota.seven_day_fable',
};

const CLAUDE_PLAN_TYPES: Record<string, string> = {
  max_20x: 'plan_max20',
  max_5x: 'plan_max5',
  max: 'plan_max',
  pro: 'plan_pro',
  team: 'plan_team',
  free: 'plan_free',
};

const minor = (value: unknown): number | null => {
  const amount = num(value);
  return amount === null ? null : Math.round(amount * 100);
};

const moneyFromMajor = (value: unknown): ClaudeMoney | null => {
  if (!isRecord(value)) return null;
  const amount = minor(value.amount);
  if (amount === null) return null;
  return { amount_minor: amount, currency: str(value.currency), exponent: 2 };
};

function convertGrants(value: unknown): AnthropicResetGrantStatus | null {
  if (!isRecord(value)) return null;
  const grants = arr(value.grants)
    .filter(isRecord)
    .map((grant) => ({
      id: str(grant.id) ?? '',
      label: str(grant.label) ?? '',
      resetsTotal: num(grant.resets_total) ?? 0,
      resetsLeft: num(grant.resets_left) ?? 0,
      startsAt: iso(grant.starts_at),
      endsAt: iso(grant.ends_at),
      clears: arr(grant.clears).filter(
        (item): item is 'five_hour' | 'seven_day' | 'seven_day_overage_included' =>
          item === 'five_hour' || item === 'seven_day' || item === 'seven_day_overage_included'
      ),
      paused: grant.paused === true,
      usableNow: grant.usable_now === true,
      useRequiresLimit: grant.use_requires_limit !== false,
      percentUsed: {},
    }))
    .filter((grant) => grant.id);
  return {
    eligible: value.eligible === true,
    ineligibleReason: str(value.ineligible_reason),
    atLimit: value.at_limit === true,
    grants,
    nextGrantId: str(value.next_grant_id),
    weeklyResetsAt: iso(value.weekly_resets_at),
    cooldownUntil: iso(value.cooldown_until),
  };
}

export function claudeCardToData(card: PluginCard): ClaudeQuotaData {
  const n = card.normalized;
  const windows: ClaudeQuotaWindow[] = arr(n.windows)
    .filter(isRecord)
    .map((w) => {
      const id = str(w.id) ?? '';
      const labelKey = CLAUDE_WINDOW_LABEL_KEYS[id];
      const resetAtMs = ms(w.resets_at);
      const limitDollars = num(w.limit_dollars);
      return {
        id,
        label: str(w.label) ?? id,
        ...(labelKey ? { labelKey } : {}),
        usedPercent: num(w.used_percent),
        resetLabel: resetAtMs === null ? '-' : formatInstantShort(resetAtMs),
        resetAtMs,
        periodHours: num(w.period_hours),
        ...(limitDollars === null
          ? {}
          : {
              limitDollars,
              usedDollars: num(w.used_dollars),
              remainingDollars: num(w.remaining_dollars),
            }),
      };
    })
    .filter((w) => w.id);
  const budgets: ClaudeQuotaBudget[] = arr(n.budgets)
    .filter(isRecord)
    .map((b) => {
      const id = str(b.id) ?? '';
      const resetAtMs = ms(b.resets_at);
      return {
        id,
        label: str(b.label) ?? id,
        ...(id === 'budget-iguana_necktie' ? { labelKey: 'claude_quota.fable_budget' } : {}),
        usedPercent: num(b.used_percent),
        resetLabel: resetAtMs === null ? '-' : formatInstantShort(resetAtMs),
        resetAtMs,
        usedDollars: num(b.used_dollars),
        limitDollars: num(b.limit_dollars),
        remainingDollars: num(b.remaining_dollars),
      };
    })
    .filter((b) => b.id);

  const extra = isRecord(n.extra_usage) ? n.extra_usage : null;
  const extraUsage: ClaudeExtraUsage | null = extra
    ? {
        is_enabled: extra.enabled === true,
        used_credits: minor(extra.used),
        monthly_limit: minor(extra.limit),
        utilization: num(extra.utilization),
        currency: str(extra.currency),
        decimal_places: 2,
        spend_limit_reached: extra.limit_reached === true,
        disabled_reason: str(extra.disabled_reason),
      }
    : null;
  const spendRaw = isRecord(n.spend) ? n.spend : null;
  const spend: ClaudeSpend | null = spendRaw
    ? {
        enabled: spendRaw.enabled === true,
        used: moneyFromMajor(spendRaw.used),
        limit: moneyFromMajor(spendRaw.limit),
        balance: moneyFromMajor(spendRaw.balance),
        cap: moneyFromMajor(spendRaw.cap),
        percent: num(spendRaw.percent),
        can_purchase_credits:
          typeof spendRaw.can_purchase_credits === 'boolean' ? spendRaw.can_purchase_credits : null,
      }
    : null;

  const sub = isRecord(n.subscription) ? n.subscription : null;
  const subscription: ClaudeSubscriptionInfo | null = sub
    ? {
        status: str(sub.status),
        billingType: str(sub.billing_type),
        startedAtMs: ms(sub.started_at),
        renewsAtMs: ms(sub.renews_at_estimated),
        trialEndsAtMs: ms(sub.trial_ends_at),
      }
    : null;

  const planKey = isRecord(n.plan) ? str(n.plan.key) : null;
  return {
    windows,
    budgets,
    extraUsage,
    spend,
    subscription,
    resetGrants: convertGrants(n.reset_grants),
    breakdown: arr(n.breakdown)
      .filter(isRecord)
      .flatMap((row) => {
        const label = str(row.label);
        const percent = num(row.percent);
        return label && percent !== null ? [{ key: str(row.key) ?? label, label, percent }] : [];
      }),
    planType: planKey ? (CLAUDE_PLAN_TYPES[planKey] ?? null) : null,
  };
}

/* ------------------------------ Codex ------------------------------ */

const CODEX_WINDOW_LABEL_KEYS: Record<string, string> = {
  'five-hour': 'codex_quota.primary_window',
  weekly: 'codex_quota.secondary_window',
  monthly: 'codex_quota.team_secondary_window',
};

export function codexCardToData(card: PluginCard): CodexQuotaData {
  const n = card.normalized;
  const windows: CodexQuotaWindow[] = arr(n.windows)
    .filter(isRecord)
    .map((w) => {
      const id = str(w.id) ?? '';
      const labelKey = CODEX_WINDOW_LABEL_KEYS[id];
      const resetAtMs = ms(w.resets_at);
      return {
        id,
        label: str(w.label) ?? id,
        ...(labelKey ? { labelKey } : {}),
        usedPercent: num(w.used_percent),
        resetLabel: resetAtMs === null ? '-' : formatInstantShort(resetAtMs),
        resetAtMs,
        periodHours: num(w.period_hours),
      };
    })
    .filter((w) => w.id);
  const credits = isRecord(n.credits) ? n.credits : null;
  const reset = isRecord(n.reset_credits) ? n.reset_credits : null;
  const resetCredits: CodexRateLimitResetCredit[] = arr(reset?.credits)
    .filter(isRecord)
    .map((credit) => ({
      id: str(credit.id) ?? '',
      status: 'available',
      grantedAt: iso(credit.granted_at) ?? '',
      expiresAt: iso(credit.expires_at) ?? '',
    }))
    .filter((credit) => credit.expiresAt);
  const sub = isRecord(n.subscription) ? n.subscription : null;
  return {
    planType: str(n.plan),
    subscriptionActiveUntil: iso(sub?.active_until),
    creditBalance: credits ? str(credits.balance) : null,
    creditsUnlimited: credits?.unlimited === true,
    rateLimitResetCreditsAvailableCount: reset ? num(reset.available) : null,
    rateLimitResetCreditsApplicableAvailableCount: reset ? num(reset.applicable) : null,
    rateLimitResetCredits: resetCredits,
    rateLimitResetCreditsError: '',
    windows,
    // The plugin's card-level `kind` is authoritative: it is limit_reached while the plan is refused.
    limitReached: n.limit_reached === true || card.kind === 'limit_reached',
  };
}

/* ------------------------------- xAI -------------------------------- */

/** A raw payload the plugin cut short (`{"truncated": true}`) carries nothing usable. */
const xaiConfig = (value: unknown): XaiBillingConfig | null =>
  isRecord(value) && value.truncated !== true ? (value as XaiBillingConfig) : null;

/** "XPremiumPlus" -> "X Premium+": the plugin has the raw tier id, the direct path has Grok's display name. */
const humanizeXaiTier = (tier: string): string =>
  /\s/.test(tier)
    ? tier
    : tier
        .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/ Plus$/, '+')
        .replace(/^Super Grok/, 'SuperGrok');

/**
 * Weekly billing config for the shared builder. Period (start / resets_at) and percent come
 * from the plugin's normalized block, which already projects a rolled-over week at 0 %; the
 * raw payload (as last received from xAI, so stale after a rollover) only supplies the extra
 * billing fields (on-demand, prepaid, product usage). Without a raw payload the config is
 * rebuilt from normalized alone.
 */
const xaiWeeklyConfig = (raw: XaiBillingConfig | null, n: Json): XaiBillingConfig | null => {
  const period = isRecord(n.period) ? n.period : null;
  const end = iso(period?.resets_at);
  if (!raw && !end) return null;
  const cents = (value: unknown) => {
    const amount = num(value);
    return amount === null ? undefined : { val: amount };
  };
  const onDemand = isRecord(n.on_demand) ? n.on_demand : null;
  const config: XaiBillingConfig = raw
    ? { ...raw }
    : {
        onDemandCap: cents(onDemand?.cap_cents),
        onDemandUsed: cents(onDemand?.used_cents),
        prepaidBalance: cents(n.prepaid_balance_cents),
      };
  if (end) {
    const start = iso(period?.start) ?? undefined;
    const rawType = (raw?.currentPeriod ?? raw?.current_period)?.type;
    config.currentPeriod = {
      type:
        period?.type === 'monthly'
          ? 'USAGE_PERIOD_TYPE_MONTHLY'
          : period?.type === 'weekly'
            ? 'USAGE_PERIOD_TYPE_WEEKLY'
            : (rawType ?? 'USAGE_PERIOD_TYPE_WEEKLY'),
      start,
      end,
    };
    config.current_period = undefined;
    if (!raw) {
      config.billingPeriodStart = start;
      config.billingPeriodEnd = end;
    }
  }
  // A null here is the plugin saying "not reported", not "keep the stale raw figure".
  if ('usage_percent' in n) {
    config.creditUsagePercent = num(n.usage_percent);
    config.credit_usage_percent = undefined;
  }
  return config;
};

const count = (value: unknown): number => num(value) ?? 0;

function xaiMeasured(value: unknown): XaiMeasuredUsage | null {
  if (!isRecord(value)) return null;
  if (num(value.requests) === null && num(value.total_tokens) === null) return null;
  return {
    sinceMs: ms(value.since),
    requests: count(value.requests),
    failed: count(value.failed),
    rateLimited: count(value.rate_limited),
    inputTokens: count(value.input_tokens),
    outputTokens: count(value.output_tokens),
    reasoningTokens: count(value.reasoning_tokens),
    cacheReadTokens: count(value.cache_read_tokens),
    cacheWriteTokens: count(value.cache_write_tokens),
    totalTokens: count(value.total_tokens),
    lastRequestAtMs: ms(value.last_request_at),
  };
}

function xaiRateLimit(value: unknown): XaiRateLimitHeadroom | null {
  if (!isRecord(value)) return null;
  const headroom = {
    limitRequests: num(value.limit_requests),
    remainingRequests: num(value.remaining_requests),
    limitTokens: num(value.limit_tokens),
    remainingTokens: num(value.remaining_tokens),
    atMs: ms(value.at),
  };
  const known = [
    headroom.limitRequests,
    headroom.remainingRequests,
    headroom.limitTokens,
    headroom.remainingTokens,
  ];
  return known.every((item) => item === null) ? null : headroom;
}

/**
 * The plugin's xAI card as the summary the direct path builds. The billing payloads go
 * through the same builders (so plan limits, on-demand, prepaid and the monthly row
 * behave identically); the plugin's own measurement rides along. Null when the card
 * carries no billing period at all.
 */
export function xaiCardToData(card: PluginCard): XaiBillingSummary | null {
  const n = card.normalized;
  const weeklyConfig = xaiWeeklyConfig(xaiConfig(card.raw.billing_weekly), n);
  const summary = mergeXaiBillingSummaries(
    buildXaiBillingSummary(weeklyConfig),
    buildXaiBillingSummary(xaiConfig(card.raw.billing_monthly))
  );
  if (!summary) return null;
  const user = isRecord(card.raw.user) ? card.raw.user : null;
  const tier = str(n.plan) ?? str(user?.subscriptionTier) ?? str(user?.subscription_tier);
  const plan = tier ? resolveXaiSubscriptionPlan(tier, humanizeXaiTier(tier)) : null;
  return {
    ...summary,
    ...(plan ? { planLabel: plan.label, planTier: plan.tier } : {}),
    measured: xaiMeasured(n.measured),
    rateLimit: xaiRateLimit(n.rate_limit),
  };
}

/* ------------------------------ network ----------------------------- */

/** Null on any failure (absent plugin, missing route, older plugin): the caller falls back to direct mode. */
export async function fetchPluginCards(): Promise<PluginCardsResponse | null> {
  const origin = apiClient.getServerOrigin();
  if (!origin) return null;
  try {
    return parsePluginCards(await poolGet(origin, '/quota/cards'));
  } catch {
    return null;
  }
}

export type PluginRefreshResult = { ok: true } | { ok: false; throttled: boolean; status?: number };

/** Asks the plugin to re-poll one credential. It throttles to once per `force_gap_s` and answers 429. */
export async function refreshPluginCard(name: string): Promise<PluginRefreshResult> {
  const origin = apiClient.getServerOrigin();
  if (!origin) return { ok: false, throttled: false };
  try {
    await apiClient.post(
      `${origin}${currentPoolBase()}/quota/refresh?name=${encodeURIComponent(name)}`
    );
    return { ok: true };
  } catch (err) {
    const status = getStatusFromError(err);
    return { ok: false, throttled: status === 429, status };
  }
}
