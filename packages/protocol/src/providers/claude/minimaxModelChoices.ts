import { z } from 'zod';

/** Presentation only: discovery membership and explicitly requested models remain authoritative. */
export const MiniMaxModelChoicesSchema = z.object({
  provider: z.literal('minimax'),
  configuredModelIds: z.array(z.string().min(1)),
});
export type MiniMaxModelChoices = z.infer<typeof MiniMaxModelChoicesSchema>;

export function resolveMiniMaxModelChoices(env: Readonly<Record<string, string | undefined>>): MiniMaxModelChoices | undefined {
  try {
    const url = new URL(env.ANTHROPIC_BASE_URL ?? '');
    if (url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash
      || !['api.minimax.io', 'api.minimaxi.com'].includes(url.hostname)
      || url.pathname.replace(/\/$/u, '') !== '/anthropic') return undefined;
  } catch {
    return undefined;
  }
  const keys = ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL'];
  return {
    provider: 'minimax',
    configuredModelIds: [...new Set(keys.map(key => env[key]?.trim()).filter((id): id is string => Boolean(id)))],
  };
}

/** Filter only direct MiniMax text IDs; retain other capabilities and explicit configuration. */
export function projectMiniMaxModelChoices<T extends { id: string }>(models: readonly T[], policy?: MiniMaxModelChoices): readonly T[] {
  if (!policy) return models;
  const preferred = ['MiniMax-M3.1-Flash', 'MiniMax-M3'];
  const configured = new Set(policy.configuredModelIds);
  const visible = models.filter(model => !/^MiniMax-(?:Text-01|M\d+(?:\.\d+)?(?:-(?:highspeed|lightning|flash|40k|80k))?)$/iu.test(model.id)
    || preferred.includes(model.id) || configured.has(model.id));
  return [...visible].sort((a, b) => {
    const rank = (id: string) => { const index = preferred.indexOf(id); return index < 0 ? preferred.length : index; };
    return rank(a.id) - rank(b.id);
  });
}
