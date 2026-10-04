/**
 * Connected OpenCode Go panel: shown only while the account-pool plugin serves an
 * `opencode-go` card (plugin source, current cache generation). There is no direct
 * path, so without the plugin nothing renders. Refresh re-reads the plugin's cards.
 */

import { useState } from 'react';
import { useNow } from '@/hooks/useNow';
import { useQuotaStore } from '@/stores/useQuotaStore';
import { useQuotaLiveStore } from '../liveStore';
import { useOpencodeGoStore } from '../opencodeGo';
import { syncPluginCards } from '../pluginSource';
import { bindQuotaClasses } from '../types';
import bodyStyles from './QuotaBody.module.scss';
import { OpencodeGoCard } from './OpencodeGoCard';

const quotaClasses = bindQuotaClasses(bodyStyles, 'QuotaBody.module.scss');

export function OpencodeGoSection() {
  const data = useOpencodeGoStore((state) => state.data);
  const generation = useOpencodeGoStore((state) => state.generation);
  const cacheGeneration = useQuotaStore((state) => state.cacheGeneration);
  const source = useQuotaLiveStore((state) => state.source);
  const now = useNow();
  const [refreshing, setRefreshing] = useState(false);

  if (!data || source !== 'plugin' || generation !== cacheGeneration) return null;

  const refresh = () => {
    setRefreshing(true);
    void syncPluginCards().finally(() => setRefreshing(false));
  };

  return (
    <OpencodeGoCard
      data={data}
      classes={quotaClasses}
      now={now}
      onRefresh={refresh}
      refreshing={refreshing}
    />
  );
}
