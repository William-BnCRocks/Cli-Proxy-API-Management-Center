import { beforeAll, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TFunction } from 'i18next';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import en from '@/i18n/locales/en.json';
import {
  buildClaudeQuotaBudgets,
  buildClaudeQuotaWindows,
  CLAUDE_CONFIG,
} from '@/features/quota/providers/claude/data';
import {
  buildClaudeBreakdown,
  formatMoney,
  nextMonthlyAnniversaryMs,
  refineClaudePlanType,
  resolveClaudeCredit,
  resolveClaudeSubscription,
} from '@/features/quota/providers/claude/account';
import { ClaudeQuotaBody } from '@/features/quota/providers/claude/ClaudeQuotaBody';
import { QUOTA_CLASS_KEYS, bindQuotaClasses } from '@/features/quota/types';
import { parseAnthropicResetGrantStatus } from '@/services/api/claudeResetGrants';
import type { ClaudeProfileResponse, ClaudeQuotaState, ClaudeUsagePayload } from '@/types';

const t = ((key: string) => key) as TFunction;
const classes = bindQuotaClasses(
  Object.fromEntries(QUOTA_CLASS_KEYS.map((key) => [key, key])),
  'test-host'
);

// Shape of a real Claude Max 20x usage response (ids and values redacted/rounded).
const usage = {
  five_hour: { utilization: 19, resets_at: '2026-10-02T21:19:59.853027+00:00' },
  seven_day: { utilization: 58, resets_at: '2026-10-09T03:59:59.853054+00:00' },
  seven_day_oauth_apps: null,
  seven_day_opus: null,
  seven_day_sonnet: null,
  seven_day_cowork: null,
  seven_day_omelette: null,
  tangelo: null,
  iguana_necktie: {
    utilization: 28.0457704,
    resets_at: '2026-11-05T07:59:00+00:00',
    limit_dollars: 250,
    used_dollars: 70.114426,
    remaining_dollars: 179.885574,
  },
  extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
  limits: [
    { kind: 'session', percent: 19, resets_at: '2026-10-02T21:19:59+00:00', scope: null },
    { kind: 'weekly_all', percent: 58, resets_at: '2026-10-09T03:59:59+00:00', scope: null },
    {
      kind: 'weekly_scoped',
      percent: 12,
      resets_at: '2026-10-09T04:00:00+00:00',
      is_active: false,
      scope: { model: { id: null, display_name: 'Fable' } },
    },
  ],
  spend: { used: { amount_minor: 0, currency: 'USD', exponent: 2 }, enabled: false, balance: null },
  seven_day_breakdown: {
    rows: [
      { key: 'claude_code', display_name: 'Claude Code', percent: 90 },
      { key: 'chat', display_name: 'Chats', percent: 10 },
      { key: 'cowork', display_name: 'Cowork', percent: 0 },
    ],
  },
} as unknown as ClaudeUsagePayload;

const profile = {
  account: { has_claude_max: true, has_claude_pro: false },
  organization: {
    organization_type: 'claude_max',
    billing_type: 'stripe_subscription',
    rate_limit_tier: 'default_claude_max_20x',
    subscription_status: 'active',
    subscription_created_at: '2026-07-11T19:22:23.988289Z',
  },
} as ClaudeProfileResponse;

describe('Claude usage buckets', () => {
  test('keeps rate-limit windows and the weekly Fable window, hides null buckets', () => {
    const ids = buildClaudeQuotaWindows(usage, t).map((window) => window.id);
    expect(ids).toEqual(['five-hour', 'seven-day', 'seven-day-fable']);
  });

  test('routes the dollar-denominated Fable bucket to a budget row, not a 7-day window', () => {
    const [budget, ...rest] = buildClaudeQuotaBudgets(usage, t);
    expect(rest).toEqual([]);
    expect(budget).toMatchObject({
      id: 'budget-iguana_necktie',
      labelKey: 'claude_quota.fable_budget',
      limitDollars: 250,
      usedDollars: 70.114426,
    });
    expect(budget.remainingDollars).toBeCloseTo(179.885574, 5);
    expect(budget.resetAtMs).toBe(Date.parse('2026-11-05T07:59:00+00:00'));
  });

  test('shows an unknown populated bucket and keeps unknown null ones hidden', () => {
    const payload = {
      ...usage,
      cinder_cove: { utilization: 40, resets_at: '2026-10-09T00:00:00+00:00' },
    } as unknown as ClaudeUsagePayload;
    const windows = buildClaudeQuotaWindows(payload, t);
    expect(windows.map((window) => window.id)).toContain('other-cinder_cove');
    expect(windows.some((window) => window.id.includes('tangelo'))).toBe(false);
  });
});

