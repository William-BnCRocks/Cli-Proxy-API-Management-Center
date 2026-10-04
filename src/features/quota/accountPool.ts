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
import { getStatusFromError } from '@/utils/quota';

export const ACCOUNT_POOL_BASE = '/v0/management/plugins/account-pool';
export const ACCOUNT_POOL_STATUS_PATH = `${ACCOUNT_POOL_BASE}/status`;

/**
 * TEMPORARY (one release): the plugin used to be called `claude-pool`. A panel
 * that is upgraded before the plugin finds the old routes only there, so a 404
 * from the account-pool route is retried once on the legacy base and the base
 * that answered is used from then on. Delete this block, `poolGet`,
 * `currentPoolBase` and `isLegacyPoolBase` once every plugin runs as `account-pool`.
 */
export const LEGACY_CLAUDE_POOL_BASE = '/v0/management/plugins/claude-pool';

let resolvedBase: string | null = null;

/** Base the plugin answered on; account-pool until a probe has said otherwise. */
export const currentPoolBase = (): string => resolvedBase ?? ACCOUNT_POOL_BASE;

/** True while only the legacy claude-pool routes answer (that plugin serves no xAI cards). */
export const isLegacyPoolBase = (): boolean => resolvedBase === LEGACY_CLAUDE_POOL_BASE;

/** Forget the resolved base (tests; the next call probes again). */
export const resetPoolBase = (): void => {
  resolvedBase = null;
};

/**
 * GET a plugin route (`suffix` starts with `/`). Uses the resolved base; with none
 * resolved yet it tries account-pool and, on a 404 only, the legacy base once. A 404
 * on a resolved base clears it, so a plugin upgraded mid-visit is found again.
 */
export async function poolGet(origin: string, suffix: string): Promise<unknown> {
  const read = (base: string) => apiClient.get(`${origin}${base}${suffix}`);
  if (resolvedBase) {
    try {
      return await read(resolvedBase);
    } catch (err) {
      if (getStatusFromError(err) === 404) resolvedBase = null;
      throw err;
    }
  }
  try {
    const answer = await read(ACCOUNT_POOL_BASE);
    resolvedBase = ACCOUNT_POOL_BASE;
    return answer;
  } catch (err) {
    if (getStatusFromError(err) !== 404) throw err;
  }
  const answer = await read(LEGACY_CLAUDE_POOL_BASE);
  resolvedBase = LEGACY_CLAUDE_POOL_BASE;
  return answer;
}

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
    return parseAccountPoolStatus(await poolGet(origin, '/status'));
  } catch {
    return null;
  }
}
