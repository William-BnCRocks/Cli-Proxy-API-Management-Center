import { describe, expect, test } from 'bun:test';
import { CODEX_CONFIG } from '@/features/quota/providers/codex/data';
import { apiClient } from '@/services/api/client';
import { commitPluginCards } from '@/features/quota/pluginSource';
import { useQuotaStore } from '@/stores/useQuotaStore';
import {
  ACCOUNT_POOL_BASE,
  LEGACY_CLAUDE_POOL_BASE,
  currentPoolBase,
  isLegacyPoolBase,
  resetPoolBase,
} from '@/features/quota/accountPool';
import {
  fetchPluginCards,
  refreshPluginCard,
  PLUGIN_QUOTA_CARDS_PATH,
  PLUGIN_QUOTA_REFRESH_PATH,
  claudeCardToData,
  codexCardToData,
  isPluginBackedType,
  parsePluginCards,
  xaiCardToData,
} from '@/features/quota/pluginCards';
import {
  DEFAULT_DIRECT_INTERVAL_MS,
  DEFAULT_PLUGIN_INTERVAL_MS,
  DIRECT_INTERVALS_MS,
  PLUGIN_INTERVALS_MS,
  defaultIntervalFor,
  intervalsFor,
} from '@/features/quota/liveRefresh';

const T0 = 1_790_000_000;
const DAY = 86400;

// Shape of GET .../quota/cards (account-pool), normalised block only, values rounded.
const response = {
  now: T0,
  plugin: 'account-pool',
  version: '0.3.0',
  force_gap_s: 60,
  cards: [
    {
      provider: 'claude',
      name: 'claude-a.json',
      source: 'passive',
      passive_at: T0 - 10,
      data_at: T0 - 10,
      refresh_allowed_at: T0 + 30,
      backoff_until: null,
      last_error: null,
      kind: 'eligible',
      normalized: {
        plan: { key: 'max_20x', label: 'Max 20x', rate_limit_tier: 'default_claude_max_20x' },
        subscription: {
          status: 'active',
          billing_type: 'stripe_subscription',
          started_at: T0 - DAY * 80,
          renews_at_estimated: T0 + DAY * 9,
          trial_ends_at: null,
        },
        windows: [
          {
            id: 'five-hour',
            label: '5-hour limit',
            used_percent: 19,
            remaining_percent: 81,
            resets_at: T0 + 7200,
            period_hours: 5,
          },
          {
            id: 'seven-day',
            label: '7-day limit',
            used_percent: 58,
            remaining_percent: 42,
            resets_at: T0 + DAY * 6,
            period_hours: 168,
          },
          {
            id: 'seven-day-fable',
            label: '7-day Fable 5',
            used_percent: 12,
            remaining_percent: 88,
            resets_at: T0 + DAY * 6,
            period_hours: 168,
          },
          {
            id: 'other-cinder_cove',
            label: 'Other: cinder cove',
            used_percent: 3,
            remaining_percent: 97,
            resets_at: null,
            period_hours: null,
          },
        ],
        budgets: [
          {
            id: 'budget-iguana_necktie',
            label: 'Fable 5 credit (monthly)',
            used_percent: 28,
            remaining_percent: 72,
            resets_at: T0 + DAY * 33,
            used_dollars: 70.11,
            limit_dollars: 250,
            remaining_dollars: 179.89,
          },
        ],
        extra_usage: {
          enabled: true,
          used: 12.34,
          limit: 50,
          utilization: 24.7,
          currency: 'USD',
          limit_reached: false,
        },
        spend: { enabled: false, used: { amount: 0, currency: 'USD' }, balance: null },
        breakdown: [{ key: 'claude_code', label: 'Claude Code', percent: 90 }],
        reset_grants: {
          eligible: true,
          at_limit: false,
          next_grant_id: 'g1',
          weekly_resets_at: T0 + DAY * 6,
          cooldown_until: null,
          grants: [
            {
              id: 'g1',
              label: 'Launch',
              resets_left: 1,
              resets_total: 2,
              starts_at: null,
              ends_at: T0 + DAY * 20,
              paused: false,
              usable_now: true,
              use_requires_limit: false,
              clears: ['five_hour', 'seven_day', 'bogus'],
            },
          ],
        },
      },
    },
    {
      provider: 'claude',
      name: 'claude-b.json',
      source: 'poll',
      data_at: null,
      last_error: { t: T0, msg: 'HTTP 429 (backing off 2m)' },
      kind: 'no_data',
      normalized: {},
    },
    {
      provider: 'codex',
      name: 'codex-a.json',
      source: 'poll',
      data_at: T0 - 200,
      normalized: {
        plan: 'pro',
        windows: [
          {
            id: 'five-hour',
            label: '5-hour limit',
            used_percent: 18,
            resets_at: T0 + 5400,
            period_hours: 5,
          },
          {
            id: 'weekly',
            label: 'Weekly limit',
            used_percent: 93,
            resets_at: T0 + 90000,
            period_hours: 168,
          },
          {
            id: 'code-review-five-hour',
            label: 'Code review 5h',
            used_percent: 1,
            resets_at: T0 + 5,
            period_hours: 5,
          },
        ],
        credits: { balance: '61286.93', unlimited: false, has_credits: true },
        reset_credits: {
          available: 2,
          applicable: 1,
          credits: [{ id: 'c1', granted_at: T0 - 1000, expires_at: T0 + DAY * 20 }],
        },
        subscription: { active_until: T0 + DAY * 9, will_renew: true },
      },
    },
    { provider: 'gemini', name: 'ignored.json', normalized: {} },
    'junk',
  ],
};

