/**
 * claude-pool quota-card source.
 *
 * When the claude-pool plugin is present the browser stops asking Anthropic and
 * ChatGPT for quota: the plugin is the only poller and serves its cache from
 * memory at `GET /v0/management/plugins/claude-pool/quota/cards`. This module
 * parses that response (shape in the plugin's API.md) and converts each card
 * into the same `ClaudeQuotaData` / `CodexQuotaData` the direct api-call path
 * produces, so the card bodies render identically from either source.
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
} from '@/types';
import type { AnthropicResetGrantStatus } from '@/services/api/claudeResetGrants';
import { formatInstantShort } from '@/utils/quota';
import type { ClaudeQuotaData } from './providers/claude/data';
import type { CodexQuotaData } from './providers/codex/data';

export const PLUGIN_QUOTA_CARDS_PATH = '/v0/management/plugins/claude-pool/quota/cards';
export const PLUGIN_QUOTA_REFRESH_PATH = '/v0/management/plugins/claude-pool/quota/refresh';

/** Provider types whose numbers the claude-pool plugin caches (so the browser need not poll upstream). */
export const isPluginBackedType = (type: string): boolean => type === 'claude' || type === 'codex';

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
  provider: 'claude' | 'codex';
  name: string;
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
  normalized: Json;
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
    const provider = item.provider === 'claude' || item.provider === 'codex' ? item.provider : null;
    if (!name || !provider) continue;
    const error = isRecord(item.last_error) ? str(item.last_error.msg) : null;
    cards.push({
      provider,
      name,
      source: str(item.source) ?? 'poll',
      dataAtMs: ms(item.data_at),
      passiveAtMs: ms(item.passive_at),
      refreshAllowedAtMs: ms(item.refresh_allowed_at),
      backoffUntilMs: ms(item.backoff_until),
      lastError: error,
      kind: str(item.kind),
      normalized: isRecord(item.normalized) ? item.normalized : {},
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

/* ------------------------------ network ----------------------------- */

/** Null on any failure (absent plugin, missing route, older plugin): the caller falls back to direct mode. */
export async function fetchPluginCards(): Promise<PluginCardsResponse | null> {
  const origin = apiClient.getServerOrigin();
  if (!origin) return null;
  try {
    return parsePluginCards(await apiClient.get(`${origin}${PLUGIN_QUOTA_CARDS_PATH}`));
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
    await apiClient.post(`${origin}${PLUGIN_QUOTA_REFRESH_PATH}?name=${encodeURIComponent(name)}`);
    return { ok: true };
  } catch (err) {
    const status =
      typeof err === 'object' && err !== null && 'status' in err
        ? Number((err as { status?: unknown }).status)
        : undefined;
    return { ok: false, throttled: status === 429, status };
  }
}
