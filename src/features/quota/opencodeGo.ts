/**
 * OpenCode Go usage card from the account-pool plugin.
 *
 * OpenCode Go is a config-based API key, not an auth file, and has no usage API:
 * the plugin estimates usage from the tokens it recorded through the proxy and
 * Go's list prices, against Go's per-model caps. Nothing here is "official"
 * usage and there is no direct-path fallback, so the section only exists while
 * the plugin serves an `opencode-go` card.
 *
 * Shapes, the card parser and the small store the Quota page reads. React-free
 * so tests/opencodeGo.test.ts can consume it.
 */

import { create } from 'zustand';
import type { PluginCard } from './pluginCards';

export interface OpencodeGoWindow {
  /** `five-hour`, `weekly`, `monthly` (anything else is shown with its own label). */
  id: string;
  label: string;
  windowS: number | null;
  /** Null for uncapped (free) models. */
  capUsd: number | null;
  /** Null for unpriced models. */
  usedUsd: number | null;
  usedPercent: number | null;
  remainingPercent: number | null;
  requests: number | null;
}

export interface OpencodeGoModel {
  model: string;
  label: string;
  /** Monthly cap in USD; null for free/uncapped models. */
  capUsd: number | null;
  requests: number;
  lastRequestAtMs: number | null;
  /** True when Go publishes no list price for the model, so cost cannot be estimated. */
  unpriced: boolean;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  windows: OpencodeGoWindow[];
}

export interface OpencodeGoLimitEvent {
  atMs: number | null;
  model: string | null;
  status: number | null;
  message: string | null;
}

export interface OpencodeGoData {
  /** `ok`, `no_data` or `off` (anything else is treated like ok). */
  kind: string | null;
  planLabel: string | null;
  /** Window sizes as a share of the monthly cap (0..1). */
  rule: { fiveHour: number | null; weekly: number | null; monthly: number | null } | null;
  rolling: boolean;
  pricingSource: string | null;
  pricingAsOf: string | null;
  models: OpencodeGoModel[];
  totalMonthlyUsd: number | null;
  totalRequests: number | null;
  limitEvents: OpencodeGoLimitEvent[];
  dataAtMs: number | null;
}

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const str = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value : null;
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const ms = (value: unknown): number | null => {
  const seconds = num(value);
  return seconds === null ? null : seconds * 1000;
};

function parseWindow(value: unknown): OpencodeGoWindow | null {
  if (!isRecord(value)) return null;
  const id = str(value.id);
  if (!id) return null;
  return {
    id,
    label: str(value.label) ?? id,
    windowS: num(value.window_s),
    capUsd: num(value.cap_usd),
    usedUsd: num(value.used_usd),
    usedPercent: num(value.used_percent),
    remainingPercent: num(value.remaining_percent),
    requests: num(value.requests),
  };
}

function parseModel(value: unknown): OpencodeGoModel | null {
  if (!isRecord(value)) return null;
  const model = str(value.model);
  if (!model) return null;
  const tokens = isRecord(value.tokens) ? value.tokens : {};
  return {
    model,
    label: str(value.label) ?? model,
    capUsd: num(value.cap_usd),
    requests: num(value.requests) ?? 0,
    lastRequestAtMs: ms(value.last_request_at),
    unpriced: value.unpriced === true,
    tokens: {
      input: num(tokens.input) ?? 0,
      output: num(tokens.output) ?? 0,
      cacheRead: num(tokens.cache_read) ?? 0,
      cacheWrite: num(tokens.cache_write) ?? 0,
    },
    windows: arr(value.windows)
      .map(parseWindow)
      .filter((window): window is OpencodeGoWindow => window !== null),
  };
}

/** The card as display data; extra fields are ignored and every missing one is optional. */
export function opencodeGoCardToData(card: PluginCard): OpencodeGoData {
  const n = card.normalized;
  const rule = isRecord(n.rule) ? n.rule : null;
  const pricing = isRecord(n.pricing) ? n.pricing : null;
  const totals = isRecord(n.totals) ? n.totals : null;
  return {
    kind: card.kind,
    planLabel: str(n.plan_label) ?? str(n.plan),
    rule: rule
      ? { fiveHour: num(rule.five_hour), weekly: num(rule.weekly), monthly: num(rule.monthly) }
      : null,
    rolling: n.rolling === true,
    pricingSource: pricing ? str(pricing.source) : null,
    pricingAsOf: pricing ? str(pricing.as_of) : null,
    models: arr(n.models)
      .map(parseModel)
      .filter((model): model is OpencodeGoModel => model !== null),
    totalMonthlyUsd: totals ? num(totals.monthly_usd) : null,
    totalRequests: totals ? num(totals.requests) : null,
    limitEvents: arr(n.limit_events)
      .filter(isRecord)
      .map((event) => ({
        atMs: ms(event.t),
        model: str(event.model),
        status: num(event.status),
        message: str(event.message),
      })),
    dataAtMs: card.dataAtMs,
  };
}

/** The card to show, or null (absent, disabled or `off`): the section is hidden then. */
export function pickOpencodeGoCard(cards: readonly PluginCard[]): PluginCard | null {
  const card = cards.find((item) => item.provider === 'opencode-go');
  if (!card || card.disabled || card.kind === 'off') return null;
  return card;
}

/** Remaining share of a window, 0..100: the plugin's figure, else derived from the used share. */
export function windowRemainingPercent(window: OpencodeGoWindow): number | null {
  if (window.capUsd === null) return null;
  if (window.remainingPercent !== null) return window.remainingPercent;
  return window.usedPercent === null ? null : Math.max(0, 100 - window.usedPercent);
}

interface OpencodeGoStoreState {
  data: OpencodeGoData | null;
  /** Quota cache generation the data was read under; a reconnect makes it stale. */
  generation: number;
  set: (data: OpencodeGoData | null, generation: number) => void;
}

export const useOpencodeGoStore = create<OpencodeGoStoreState>((set) => ({
  data: null,
  generation: -1,
  set: (data, generation) => set({ data, generation }),
}));