describe('account-pool quota cards', () => {
  test('uses the v0 plugin routes', () => {
    expect(PLUGIN_QUOTA_CARDS_PATH).toBe('/v0/management/plugins/account-pool/quota/cards');
    expect(PLUGIN_QUOTA_REFRESH_PATH).toBe('/v0/management/plugins/account-pool/quota/refresh');
    expect(isPluginBackedType('claude') && isPluginBackedType('codex')).toBe(true);
    expect(isPluginBackedType('kimi')).toBe(false);
  });

  test('parses cards, skipping unknown providers and junk, and rejects other shapes', () => {
    const parsed = parsePluginCards(response);
    expect(parsed?.cards.map((card) => card.name)).toEqual([
      'claude-a.json',
      'claude-b.json',
      'codex-a.json',
    ]);
    expect(parsed?.cards[0]).toMatchObject({
      source: 'passive',
      dataAtMs: (T0 - 10) * 1000,
      refreshAllowedAtMs: (T0 + 30) * 1000,
    });
    expect(parsed?.cards[1]).toMatchObject({
      dataAtMs: null,
      lastError: 'HTTP 429 (backing off 2m)',
    });
    expect(parsePluginCards(null)).toBeNull();
    expect(parsePluginCards({ error: 'x' })).toBeNull();
    expect(parsePluginCards('<html>')).toBeNull();
  });

  test('converts a Claude card into the same data the direct path produces', () => {
    const data = claudeCardToData(parsePluginCards(response)!.cards[0]);
    expect(data.planType).toBe('plan_max20');
    expect(data.windows.map((w) => w.id)).toEqual([
      'five-hour',
      'seven-day',
      'seven-day-fable',
      'other-cinder_cove',
    ]);
    expect(data.windows[0]).toMatchObject({
      labelKey: 'claude_quota.five_hour',
      usedPercent: 19,
      resetAtMs: (T0 + 7200) * 1000,
      periodHours: 5,
    });
    expect(data.windows[3].labelKey).toBeUndefined();
    expect(data.budgets?.[0]).toMatchObject({
      labelKey: 'claude_quota.fable_budget',
      limitDollars: 250,
      remainingDollars: 179.89,
    });
    expect(data.subscription).toMatchObject({
      status: 'active',
      renewsAtMs: (T0 + DAY * 9) * 1000,
    });
    expect(data.extraUsage).toMatchObject({
      is_enabled: true,
      used_credits: 1234,
      monthly_limit: 5000,
    });
    expect(data.spend?.enabled).toBe(false);
    expect(data.breakdown).toEqual([{ key: 'claude_code', label: 'Claude Code', percent: 90 }]);
    const grants = data.resetGrants;
    expect(grants?.grants[0]).toMatchObject({
      id: 'g1',
      resetsLeft: 1,
      resetsTotal: 2,
      usableNow: true,
      useRequiresLimit: false,
      clears: ['five_hour', 'seven_day'],
    });
    expect(grants?.grants[0].endsAt).toBe(new Date((T0 + DAY * 20) * 1000).toISOString());
    expect(grants?.nextGrantId).toBe('g1');
  });

  test('converts a Codex card', () => {
    const data = codexCardToData(parsePluginCards(response)!.cards[2]);
    expect(data.planType).toBe('pro');
    expect(data.creditBalance).toBe('61286.93');
    expect(data.rateLimitResetCreditsAvailableCount).toBe(2);
    expect(data.rateLimitResetCredits[0]).toMatchObject({ id: 'c1', status: 'available' });
    expect(data.subscriptionActiveUntil).toBe(new Date((T0 + DAY * 9) * 1000).toISOString());
    expect(data.windows.map((w) => [w.id, w.labelKey ?? w.label, w.usedPercent])).toEqual([
      ['five-hour', 'codex_quota.primary_window', 18],
      ['weekly', 'codex_quota.secondary_window', 93],
      ['code-review-five-hour', 'Code review 5h', 1],
    ]);
  });
});

