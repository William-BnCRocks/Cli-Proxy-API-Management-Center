/**
 * xAI quota body, account-pool data: what the proxy measured for the current
 * period and the rate-limit headroom. The measured numbers are counts, never a
 * percentage of an xAI allowance, and never replace a percent xAI reports.
 */

import { beforeAll, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '@/i18n';
import { XaiQuotaBody } from '@/features/quota/providers/xai/XaiQuotaBody';
import { QUOTA_CLASS_KEYS, bindQuotaClasses } from '@/features/quota/types';
import { buildXaiBillingSummary, mergeXaiBillingSummaries } from '@/utils/quota';
import { formatCompactNumber } from '@/utils/format';
import type {
  XaiBillingConfig,
  XaiMeasuredUsage,
  XaiQuotaState,
  XaiRateLimitHeadroom,
} from '@/types';

const classes = bindQuotaClasses(
  Object.fromEntries(QUOTA_CLASS_KEYS.map((key) => [key, key])),
  'test-host'
);

const START = '2026-10-02T02:41:05.713506+00:00';
const END = '2026-10-09T02:41:05.713506+00:00';

const weekly = (extra: XaiBillingConfig = {}): XaiBillingConfig => ({
  currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', start: START, end: END },
  billingPeriodStart: START,
  billingPeriodEnd: END,
  onDemandCap: { val: 0 },
  ...extra,
});

const measured = (extra: Partial<XaiMeasuredUsage> = {}): XaiMeasuredUsage => ({
  sinceMs: Date.parse(START),
  requests: 12,
  failed: 1,
  rateLimited: 2,
  inputTokens: 3_000_000,
  outputTokens: 400_000,
  reasoningTokens: 40,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 3_400_000,
  lastRequestAtMs: Date.parse(START) + 1000,
  ...extra,
});

const rateLimit = (extra: Partial<XaiRateLimitHeadroom> = {}): XaiRateLimitHeadroom => ({
  limitRequests: 120,
  remainingRequests: 119,
  limitTokens: 5_000_000,
  remainingTokens: 4_000_000,
  atMs: null,
  ...extra,
});

const quotaFor = (
  config: XaiBillingConfig,
  extra: { measured?: XaiMeasuredUsage | null; rateLimit?: XaiRateLimitHeadroom | null }
): XaiQuotaState => {
  const billing = mergeXaiBillingSummaries(buildXaiBillingSummary(config), null);
  if (!billing) throw new Error('missing billing');
  return { status: 'success', billing: { ...billing, ...extra } };
};

const render = (quota: XaiQuotaState): string =>
  renderToStaticMarkup(createElement(XaiQuotaBody, { quota, classes }));

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

describe('XaiQuotaBody measured usage', () => {
  test('percent unknown: weekly row keeps its reset, says not reported, shows the proxy numbers', () => {
    const markup = render(quotaFor(weekly(), { measured: measured(), rateLimit: rateLimit() }));

    expect(markup).toContain('Weekly limit');
    expect(markup).toContain('Not reported by xAI for this plan');
    expect(markup).not.toContain('Usage unavailable from xAI');
    expect(markup).not.toContain('Used --');
    expect(markup).toContain('Resets');
    expect(markup).toContain('Through this proxy this week');
    expect(markup).toContain(`12 requests · ${formatCompactNumber(3_400_000)} tokens`);
    expect(markup).toContain('3.4M tokens');
    // Secondary line: split, failed / rate-limited counts and the start of the measured period.
    expect(markup).toContain('input 3M');
    expect(markup).toContain('output 400K');
    expect(markup).toContain('reasoning 40');
    expect(markup).toContain('1 failed');
    expect(markup).toContain('2 rate-limited');
    expect(markup).toContain('since ');
    // Tooltip says it is the proxy's own count.
    expect(markup).toContain('not an xAI figure');
    // No meter and no percentage derived from the measured counts.
    expect(markup).not.toContain('Used ');
  });

  test('one request is singular', () => {
    const markup = render(
      quotaFor(weekly(), { measured: measured({ requests: 1, totalTokens: 900 }) })
    );
    expect(markup).toContain('1 request · 900 tokens');
  });

  test('rate limit headroom line', () => {
    const markup = render(quotaFor(weekly(), { measured: measured(), rateLimit: rateLimit() }));
    expect(markup).toContain('Rate limit headroom: 119/120 requests · 4M/5M tokens');
  });

  test('rate limit without measured still renders, with missing halves as dashes', () => {
    const markup = render(
      quotaFor(weekly(), {
        measured: null,
        rateLimit: rateLimit({ limitRequests: null, limitTokens: null, remainingTokens: 7 }),
      })
    );
    expect(markup).toContain('Rate limit headroom: 119/-- requests · 7/-- tokens');
    expect(markup).not.toContain('Through this proxy');
    // Measured absent and percent unknown: the original wording.
    expect(markup).toContain('Usage unavailable from xAI');
  });

  test('cache split appears only when there is cache traffic', () => {
    expect(render(quotaFor(weekly(), { measured: measured() }))).not.toContain('cache ');
    const markup = render(
      quotaFor(weekly(), { measured: measured({ cacheReadTokens: 2000, cacheWriteTokens: 500 }) })
    );
    expect(markup).toContain('cache 2K read / 500 written');
  });

  test('measured null and rate limit null add nothing', () => {
    const markup = render(quotaFor(weekly(), { measured: null, rateLimit: null }));
    expect(markup).not.toContain('Through this proxy');
    expect(markup).not.toContain('Rate limit headroom');
    expect(markup).toContain('Usage unavailable from xAI');
  });

  test('when xAI reports a percent the meter stays primary and the measured row is secondary', () => {
    const markup = render(
      quotaFor(weekly({ creditUsagePercent: 37 }), { measured: measured(), rateLimit: rateLimit() })
    );
    expect(markup).toContain('Used 37%');
    expect(markup).not.toContain('Not reported by xAI for this plan');
    expect(markup).not.toContain('Usage unavailable from xAI');
    expect(markup).toContain('quotaBarFill');
    expect(markup.indexOf('Used 37%')).toBeLessThan(markup.indexOf('Through this proxy'));
    expect(markup).toContain('Through this proxy this week');
  });
});