describe('Claude account facts', () => {
  test('refines Max into 5x/20x from the rate-limit tier', () => {
    expect(refineClaudePlanType('plan_max', profile)).toBe('plan_max20');
    const five = {
      organization: { rate_limit_tier: 'default_claude_max_5x' },
    } as ClaudeProfileResponse;
    expect(refineClaudePlanType('plan_max', five)).toBe('plan_max5');
    expect(refineClaudePlanType('plan_pro', profile)).toBe('plan_pro');
    expect(refineClaudePlanType('plan_max', null)).toBe('plan_max');
  });

  test('estimates the next monthly renewal from the subscription start', () => {
    const started = Date.parse('2026-07-11T19:22:23.988Z');
    expect(nextMonthlyAnniversaryMs(started, Date.parse('2026-10-02T00:00:00Z'))).toBe(
      Date.parse('2026-10-11T19:22:23.988Z')
    );
    expect(nextMonthlyAnniversaryMs(started, Date.parse('2026-10-11T19:22:23.988Z'))).toBe(
      Date.parse('2026-11-11T19:22:23.988Z')
    );
    // Day 31 clamps to the shorter month, then returns to 31.
    const jan31 = Date.parse('2026-01-31T10:00:00Z');
    expect(nextMonthlyAnniversaryMs(jan31, Date.parse('2026-02-01T00:00:00Z'))).toBe(
      Date.parse('2026-02-28T10:00:00Z')
    );
    expect(nextMonthlyAnniversaryMs(jan31, Date.parse('2026-03-01T00:00:00Z'))).toBe(
      Date.parse('2026-03-31T10:00:00Z')
    );
  });

  test('gives no renewal estimate for inactive or non-Stripe subscriptions', () => {
    const now = Date.parse('2026-10-02T00:00:00Z');
    expect(resolveClaudeSubscription(profile, now)?.renewsAtMs).toBe(
      Date.parse('2026-10-11T19:22:23.988Z')
    );
    const lapsed = {
      organization: { ...profile.organization, subscription_status: 'canceled' },
    } as ClaudeProfileResponse;
    expect(resolveClaudeSubscription(lapsed, now)?.renewsAtMs).toBeNull();
    const apple = {
      organization: { ...profile.organization, billing_type: 'apple_subscription' },
    } as ClaudeProfileResponse;
    expect(resolveClaudeSubscription(apple, now)?.renewsAtMs).toBeNull();
    expect(resolveClaudeSubscription(null, now)).toBeNull();
  });

  test('summarises extra usage from either overage billing or spend credits', () => {
    expect(resolveClaudeCredit(usage.extra_usage, usage.spend)?.enabled).toBe(false);
    const overage = resolveClaudeCredit(
      {
        is_enabled: true,
        monthly_limit: 5000,
        used_credits: 1234,
        utilization: 24.7,
        currency: 'USD',
        decimal_places: 2,
        spend_limit_reached: false,
      },
      null
    );
    expect(overage).toMatchObject({ enabled: true, used: 12.34, limit: 50, currency: 'USD' });
    const prepaid = resolveClaudeCredit(null, {
      enabled: true,
      used: { amount_minor: 250, currency: 'EUR', exponent: 2 },
      balance: { amount_minor: 4750, currency: 'EUR', exponent: 2 },
    });
    expect(prepaid).toMatchObject({ enabled: true, used: 2.5, balance: 47.5, currency: 'EUR' });
    expect(resolveClaudeCredit(null, null)).toBeNull();
    expect(formatMoney(12.5, 'USD', 'en-US')).toBe('$12.50');
  });

  test('summarises the 7-day source breakdown, largest first, dropping zeros', () => {
    expect(buildClaudeBreakdown(usage.seven_day_breakdown?.rows)).toEqual([
      { key: 'claude_code', label: 'Claude Code', percent: 90 },
      { key: 'chat', label: 'Chats', percent: 10 },
    ]);
    expect(buildClaudeBreakdown(null)).toEqual([]);
  });
});

