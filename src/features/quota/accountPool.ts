/**
 * Optional integration with the `account-pool` CPA plugin.
 *
 * The plugin serves `GET /v0/management/plugins/account-pool/status` (note v0:
 * plugin routes keep their backend-declared path). When that call succeeds, the
 * Claude cards show the account's rank, a "next new session" badge and a pace
 * marker on the 7-day bar. When it fails for any reason (plugin absent,
 * disabled, older shape) the panel behaves exactly as without it.
 *
 * Shapes only; React-free so tests/accountPool.test.ts can consume it.
 */

import { apiClient } from '@/services/api/client';
import type { AuthFileItem } from '@/types';

export const ACCOUNT_POOL_STATUS_PATH = '/v0/management/plugins/account-pool/status';

export interface AccountPoolAccount {
  name: string;
  email: string | null;
  disabled: boolean;
  eligible: boolean;
  /** 1-based position in the plugin's ranking; null when not ranked. */
  rank: number | null;
  kind: string | null;
  reason: string | null;
  /** 7-day utilisation actually used, 0..1. */
  sevenUtil: number | null;
  /** 7-day utilisation the plugin planned for by now, 0..1. */
  sevenPlan: number | null;
}

export interface AccountPoolStatus {
  version: string | null;
  accounts: AccountPoolAccount[];
  nextSessionName: string | null;
}

/** What one card needs. */
export interface AccountPoolInfo {
  rank: number | null;
  /** Ranked accounts in the pool (denominator for "#2 of 4"). */
  rankedCount: number;
  isNext: boolean;
  eligible: boolean;
  kind: string | null;
  reason: string | null;
  /** Percent of the 7-day allowance the plan says should be used by now. */
  plannedUsedPercent: number | null;
  /** Percent actually used. */
  actualUsedPercent: number | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const str = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value : null;

export function parseAccountPoolStatus(raw: unknown): AccountPoolStatus | null {
  if (!isRecord(raw) || !Array.isArray(raw.accounts)) return null;
  const accounts: AccountPoolAccount[] = [];
  for (const item of raw.accounts) {
    if (!isRecord(item)) continue;
    const name = str(item.name);
    if (!name) continue;
    const seven = isRecord(item.seven) ? item.seven : {};
    accounts.push({
      name,
      email: str(item.email),
      disabled: item.disabled === true,
      eligible: item.eligible === true,
      rank: num(item.rank),
      kind: str(item.kind),
      reason: str(item.reason),
      sevenUtil: num(seven.util),
      sevenPlan: num(seven.plan),
    });
  }
  const next = isRecord(raw.next_session) ? str(raw.next_session.name) : null;
  return { version: str(raw.version), accounts, nextSessionName: next };
}

/** Match by credential file name; fall back to a unique e-mail match. */
export function resolveAccountPoolInfo(
  status: AccountPoolStatus | null,
  file: Pick<AuthFileItem, 'name' | 'email'>
): AccountPoolInfo | null {
  if (!status) return null;
  let account = status.accounts.find((candidate) => candidate.name === file.name);
  if (!account && typeof file.email === 'string' && file.email) {
    const matches = status.accounts.filter((candidate) => candidate.email === file.email);
    if (matches.length === 1) account = matches[0];
  }
  if (!account) return null;
  const toPercent = (value: number | null) => (value === null ? null : value * 100);
  return {
    rank: account.rank,
    rankedCount: status.accounts.filter((candidate) => candidate.rank !== null).length,
    isNext: status.nextSessionName !== null && status.nextSessionName === account.name,
    eligible: account.eligible,
    kind: account.kind,
    reason: account.reason,
    plannedUsedPercent: toPercent(account.sevenPlan),
    actualUsedPercent: toPercent(account.sevenUtil),
  };
}

/** Null on any failure: the integration is strictly optional. */
export async function fetchAccountPoolStatus(): Promise<AccountPoolStatus | null> {
  const origin = apiClient.getServerOrigin();
  if (!origin) return null;
  try {
    return parseAccountPoolStatus(await apiClient.get(`${origin}${ACCOUNT_POOL_STATUS_PATH}`));
  } catch {
    return null;
  }
}
