import { describe, expect, it } from 'vitest';
import { DEFAULT_PUBLIC_PROFILE_POLICY_V1 } from './publicProfile.js';
import { projectPublicProfile } from './projectPublicProfile.js';
import { buildPublicProfileEmbed, PublicEmbedInputV1Schema, PublicEmbedResultV1Schema } from './publicProfileEmbeds.js';

function published(tokens = true) {
  const base = 'https://profiles.example.test/prefix/@owner_%2Flegacy';
  const view = projectPublicProfile({
    context: { handle: 'owner_/legacy', identity: {}, service: { displayName: 'A & B "service"', publicBaseUrl: 'https://profiles.example.test/prefix' },
      urls: { page: base, json: 'https://profiles.example.test/prefix/v1/public/profiles/owner_%2Flegacy', badgeBase: `${base}/badge`,
        card: `${base}/card.svg`, og: `${base}/og.png`, report: 'mailto:operator@example.test' } },
    policy: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1, fields: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields, tokens } },
    snapshot: { v: 1, computedAtMs: 10, period: { startMs: 1, endMs: 9, timeZoneOffsetMinutes: 0 },
      coverage: { status: 'partial', method: 'mixed' }, fieldCoverage: {}, facts: { tokens: 12345, currentStreakDays: 0 } },
    metadata: {}, layout: { v: 1, items: [] }, appearance: { theme: 'auto', atmosphere: { source: 'none' } },
  });
  if (!view) throw new Error('Expected admitted fixture');
  return { kind: 'published' as const, view };
}

describe('public-profile embeds', () => {
  it('uses the admitted canonical URLs without losing prefixes or double-encoding retained handles', () => {
    const source = published();
    const result = buildPublicProfileEmbed(source, { kind: 'badge', metric: 'tokens', theme: 'dark', syntax: 'url' });
    expect(result).toMatchObject({ kind: 'ready', url: `${source.view.urls.badgeBase}/tokens.svg?theme=dark` });
    if (result.kind !== 'ready') throw new Error('Expected ready embed');
    expect(result.snippet).toBe(result.url);
    expect(result.url).not.toContain('%252F');
    expect(PublicEmbedResultV1Schema.parse(result)).toEqual(result);
  });

  it('does not generate a useful-looking hidden or unavailable metric badge, including a stale selected field', () => {
    expect(buildPublicProfileEmbed(published(false), { kind: 'badge', metric: 'tokens', theme: 'auto', syntax: 'markdown' }))
      .toEqual({ kind: 'unavailable', reason: 'field_hidden' });
    expect(buildPublicProfileEmbed(published(), { kind: 'badge', metric: 'agent-time', theme: 'auto', syntax: 'url' }))
      .toEqual({ kind: 'unavailable', reason: 'field_hidden' });
    expect(buildPublicProfileEmbed(published(), { kind: 'badge', metric: 'streak', theme: 'auto', syntax: 'url' }).kind).toBe('ready');
    for (const source of [{ kind: 'unavailable' as const }, { kind: 'paused' as const, handle: 'owner', identity: {} }]) {
      expect(buildPublicProfileEmbed(source, { kind: 'card', theme: 'auto', syntax: 'html' }))
        .toEqual({ kind: 'unavailable', reason: 'not_published' });
    }
  });

  it('builds escaped linked HTML/picture snippets from the server card with both explicit themes and a valid fallback', () => {
    const source = published();
    const result = buildPublicProfileEmbed(source, { kind: 'card', theme: 'auto', syntax: 'picture' });
    if (result.kind !== 'ready') throw new Error('Expected ready embed');
    expect(result.snippet).toContain(`href="${source.view.urls.page}"`);
    expect(result.snippet).toContain(`${source.view.urls.card}?theme=light`);
    expect(result.snippet).toContain(`${source.view.urls.card}?theme=dark`);
    expect(result.snippet).toContain(`<img src="${source.view.urls.card}?theme=auto"`);
    expect(result.snippet).toContain('alt="');
    expect(result.snippet).toContain('A &amp; B &quot;service&quot;');
    expect(result.snippet).not.toContain('12345');
    expect(result).not.toHaveProperty('copied');
  });

  it('keeps profile links distinct from image embeds and refuses undeclared style/scope or metric inputs', () => {
    const source = published();
    expect(buildPublicProfileEmbed(source, { kind: 'profile_link', theme: 'auto', syntax: 'url' }))
      .toMatchObject({ kind: 'ready', url: source.view.urls.page, snippet: source.view.urls.page });
    expect(PublicEmbedInputV1Schema.safeParse({ kind: 'badge', theme: 'auto', syntax: 'url' }).success).toBe(false);
    expect(PublicEmbedInputV1Schema.safeParse({ kind: 'card', metric: 'tokens', theme: 'auto', syntax: 'url' }).success).toBe(false);
    expect(PublicEmbedInputV1Schema.safeParse({ kind: 'badge', metric: 'dollars', theme: 'auto', syntax: 'url' }).success).toBe(false);
    expect(PublicEmbedInputV1Schema.safeParse({ kind: 'card', theme: 'auto', syntax: 'url', query: { projectId: 'private' } }).success).toBe(false);
  });
});
