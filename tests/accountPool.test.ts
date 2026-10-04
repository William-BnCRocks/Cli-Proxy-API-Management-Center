import { describe, expect, test } from 'bun:test';
import {
  parseAccountPoolStatus,
  resolveAccountPoolInfo,
  ACCOUNT_POOL_STATUS_PATH,
} from '@/features/quota/accountPool';

// Shape of GET /v0/management/plugins/account-pool/status (v0.2.0), trimmed.
const raw = {
  version: '0.2.0',
  next_session: { name: 'claude-b.json', display: 'b@example.com' },
  accounts: [
    {
      name: 'claude-a.json',
      email: 'a@example.com',
      disabled: false,
      eligible: true,
      kind: 'eligible',
      reason: null,
      rank: 2,
      seven: { util: 0.58, plan: 0.078, elapsed: 0.078, slack: -0.5, resets_at: 1791518399 },
    },
    {
      name: 'claude-b.json',
      email: 'b@example.com',
      disabled: false,
      eligible: true,
      rank: 1,
      seven: { util: 0.07, plan: 0.078 },
    },
    {
      name: 'claude-c.json',
      email: 'c@example.com',
      eligible: false,
      kind: 'refused',
      reason: 'limit reached',
      rank: null,
      seven: {},
    },
  ],
};

describe('account-pool integration', () => {
  test('uses the v0 plugin route', () => {
    expect(ACCOUNT_POOL_STATUS_PATH).toBe('/v0/management/plugins/account-pool/status');
  });

  test('parses accounts and the next-session pick', () => {
    const status = parseAccountPoolStatus(raw);
    expect(status?.accounts).toHaveLength(3);
    expect(status?.nextSessionName).toBe('claude-b.json');
    expect(status?.version).toBe('0.2.0');
  });

  test('rejects anything that is not the status shape', () => {
    expect(parseAccountPoolStatus(null)).toBeNull();
    expect(parseAccountPoolStatus('<html>')).toBeNull();
    expect(parseAccountPoolStatus({ accounts: 'x' })).toBeNull();
    expect(parseAccountPoolStatus({ accounts: [null, 3, {}] })?.accounts).toEqual([]);
  });

  test('resolves per-card info with rank, pace and next-session flag', () => {
    const status = parseAccountPoolStatus(raw);
    const a = resolveAccountPoolInfo(status, { name: 'claude-a.json', email: 'a@example.com' });
    expect(a).toMatchObject({ rank: 2, rankedCount: 2, isNext: false, eligible: true });
    expect(a?.actualUsedPercent).toBeCloseTo(58, 5);
    expect(a?.plannedUsedPercent).toBeCloseTo(7.8, 5);
    const b = resolveAccountPoolInfo(status, { name: 'claude-b.json', email: 'b@example.com' });
    expect(b?.isNext).toBe(true);
    const c = resolveAccountPoolInfo(status, { name: 'claude-c.json', email: 'c@example.com' });
    expect(c).toMatchObject({ rank: null, eligible: false, reason: 'limit reached' });
    expect(c?.plannedUsedPercent).toBeNull();
  });

  test('falls back to a unique e-mail match and otherwise returns null', () => {
    const status = parseAccountPoolStatus(raw);
    expect(
      resolveAccountPoolInfo(status, { name: 'renamed.json', email: 'a@example.com' })?.rank
    ).toBe(2);
    expect(
      resolveAccountPoolInfo(status, { name: 'other.json', email: 'z@example.com' })
    ).toBeNull();
    expect(resolveAccountPoolInfo(null, { name: 'claude-a.json' })).toBeNull();
  });
});
