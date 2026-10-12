import { describe, expect, it } from 'vitest';
import { readSkillLibraryItems } from './readSkillLibraryItems';

describe('skill library name inventory', () => {
  it('uses skill frontmatter identity instead of display titles and excludes generic bundles', async () => {
    const artifact = (artifactId: string, bundleSchemaId: string, markdown: string) => ({
      artifactId, ownerAccountId: 'account', access: 'owner' as const, headerVersion: 1,
      seq: 1, createdAt: 1, updatedAt: 1,
      header: { v: 1, kind: 'prompt_bundle.v2', title: 'A display title', bundleSchemaId },
      body: JSON.stringify({ v: 1, createdAtMs: 1, updatedAtMs: 1,
        entries: [{ path: 'SKILL.md', contentKind: 'utf8', contentBase64: Buffer.from(markdown).toString('base64') }] }),
    });
    // Persistence inventory is the external boundary; frontmatter parsing stays real.
    const store = { list: async () => ({ coverage: 'complete' as const, items: [
      artifact('skill-lint', 'skills.skill_md_v1', '---\nname: lint\ndescription: Checks changes\n---\nUse it.'),
      artifact('generic', 'bundle.generic_v1', '---\nname: ignored\n---\nGeneral bundle.'),
    ] }) };
    await expect(readSkillLibraryItems(store)).resolves.toEqual([{ id: 'skill-lint', name: 'lint' }]);
    await expect(readSkillLibraryItems({ list: async () => ({ coverage: 'partial', items: [] }) }))
      .rejects.toMatchObject({ code: 'catalog_unavailable' });
  });
});
