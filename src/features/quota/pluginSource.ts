/**
 * Glue between the claude-pool card cache and the quota store: commit a cards
 * response into the Claude/Codex quota maps, and run the plugin-side refresh.
 * No upstream (Anthropic/ChatGPT) request is ever made from here.
 */

import { captureQuotaCacheGeneration, commitIfQuotaCacheCurrent } from '@/stores';
import { currentLiveKey, useQuotaLiveStore } from './liveStore';
import {
  claudeCardToData,
  codexCardToData,
  fetchPluginCards,
  refreshPluginCard,
  type PluginCard,
  type PluginCardsResponse,
} from './pluginCards';
import { QUOTA_ADAPTERS, getQuotaSetter, type QuotaCardState } from './providers';

/** Cards that exist but have never been read have nothing to show yet. */
const emptyReason = (card: PluginCard): string =>
  card.lastError ?? (card.kind ? `no data yet (${card.kind})` : 'no data yet');

export function commitPluginCards(response: PluginCardsResponse, nowMs: number = Date.now()): void {
  const generation = captureQuotaCacheGeneration();
  commitIfQuotaCacheCurrent(generation, () => {
    for (const type of ['claude', 'codex'] as const) {
      const adapter = QUOTA_ADAPTERS[type];
      const next: Record<string, QuotaCardState> = {};
      for (const card of response.cards) {
        if (card.provider !== type) continue;
        if (card.dataAtMs === null) {
          next[card.name] = adapter.buildErrorState(emptyReason(card));
          continue;
        }
        const data = type === 'claude' ? claudeCardToData(card) : codexCardToData(card);
        next[card.name] = adapter.buildSuccessState(data);
        useQuotaLiveStore.getState().recordSuccess(currentLiveKey(type, card.name), nowMs, {
          source: card.source,
          at: card.dataAtMs,
        });
      }
      if (Object.keys(next).length === 0) continue;
      getQuotaSetter(adapter)((prev) => ({ ...prev, ...next }));
    }
  });
}

/** Fetch the plugin's cards and commit them; null when the plugin route is not available. */
export async function syncPluginCards(): Promise<PluginCardsResponse | null> {
  const response = await fetchPluginCards();
  if (response) commitPluginCards(response);
  return response;
}

export type PluginRefreshOutcome =
  { kind: 'requested' } | { kind: 'throttled'; waitS: number } | { kind: 'failed' };

/**
 * Ask the plugin to re-poll one credential, then pull the cards (immediately, so a
 * throttle answer shows the wait, and again once the plugin has had time to poll).
 */
export async function requestPluginRefresh(name: string): Promise<PluginRefreshOutcome> {
  const result = await refreshPluginCard(name);
  if (result.ok) {
    window.setTimeout(() => void syncPluginCards(), 2000);
    window.setTimeout(() => void syncPluginCards(), 8000);
    return { kind: 'requested' };
  }
  if (!result.throttled) return { kind: 'failed' };
  const response = await syncPluginCards();
  const allowedAt = response?.cards.find((card) => card.name === name)?.refreshAllowedAtMs ?? null;
  const waitS = allowedAt === null ? 60 : Math.max(1, Math.ceil((allowedAt - Date.now()) / 1000));
  return { kind: 'throttled', waitS };
}
