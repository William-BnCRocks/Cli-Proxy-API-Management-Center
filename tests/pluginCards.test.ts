import { describe, expect, test } from 'bun:test';
import { apiClient } from '@/services/api/client';
import {
  fetchPluginCards,
  PLUGIN_QUOTA_CARDS_PATH,
  PLUGIN_QUOTA_REFRESH_PATH,
  claudeCardToData,
  codexCardToData,
  isPluginBackedType,
  parsePluginCards,
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

// Shape of GET .../quota/cards (claude-pool), normalised block only, values rounded.
const response = {
  now: T0,
  plugin: 'claude-pool',
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

describe('claude-pool quota cards', () => {
  test('uses the v0 plugin routes', () => {
    expect(PLUGIN_QUOTA_CARDS_PATH).toBe('/v0/management/plugins/claude-pool/quota/cards');
    expect(PLUGIN_QUOTA_REFRESH_PATH).toBe('/v0/management/plugins/claude-pool/quota/refresh');
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
    try {
      await run();
    } finally {
      (apiClient as unknown as { get: typeof original }).get = original;
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
    expect(seen).toBe('http://argus.test:8317/v0/management/plugins/claude-pool/quota/cards');
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