describe('Claude card body', () => {
  // A private i18n instance: importing '@/i18n' would initialise the global one and change what
  // every later test file sees from useTranslation().
  const i18n = createInstance();
  beforeAll(async () => {
    await i18n.init({ resources: { en: { translation: en } }, lng: 'en', fallbackLng: 'en' });
  });
  const render = (props: Parameters<typeof ClaudeQuotaBody>[0]) =>
    renderToStaticMarkup(
      createElement(I18nextProvider, { i18n }, createElement(ClaudeQuotaBody, props))
    );

  const grants = parseAnthropicResetGrantStatus({
    eligible: true,
    at_limit: false,
    grants: [
      {
        id: 'opus55-launch',
        label: 'launch reset',
        resets_total: 1,
        resets_left: 1,
        starts_at: '2026-09-22T16:00:00+00:00',
        ends_at: '2099-10-22T16:00:00+00:00',
        clears: ['five_hour', 'seven_day'],
        usable_now: true,
        use_requires_limit: false,
      },
    ],
    next_grant_id: 'opus55-launch',
  });

  const quota: ClaudeQuotaState = {
    status: 'success',
    windows: buildClaudeQuotaWindows(usage, t),
    budgets: buildClaudeQuotaBudgets(usage, t),
    extraUsage: usage.extra_usage,
    spend: usage.spend,
    planType: 'plan_max20',
    subscription: resolveClaudeSubscription(profile, Date.parse('2026-10-02T00:00:00Z')),
    resetGrants: grants,
    breakdown: buildClaudeBreakdown(usage.seven_day_breakdown?.rows),
  };

  test('shows plan, renewal, credit, banked-reset expiry, every window and the budget', () => {
    const markup = render({ quota, classes });
    expect(markup).toContain('Max 20x');
    expect(markup).toContain(classes.elitePlanValue);
    expect(markup).toContain('Renews (est.)');
    expect(markup).toContain('Extra Usage');
    expect(markup).toContain('>Off<');
    expect(markup).toContain('Banked resets expire');
    expect(markup).toContain('1 of 1 left');
    for (const label of ['5-hour limit', '7-day limit', '7-day Fable 5', 'Fable 5 credit']) {
      expect(markup).toContain(label);
    }
    expect(markup).toContain('$179.89 left of $250.00');
    expect(markup).toContain('7-day use by source:');
  });

  test('labels every percentage as remaining', () => {
    const markup = render({ quota, classes });
    // used 19 / 58 / 12 / 28.05 -> left 81 / 42 / 88 / 72
    for (const left of ['81% left', '42% left', '88% left', '72% left']) {
      expect(markup).toContain(left);
    }
    expect(markup).not.toMatch(/>d+%</);
  });

  test('adds pool badges and the pace marker only when account-pool data is present', () => {
    const without = render({ quota, classes });
    expect(without).not.toContain('Next new session');
    expect(without).not.toContain('Pool rank');
    expect(without).not.toContain('over plan');

    const accountPool = {
      rank: 2,
      rankedCount: 4,
      isNext: true,
      eligible: true,
      kind: 'eligible',
      reason: null,
      plannedUsedPercent: 8,
      actualUsedPercent: 58,
    };
    const withPool = render({ quota, classes, accountPool });
    expect(withPool).toContain('#2 / 4');
    expect(withPool).toContain('Next new session');
    expect(withPool).toContain('50 pp over plan');
    expect(withPool).toContain('Plan: 8% used by now');
  });

  test('builds the success state with every new field', () => {
    const state = CLAUDE_CONFIG.buildSuccessState({
      windows: quota.windows,
      budgets: quota.budgets,
      resetGrants: grants,
      subscription: quota.subscription,
      planType: 'plan_max20',
    });
    expect(state).toMatchObject({ status: 'success', planType: 'plan_max20' });
    expect(state.resetGrants?.grants).toHaveLength(1);
    expect(state.budgets).toHaveLength(1);
  });
});