test('flags a Codex plan whose limit is reached', () => {
  const parsed = parsePluginCards({
    cards: [
      {
        provider: 'codex',
        name: 'codex-b.json',
        data_at: T0,
        normalized: {
          plan: 'pro',
          limit_reached: true,
          windows: [
            {
              id: 'weekly',
              label: 'Weekly limit',
              used_percent: 100,
              remaining_percent: 0,
              resets_at: T0 + 3600,
              period_hours: 168,
            },
          ],
        },
      },
    ],
  });
  const data = codexCardToData(parsed!.cards[0]);
  expect(data.limitReached).toBe(true);
  expect(data.windows[0].usedPercent).toBe(100);

  // card-level kind alone is enough
  const byKind = parsePluginCards({
    cards: [
      {
        provider: 'codex',
        name: 'codex-c.json',
        data_at: T0,
        kind: 'limit_reached',
        normalized: { plan: 'pro', limit_reached: false, windows: [] },
      },
    ],
  });
  expect(codexCardToData(byKind!.cards[0]).limitReached).toBe(true);
  // and it survives into the card state the body renders
  expect(CODEX_CONFIG.buildSuccessState(codexCardToData(byKind!.cards[0])).limitReached).toBe(true);
});

describe('source-specific intervals', () => {
  test('direct polling defaults to 2 minutes with no 30 s option; plugin mode keeps it', () => {
    expect(defaultIntervalFor('direct')).toBe(DEFAULT_DIRECT_INTERVAL_MS);
    expect(DEFAULT_DIRECT_INTERVAL_MS).toBe(120_000);
    expect(DEFAULT_PLUGIN_INTERVAL_MS).toBe(60_000);
    expect(DIRECT_INTERVALS_MS).toEqual([0, 120_000, 300_000]);
    expect(PLUGIN_INTERVALS_MS).toContain(30_000);
    expect(intervalsFor('direct')).not.toContain(30_000);
    expect(intervalsFor('plugin')).toContain(30_000);
  });
});

describe('plugin probe', () => {
  const original = apiClient.get.bind(apiClient);
  const withGet = async (get: (url: string) => Promise<unknown>, run: () => Promise<void>) => {
    apiClient.setConfig({ apiBase: 'http://argus.test:8317', managementKey: 'test-key' });
    (apiClient as unknown as { get: typeof get }).get = get;
    resetPoolBase();
    try {
      await run();
    } finally {
      (apiClient as unknown as { get: typeof original }).get = original;
      resetPoolBase();
    }
  };

  test('reads the v0 route on the server origin and parses a good answer', async () => {
    let seen = '';
    await withGet(
      async (url) => {
        seen = url;
        return response;
      },
      async () => {
        expect((await fetchPluginCards())?.cards).toHaveLength(3);
      }
    );
    expect(seen).toBe('http://argus.test:8317/v0/management/plugins/account-pool/quota/cards');
  });

  test('a missing route, an error or another shape means "no plugin" (null, never a throw)', async () => {
    await withGet(
      async () => {
        throw Object.assign(new Error('Not Found'), { status: 404 });
      },
      async () => expect(await fetchPluginCards()).toBeNull()
    );
    await withGet(
      async () => '<html>management</html>',
      async () => expect(await fetchPluginCards()).toBeNull()
    );
  });
});

