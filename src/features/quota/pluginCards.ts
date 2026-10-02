/** Provider types whose numbers the claude-pool plugin caches (so the browser need not poll upstream). */
export const isPluginBackedType = (type: string): boolean => type === 'claude' || type === 'codex';
