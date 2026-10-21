import { describe, expect, it } from 'vitest';
import { listArtifactHeadersV1 } from './artifactListSelectionV1.js';

const skill = { artifactId: 'skill', header: { kind: 'prompt_bundle.v2', bundleSchemaId: 'skills.skill_md_v1' }, createdAt: 1, updatedAt: 3 };
const legacy = { ...skill, artifactId: 'legacy', updatedAt: 2 };
const prompt = { artifactId: 'prompt', header: { kind: 'prompt_doc.v2' }, createdAt: 1, updatedAt: 1 };
type PageOptions = Readonly<{ cursor?: string; coarseKind?: string }>;
const encodeCursor = (row: Readonly<{ artifactId: string }>) => row.artifactId;

describe('Artifact coarse selection', () => {
  it.each(['single-page', 'inventory'] as const)('selects %s rows with a native method-absent AbortSignal', async mode => {
    const controller = new AbortController();
    // React Native's installed abort-controller exposes events/aborted, not this method.
    Object.defineProperty(controller.signal, 'throwIfAborted', { value: undefined });
    const result = await listArtifactHeadersV1({ options: { signal: controller.signal,
      ...(mode === 'single-page' ? { limit: 1 } : {}) }, encodeCursor,
      readPage: async () => ({ items: [prompt] }) });
    expect(result.items).toEqual([prompt]);
    expect(result.coverage).toBe('complete');
  });

  it.each(['before-read', 'after-read', 'after-read-without-reason'] as const)('keeps native cancellation authoritative %s', async when => {
    const controller = new AbortController();
    Object.defineProperty(controller.signal, 'throwIfAborted', { value: undefined });
    const reason = new Error('Caller cancelled');
    if (when === 'before-read') controller.abort(reason);
    let reads = 0;
    const result = listArtifactHeadersV1({ options: { signal: controller.signal }, encodeCursor,
      readPage: async () => {
        reads++; controller.abort(reason);
        // The native abort-controller also has no AbortSignal.reason property.
        if (when === 'after-read-without-reason') Object.defineProperty(controller.signal, 'reason', { value: undefined });
        return { items: [prompt] };
      },
    });
    if (when === 'after-read-without-reason') await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    else await expect(result).rejects.toBe(reason);
    expect(reads).toBe(when === 'before-read' ? 0 : 1);
  });

  it.each([
    ['widget_area_layout', 'widget-area-layout.v1'], ['widget_definition', 'widget-definition.v1'],
    ['widget_layout_fragment', 'widget-layout-fragment.v1'],
  ] as const)('keeps %s reads filtered when unrelated predecessor rows are unclassified', async (coarseKind, kind) => {
    const requests: PageOptions[] = [];
    const layout = { ...skill, artifactId: 'widget', header: { kind } };
    const page = await listArtifactHeadersV1({ options: { coarseKind }, encodeCursor,
      readPage: async options => {
        requests.push(options ?? {});
        return options?.coarseKind ? { items: [layout], hasUnclassified: true } : { items: [layout, prompt] };
      } });
    expect(page.items.map(row => row.artifactId)).toEqual(['widget']);
    expect(requests).toEqual([{ limit: 500, coarseKind }]);
  });
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

});