/* ------------------------------ xAI cards ------------------------------ */

const XAI_WEEK_START = '2026-10-02T02:41:05.713506+00:00';
const XAI_WEEK_END = '2026-10-09T02:41:05.713506+00:00';

const xaiCardJson = (
  overrides: Record<string, unknown> = {},
  rawOverrides: Record<string, unknown> = {}
) => ({
  provider: 'xai',
  name: 'xai-william@bnc.rocks.json',
  display: 'william@bnc.rocks',
  email: 'william@bnc.rocks',
  disabled: false,
  source: 'poll',
  passive_at: null,
  data_at: 1_791_086_000,
  refresh_allowed_at: 1_791_085_940,
  backoff_until: null,
  last_error: null,
  kind: 'ok',
  normalized: {
    plan: 'XPremiumPlus',
    period: {
      type: 'weekly',
      start: 1_790_908_865,
      resets_at: 1_791_513_665,
      window_s: 604_800,
    },
    usage_percent: null,
    remaining_percent: null,
    measured: {
      source: 'proxy',
      since: 1_790_908_865,
      requests: 12,
      failed: 1,
      rate_limited: 0,
      input_tokens: 1200,
      output_tokens: 300,
      reasoning_tokens: 40,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      total_tokens: 1540,
      last_request_at: 1_791_085_990,
    },
    rate_limit: {
      limit_requests: 120,
      remaining_requests: 119,
      limit_tokens: 5_000_000,
      remaining_tokens: 4_999_000,
      at: 1_791_085_990,
    },
    on_demand: { cap_cents: 0, used_cents: 0 },
    prepaid_balance_cents: 0,
    monthly: { limit_cents: 0, used_cents: 0, start: 1_790_812_800, end: 1_793_491_200 },
    ...((overrides.normalized as Record<string, unknown> | undefined) ?? {}),
  },
  raw: {
    billing_weekly: {
      currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', start: XAI_WEEK_START, end: XAI_WEEK_END },
      onDemandCap: { val: 0 },
      onDemandUsed: { val: 0 },
      isUnifiedBillingUser: true,
      prepaidBalance: { val: 0 },
      billingPeriodStart: XAI_WEEK_START,
      billingPeriodEnd: XAI_WEEK_END,
    },
    billing_monthly: {
      monthlyLimit: { val: 0 },
      used: { val: 0 },
      onDemandCap: { val: 0 },
      billingPeriodStart: '2026-10-01T00:00:00+00:00',
      billingPeriodEnd: '2026-11-01T00:00:00+00:00',
    },
    user: { subscriptionTier: 'XPremiumPlus', hasGrokCodeAccess: true },
    ...rawOverrides,
  },
  ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'normalized')),
});

const xaiCard = (...args: Parameters<typeof xaiCardJson>) =>
  parsePluginCards({ cards: [xaiCardJson(...args)] })!.cards[0];

