import { describe, expect, it } from 'vitest';
import { PluginRegistrySourceContributionV1Schema } from './registrySources.js';

const gitSource = { id: 'team-skills', title: 'Team skills', format: 'git', kinds: ['skill'], url: 'https://github.com/acme/skills' };

describe('registry source declarations', () => {
  it('admits only credential-free HTTPS descriptors whose kinds belong to their format', () => {
    expect(PluginRegistrySourceContributionV1Schema.parse(gitSource)).toEqual(gitSource);
    expect(PluginRegistrySourceContributionV1Schema.safeParse({ ...gitSource, format: 'happier-catalog', kinds: ['skill', 'plugin'] }).success).toBe(true);
    for (const invalid of [
      { ...gitSource, kinds: ['mcpServer'] }, { ...gitSource, kinds: [] },
      { ...gitSource, ref: '' }, { ...gitSource, url: 'not a URL' },
      { ...gitSource, url: 'http://github.com/acme/skills' }, { ...gitSource, url: 'https://token@github.com/acme/skills' },
      { ...gitSource, url: 'https://acme:secret@github.com/acme/skills' },
      { ...gitSource, token: { secretRef: 'secret' } }, { ...gitSource, npmRegistryProfileId: 'private' },
      { ...gitSource, format: 'skills-sh' }, { ...gitSource, format: 'happier-npm' },
    ]) expect(PluginRegistrySourceContributionV1Schema.safeParse(invalid).success).toBe(false);
  });
});
