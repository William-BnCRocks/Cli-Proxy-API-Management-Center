/**
 * OpenCode Go card: parsing the plugin's opencode-go card, the section's
 * visibility rules and the rendered panel (capped / free / unpriced models,
 * empty list, limit events). The numbers are the plugin's estimate and are
 * never labelled as official usage.
 */

import { beforeAll, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '@/i18n';
import { OpencodeGoCard } from '@/features/quota/components/OpencodeGoCard';
import {
  opencodeGoCardToData,
  pickOpencodeGoCard,
  useOpencodeGoStore,
  windowRemainingPercent,
} from '@/features/quota/opencodeGo';
import { commitPluginCards } from '@/features/quota/pluginSource';
import { parsePluginCards } from '@/features/quota/pluginCards';
import { QUOTA_CLASS_KEYS, bindQuotaClasses } from '@/features/quota/types';
import { useQuotaStore } from '@/stores/useQuotaStore';
import { formatInstantShort } from '@/utils/quota';

const classes = bindQuotaClasses(
  Object.fromEntries(QUOTA_CLASS_KEYS.map((key) => [key, key])),
  'test-host'
);

const T0 = 1_791_086_000;

const win = (
  id: string,
  label: string,
  windowS: number,
  cap: number | null,
  used: number | null,
  percent: number | null
) => ({
  id,
  label,
  window_s: windowS,
  cap_usd: cap,
  used_usd: used,
  used_percent: percent,
  remaining_percent: percent === null ? null : 100 - percent,
  requests: 4,
});

const kimi = {
  model: 'kimi-k3',
  label: 'Kimi K3',
  cap_usd: 15,
  requests: 10,
  last_request_at: T0,
  unpriced: false,
  tokens: { input: 1_200_000, output: 300_000, cache_read: 2_000_000, cache_write: 0 },
  windows: [
    win('five-hour', '5-hour', 18000, 3, 1.23, 41),
    win('weekly', 'Weekly', 604800, 7.5, 1.23, 16.4),
    win('monthly', 'Monthly', 2592000, 15, 1.23, 8.2),
  ],
};
const freeModel = {
  model: 'big-pickle',
  label: 'Big Pickle',
  cap_usd: null,
  requests: 3,
  last_request_at: null,
  unpriced: false,
  tokens: { input: 900, output: 100, cache_read: 0, cache_write: 0 },
  windows: [
    win('five-hour', '5-hour', 18000, null, 0, null),
    win('monthly', 'Monthly', 2592000, null, 0, null),
  ],
};
const unpricedModel = {
  model: 'mystery-9',
  label: 'Mystery 9',
  cap_usd: null,
  requests: 2,
  last_request_at: T0 - 60,
  unpriced: true,
  tokens: { input: 5_000, output: 700, cache_read: 0, cache_write: 0 },
  windows: [win('monthly', 'Monthly', 2592000, null, null, null)],
};

const cardJson = (
  normalized: Record<string, unknown> = {},
  extra: Record<string, unknown> = {}
) => ({
  provider: 'opencode-go',
  name: 'opencode-go',
  display: 'OpenCode Go',
  disabled: false,
  kind: 'ok',
  reason: null,
  source: 'proxy',
  data_at: T0,
  normalized: {
    plan: 'go',
    plan_label: 'Go',
    rule: { five_hour: 0.2, weekly: 0.5, monthly: 1.0 },
    rolling: true,
    pricing: { source: 'https://opencode.ai/docs/go', as_of: '2026-10-04' },
    models: [kimi, freeModel, unpricedModel],
    totals: { monthly_usd: 1.23, requests: 15 },
    limit_events: [],
    ...normalized,
  },
  raw: {},
  ...extra,
});

const cardFor = (...args: Parameters<typeof cardJson>) =>
  parsePluginCards({ cards: [cardJson(...args)] })!.cards[0];

const render = (data: ReturnType<typeof opencodeGoCardToData>, extra = {}): string =>
  renderToStaticMarkup(createElement(OpencodeGoCard, { data, classes, ...extra }));

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

describe('opencode-go card parsing', () => {
  test('parses the plugin card, ignoring extra fields', () => {
    const data = opencodeGoCardToData(cardFor({ surprise: { a: 1 } }, { extra_top_level: true }));
    expect(data.planLabel).toBe('Go');
    expect(data.rule).toEqual({ fiveHour: 0.2, weekly: 0.5, monthly: 1 });
    expect(data.rolling).toBe(true);
    expect(data.pricingAsOf).toBe('2026-10-04');
    expect(data.models.map((m) => m.model)).toEqual(['kimi-k3', 'big-pickle', 'mystery-9']);
    expect(data.models[0]).toMatchObject({
      capUsd: 15,
      requests: 10,
      lastRequestAtMs: T0 * 1000,
      unpriced: false,
      tokens: { input: 1_200_000, output: 300_000, cacheRead: 2_000_000, cacheWrite: 0 },
    });
    expect(data.models[0].windows).toHaveLength(3);
    expect(data.models[1].capUsd).toBeNull();
    expect(data.models[2].unpriced).toBe(true);
    expect(data.totalMonthlyUsd).toBe(1.23);
    expect(data.dataAtMs).toBe(T0 * 1000);
  });

  test('tolerates a bare card: every field is optional', () => {
    const data = opencodeGoCardToData(
      cardFor({
        models: undefined,
        pricing: undefined,
        rule: undefined,
        totals: undefined,
        plan_label: undefined,
        plan: undefined,
      })
    );
    expect(data.models).toEqual([]);
    expect(data.rule).toBeNull();
    expect(data.pricingAsOf).toBeNull();
    expect(data.totalMonthlyUsd).toBeNull();
    expect(data.planLabel).toBeNull();
  });

  test('remaining share is the plugin figure, derived from used when absent, null when uncapped', () => {
    const [five] = opencodeGoCardToData(cardFor()).models[0].windows;
    expect(windowRemainingPercent(five)).toBe(59);
    expect(windowRemainingPercent({ ...five, remainingPercent: null })).toBe(59);
    expect(windowRemainingPercent({ ...five, remainingPercent: null, usedPercent: 130 })).toBe(0);
    expect(windowRemainingPercent({ ...five, capUsd: null })).toBeNull();
  });

  test('only an enabled, non-off opencode-go card is picked', () => {
    expect(pickOpencodeGoCard(parsePluginCards({ cards: [cardJson()] })!.cards)?.name).toBe(
      'opencode-go'
    );
    for (const extra of [{ kind: 'off' }, { disabled: true }]) {
      expect(
        pickOpencodeGoCard(parsePluginCards({ cards: [cardJson({}, extra)] })!.cards)
      ).toBeNull();
    }
    expect(pickOpencodeGoCard([])).toBeNull();
  });
});

describe('opencode-go store commit', () => {
  test('stores the card, clears it when the plugin stops serving it, and tags the generation', () => {
    useQuotaStore.getState().clearQuotaCache();
    commitPluginCards(parsePluginCards({ cards: [cardJson()] })!);
    const stored = useOpencodeGoStore.getState();
    expect(stored.data?.models).toHaveLength(3);
    expect(stored.generation).toBe(useQuotaStore.getState().cacheGeneration);

    commitPluginCards(parsePluginCards({ cards: [] })!);
    expect(useOpencodeGoStore.getState().data).toBeNull();

    commitPluginCards(parsePluginCards({ cards: [cardJson({}, { kind: 'off' })] })!);
    expect(useOpencodeGoStore.getState().data).toBeNull();
    useQuotaStore.getState().clearQuotaCache();
  });

  test('does not touch the auth-file quota maps', () => {
    useQuotaStore.getState().clearQuotaCache();
    commitPluginCards(parsePluginCards({ cards: [cardJson()] })!);
    const state = useQuotaStore.getState();
    expect(Object.keys(state.claudeQuota)).toEqual([]);
    expect(Object.keys(state.xaiQuota)).toEqual([]);
    useOpencodeGoStore.getState().set(null, -1);
    useQuotaStore.getState().clearQuotaCache();
  });
});

describe('OpencodeGoCard rendering', () => {
  // Rendered after beforeAll has pinned the language (a describe-time render would read the default).
  let markup = '';
  beforeAll(() => {
    markup = render(opencodeGoCardToData(cardFor()));
  });

  test('header: plan, estimate wording, pricing date, rule and totals; never "official"', () => {
    expect(markup).toContain('OpenCode Go');
    expect(markup).toContain(
      'Estimated at OpenCode Go list prices · traffic through this proxy only'
    );
    expect(markup).toContain('Prices as of 2026-10-04');
    expect(markup).toContain('5-hour 20% · weekly 50% · monthly 100%');
    expect(markup).toContain('rolling windows');
    expect(markup).toContain('Last 30 days: $1.23 · 15 requests');
    expect(markup.toLowerCase()).not.toContain('official');
  });

  test('capped model: three meters with $used / $cap and remaining %, requests and last use', () => {
    expect(markup).toContain('Kimi K3');
    expect(markup).toContain('cap $15.00 / month');
    expect(markup).toContain('$1.23 / $3.00');
    expect(markup).toContain('$1.23 / $7.50');
    expect(markup).toContain('$1.23 / $15.00');
    expect(markup).toContain('59% left');
    expect(markup).toContain('84% left');
    expect(markup).toContain('92% left');
    expect((markup.match(/quotaBarFill /g) ?? []).length).toBe(3);
    expect(markup).toContain('10 requests');
    expect(markup).toContain(`last used ${formatInstantShort(T0 * 1000)}`);
    expect(markup).toContain('in 1.2M · out 300K · cache 2M read / 0 written');
  });

  test('free model: usage without a meter; unpriced model: tokens and "Price unknown"', () => {
    expect(markup).toContain('Big Pickle');
    expect(markup).toContain('No cap');
    expect(markup).toContain('$0.00 used');
    expect(markup).toContain('Mystery 9');
    expect(markup).toContain('Price unknown');
    expect(markup).toContain('in 5K · out 700');
    // Only the capped model has meters.
    expect((markup.match(/quotaBarFill /g) ?? []).length).toBe(3);
    expect(markup).not.toContain('NaN');
  });

  test('keeps the plugin order (most constrained first)', () => {
    expect(markup.indexOf('Kimi K3')).toBeLessThan(markup.indexOf('Big Pickle'));
    expect(markup.indexOf('Big Pickle')).toBeLessThan(markup.indexOf('Mystery 9'));
  });

  test('empty models list (no_data) says there is no traffic yet', () => {
    const empty = render(
      opencodeGoCardToData(
        cardFor(
          { models: [], totals: { monthly_usd: 0, requests: 0 } },
          { kind: 'no_data', data_at: null }
        )
      )
    );
    expect(empty).toContain('No OpenCode Go traffic recorded through this proxy yet.');
    expect(empty).toContain('Estimated at OpenCode Go list prices');
    expect(empty).not.toContain('Kimi K3');
  });

  test('limit events are listed, newest first, long messages cut, markup escaped', () => {
    const events = [
      { t: T0 - 100, model: 'old-model', status: 429, message: 'older' },
      { t: T0, model: 'kimi-k3', status: 429, message: `<b>slow down</b>${'x'.repeat(300)}` },
      { t: T0 - 50, model: null, status: null, message: null },
    ];
    const out = render(opencodeGoCardToData(cardFor({ limit_events: events })));
    expect(out).toContain('Limit events');
    expect(out).toContain('HTTP 429');
    expect(out.indexOf('kimi-k3 · HTTP 429')).toBeLessThan(out.indexOf('old-model'));
    expect(out).toContain('&lt;b&gt;slow down&lt;/b&gt;');
    expect(out).not.toContain('<b>slow down');
    expect(out).toContain('…');
    expect(render(opencodeGoCardToData(cardFor()))).not.toContain('Limit events');
  });

  test('footer shows the age and a refresh button only when asked', () => {
    const data = opencodeGoCardToData(cardFor());
    const withFooter = render(data, { now: T0 * 1000 + 90_000, onRefresh: () => {} });
    expect(withFooter).toContain('Updated 1m ago');
    expect(withFooter).toContain('Refresh');
    expect(render(data)).not.toContain('Refresh');
  });
});