describe('xAI plugin cards', () => {
  test('xai is plugin-backed and its cards parse after Claude and Codex', () => {
    expect(isPluginBackedType('xai')).toBe(true);
    const parsed = parsePluginCards({ cards: [...response.cards.slice(0, 1), xaiCardJson()] });
    expect(parsed?.cards.map((card) => card.provider)).toEqual(['claude', 'xai']);
    expect(parsed?.cards[1].raw.user).toEqual({
      subscriptionTier: 'XPremiumPlus',
      hasGrokCodeAccess: true,
    });
  });

  test('maps billing through the shared builders, plan from the tier, and keeps measured and rate limit', () => {
    const data = xaiCardToData(xaiCard())!;
    expect(data.mode).toBe('billing');
    expect(data.periodType).toBe('weekly');
    expect(data.usagePercent).toBeNull();
    expect(data.periodEnd).toBe(XAI_WEEK_END);
    expect(data.resetAtMs).toBe(Date.parse(XAI_WEEK_END));
    expect(data.onDemandCapCents).toBe(0);
    expect(data.prepaidBalanceCents).toBe(0);
    expect(data.billingPeriodEnd).toBe('2026-11-01T00:00:00+00:00');
    expect(data.planLabel).toBe('X Premium+');
    expect(data.planTier).toBe('premium');
    expect(data.measured).toEqual({
      sinceMs: 1_790_908_865_000,
      requests: 12,
      failed: 1,
      rateLimited: 0,
      inputTokens: 1200,
      outputTokens: 300,
      reasoningTokens: 40,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 1540,
      lastRequestAtMs: 1_791_085_990_000,
    });
    expect(data.rateLimit).toEqual({
      limitRequests: 120,
      remainingRequests: 119,
      limitTokens: 5_000_000,
      remainingTokens: 4_999_000,
      atMs: 1_791_085_990_000,
    });
  });

  test('carries xAI creditUsagePercent when the weekly payload has it', () => {
    const weekly = (xaiCardJson().raw as { billing_weekly: Record<string, unknown> })
      .billing_weekly;
    const data = xaiCardToData(
      xaiCard({}, { billing_weekly: { ...weekly, creditUsagePercent: 37 } })
    )!;
    expect(data.usagePercent).toBe(37);
  });

  test('measured and rate_limit may be null', () => {
    const data = xaiCardToData(xaiCard({ normalized: { measured: null, rate_limit: null } }))!;
    expect(data.measured).toBeNull();
    expect(data.rateLimit).toBeNull();
    expect(data.usagePercent).toBeNull();
  });

  test('an all-null rate_limit counts as none, and a measured block without counts as none', () => {
    const data = xaiCardToData(
      xaiCard({
        normalized: {
          measured: { source: 'proxy' },
          rate_limit: { limit_requests: null, remaining_requests: null, at: 5 },
        },
      })
    )!;
    expect(data.measured).toBeNull();
    expect(data.rateLimit).toBeNull();
  });

  test('takes the plan from raw.user when normalized.plan is absent, and a spaced name stays as sent', () => {
    expect(xaiCardToData(xaiCard({ normalized: { plan: null } }))?.planLabel).toBe('X Premium+');
    expect(xaiCardToData(xaiCard({ normalized: { plan: 'SuperGrok Heavy' } }))).toMatchObject({
      planLabel: 'SuperGrok Heavy',
      planTier: 'elite',
    });
    expect(
      xaiCardToData(xaiCard({ normalized: { plan: null } }, { user: {} }))?.planLabel
    ).toBeUndefined();
  });

  test('rebuilds the weekly period from normalized when the raw billing payloads are missing', () => {
    const data = xaiCardToData(
      xaiCard({}, { billing_weekly: undefined, billing_monthly: undefined })
    )!;
    expect(data.periodType).toBe('weekly');
    expect(data.resetAtMs).toBe(1_791_513_665_000);
    expect(data.measured?.requests).toBe(12);
  });

  test('a card with no billing period at all has nothing to show', () => {
    expect(
      xaiCardToData(
        xaiCard(
          { normalized: { period: null } },
          { billing_weekly: undefined, billing_monthly: undefined }
        )
      )
    ).toBeNull();
  });
});

