import { describe, expect, it } from 'vitest';
import { listArtifactHeadersV1 } from './artifactListSelectionV1.js';

const skill = { artifactId: 'skill', header: { kind: 'prompt_bundle.v2', bundleSchemaId: 'skills.skill_md_v1' }, createdAt: 1, updatedAt: 3 };
const legacy = { ...skill, artifactId: 'legacy', updatedAt: 2 };
const prompt = { artifactId: 'prompt', header: { kind: 'prompt_doc.v2' }, createdAt: 1, updatedAt: 1 };
type PageOptions = Readonly<{ cursor?: string; coarseKind?: string }>;
const encodeCursor = (row: typeof skill | typeof prompt) => row.artifactId;

describe('Artifact coarse selection', () => {
  it('reads only filtered pages when classification is complete', async () => {
    const requests: PageOptions[] = [];
    const page = await listArtifactHeadersV1({ options: { coarseKind: 'skill' }, encodeCursor,
      readPage: async options => {
        requests.push(options ?? {});
        return options?.coarseKind === 'skill' ? { items: [skill], hasUnclassified: false } : { items: [skill, prompt] };
      } });
    expect(page.items.map(row => row.artifactId)).toEqual(['skill']);
    expect(requests).toEqual([{ limit: 500, coarseKind: 'skill' }]);
    expect(page.coverage).toBe('complete');
  });

  it('falls back through every full-inventory page while unclassified rows remain', async () => {
    const requests: PageOptions[] = [];
    const page = await listArtifactHeadersV1({ options: { coarseKind: 'skill', limit: 1 }, encodeCursor,
      readPage: async options => {
        requests.push(options ?? {});
        if (options?.coarseKind) return { items: [skill], hasUnclassified: true };
        return options?.cursor ? { items: [legacy, prompt] } : { items: [skill], nextCursor: 'full-page-2' };
      } });
    expect(page.items.map(row => row.artifactId)).toEqual(['skill']);
    expect(page.nextCursor).toBe('skill');
    expect(requests).toEqual([{ limit: 500, coarseKind: 'skill' }, { limit: 500 }, { limit: 500, cursor: 'full-page-2' }]);
    expect(page.coverage).toBe('complete');
  });

  it('locally selects an unfiltered inventory when the current Home disables filtering and preserves incomplete coverage', async () => {
    const page = await listArtifactHeadersV1({ options: { coarseKind: 'skill' }, encodeCursor,
      readPage: async () => ({ items: [skill, prompt], coverage: 'partial' }) });
    expect(page.items.map(row => row.artifactId)).toEqual(['skill']);
    expect(page.coverage).toBe('partial');
  });
});
