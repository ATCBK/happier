import { describe, expect, it } from 'vitest';
import { projectMiniMaxModelChoices, resolveMiniMaxModelChoices } from './minimaxModelChoices.js';

const ids = ['MiniMax-M2.7', 'MiniMax-M3', 'MiniMax-M3.1-Flash', 'speech-02-hd', 'claude-2.1-account-model'];
const models = ids.map(id => ({ id, name: id }));

describe('MiniMax ordinary model choices', () => {
  it.each(['api.minimax.io', 'api.minimaxi.com'])('identifies only the direct endpoint at %s and preserves explicit legacy configuration', host => {
    const policy = resolveMiniMaxModelChoices({ ANTHROPIC_BASE_URL: `https://${host}/anthropic/` });
    expect(projectMiniMaxModelChoices(models, policy).map(m => m.id)).toEqual([
      'MiniMax-M3.1-Flash', 'MiniMax-M3', 'speech-02-hd', 'claude-2.1-account-model',
    ]);
    const configured = resolveMiniMaxModelChoices({ ANTHROPIC_BASE_URL: `https://${host}/anthropic`, ANTHROPIC_MODEL: 'MiniMax-M2.7' });
    expect(projectMiniMaxModelChoices(models, configured).map(m => m.id)).toContain('MiniMax-M2.7');
    expect(models.map(m => m.id)).toEqual(ids);
  });

  it.each(['https://proxy.example/anthropic', 'https://api.minimax.io.example/anthropic', 'https://api.minimax.io/custom', 'https://api.anthropic.com', 'http://api.minimax.io/anthropic'])('leaves an unverified endpoint unchanged: %s', baseUrl => {
    const policy = resolveMiniMaxModelChoices({ ANTHROPIC_BASE_URL: baseUrl });
    expect(policy).toBeUndefined();
    expect(projectMiniMaxModelChoices(models, policy)).toBe(models);
  });

  it('hides only recognized ordinary text IDs and leaves other capabilities/custom IDs intact', () => {
    const mixed = ['MiniMax-Text-01', 'MiniMax-M1-80k', 'MiniMax-M2.1-highspeed', 'MiniMax-M2.5', 'MiniMax-M3-audio', 'MiniMax-VL-01', 'image-01', 'custom/MiniMax-M2.7'];
    expect(projectMiniMaxModelChoices(mixed.map(id => ({ id })), { provider: 'minimax', configuredModelIds: [] }).map(row => row.id))
      .toEqual(['MiniMax-M3-audio', 'MiniMax-VL-01', 'image-01', 'custom/MiniMax-M2.7']);
  });

  it('does not invent membership for a successful empty response', () => {
    expect(projectMiniMaxModelChoices([], { provider: 'minimax', configuredModelIds: [] })).toEqual([]);
  });
});