describe('account-pool -> claude-pool 404 fallback', () => {
  const originalGet = apiClient.get.bind(apiClient);
  const originalPost = apiClient.post.bind(apiClient);
  const notFound = () => Object.assign(new Error('Not Found'), { status: 404 });
  const base = 'http://argus.test:8317';

  const withClient = async (
    get: (url: string) => Promise<unknown>,
    run: () => Promise<void>,
    post: (url: string) => Promise<unknown> = async () => ({})
  ) => {
    apiClient.setConfig({ apiBase: base, managementKey: 'test-key' });
    (apiClient as unknown as { get: typeof get }).get = get;
    (apiClient as unknown as { post: typeof post }).post = post;
    resetPoolBase();
    try {
      await run();
    } finally {
      (apiClient as unknown as { get: typeof originalGet }).get = originalGet;
      (apiClient as unknown as { post: typeof originalPost }).post = originalPost;
      resetPoolBase();
    }
  };

  test('account-pool answering is used and the legacy path is never asked', async () => {
    const seen: string[] = [];
    await withClient(
      async (url) => {
        seen.push(url);
        return response;
      },
      async () => {
        expect(await fetchPluginCards()).not.toBeNull();
        expect(await fetchPluginCards()).not.toBeNull();
        expect(currentPoolBase()).toBe(ACCOUNT_POOL_BASE);
        expect(isLegacyPoolBase()).toBe(false);
        expect(isPluginBackedType('xai')).toBe(true);
      }
    );
    expect(seen).toEqual([
      `${base}${ACCOUNT_POOL_BASE}/quota/cards`,
      `${base}${ACCOUNT_POOL_BASE}/quota/cards`,
    ]);
  });

  test('a 404 on account-pool retries the legacy path once and sticks to what answered', async () => {
    const seen: string[] = [];
    const posted: string[] = [];
    await withClient(
      async (url) => {
        seen.push(url);
        if (url.includes('/account-pool/')) throw notFound();
        return response;
      },
      async () => {
        expect((await fetchPluginCards())?.cards).toHaveLength(3);
        expect(isLegacyPoolBase()).toBe(true);
        expect(currentPoolBase()).toBe(LEGACY_CLAUDE_POOL_BASE);
        // The legacy plugin serves no xAI cards, so xAI stays on the direct path.
        expect(isPluginBackedType('xai')).toBe(false);
        expect(isPluginBackedType('claude') && isPluginBackedType('codex')).toBe(true);
        expect((await fetchPluginCards())?.cards).toHaveLength(3);
        expect(await refreshPluginCard('claude-a.json')).toEqual({ ok: true });
      },
      async (url) => {
        posted.push(url);
        return {};
      }
    );
    expect(seen).toEqual([
      `${base}${ACCOUNT_POOL_BASE}/quota/cards`,
      `${base}${LEGACY_CLAUDE_POOL_BASE}/quota/cards`,
      `${base}${LEGACY_CLAUDE_POOL_BASE}/quota/cards`,
    ]);
    expect(posted).toEqual([`${base}${LEGACY_CLAUDE_POOL_BASE}/quota/refresh?name=claude-a.json`]);
  });

  test('404 on both is "no plugin", and a non-404 failure never tries the legacy path', async () => {
    const seen: string[] = [];
    await withClient(
      async (url) => {
        seen.push(url);
        throw notFound();
      },
      async () => expect(await fetchPluginCards()).toBeNull()
    );
    expect(seen).toHaveLength(2);

    const serverError: string[] = [];
    await withClient(
      async (url) => {
        serverError.push(url);
        throw Object.assign(new Error('boom'), { status: 500 });
      },
      async () => expect(await fetchPluginCards()).toBeNull()
    );
    expect(serverError).toEqual([`${base}${ACCOUNT_POOL_BASE}/quota/cards`]);
  });

  test('a resolved base that starts answering 404 is probed again', async () => {
    let upgraded = false;
    await withClient(
      async (url) => {
        if (url.includes('/account-pool/') && !upgraded) throw notFound();
        if (url.includes('/claude-pool/') && upgraded) throw notFound();
        return response;
      },
      async () => {
        await fetchPluginCards();
        expect(isLegacyPoolBase()).toBe(true);
        upgraded = true;
        expect(await fetchPluginCards()).toBeNull();
        expect(await fetchPluginCards()).not.toBeNull();
        expect(currentPoolBase()).toBe(ACCOUNT_POOL_BASE);
      }
    );
  });
});

describe('committing xAI cards into the quota store', () => {
  test('a ready card becomes a success state, an unread one an error state, others are untouched', () => {
    useQuotaStore.getState().clearQuotaCache();
    const parsed = parsePluginCards({
      cards: [
        xaiCardJson(),
        xaiCardJson({ name: 'xai-new.json', data_at: null, last_error: { msg: 'HTTP 502' } }),
      ],
    })!;
    commitPluginCards(parsed, 1_791_086_100_000);
    const { xaiQuota } = useQuotaStore.getState();
    expect(xaiQuota['xai-william@bnc.rocks.json']).toMatchObject({ status: 'success' });
    expect(xaiQuota['xai-william@bnc.rocks.json'].billing?.measured?.requests).toBe(12);
    expect(xaiQuota['xai-new.json']).toMatchObject({ status: 'error', error: 'HTTP 502' });
    useQuotaStore.getState().clearQuotaCache();
  });
});
