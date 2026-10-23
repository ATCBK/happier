import { describe, expect, it } from 'vitest';
import { listArtifactHeadersV1 } from './artifactListSelectionV1.js';

const skill = { artifactId: 'skill', header: { kind: 'prompt_bundle.v2', bundleSchemaId: 'skills.skill_md_v1' }, createdAt: 1, updatedAt: 3 };
const legacy = { ...skill, artifactId: 'legacy', updatedAt: 2 };
const prompt = { artifactId: 'prompt', header: { kind: 'prompt_doc.v2' }, createdAt: 1, updatedAt: 1 };
type PageOptions = Readonly<{ cursor?: string; coarseKind?: string }>;
const encodeCursor = (row: Readonly<{ artifactId: string }>) => row.artifactId;

describe('Artifact coarse selection', () => {
  it.each([false, true])('pages a Role catalog once with unclassified membership %s', async hasUnclassified => {
    const roles = Array.from({ length: 1201 }, (_, index) => ({ artifactId: `role-${index}`,
      header: { kind: 'role.v1', title: `Role ${index}` }, createdAt: 1, updatedAt: 2402 - index * 2 }));
    const rows = roles.flatMap(role => [role, { ...role, artifactId: `document-${role.artifactId}`,
      header: { kind: 'document.v1', title: 'Not a Role' }, updatedAt: role.updatedAt - 1 }]);
    const physicalCursors: Array<string | undefined> = [];
    const opened: string[] = [];
    const returned: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await listArtifactHeadersV1({ options: { kind: 'role.v1', coarseKind: 'other',
        includeBody: true, limit: 500, ...(cursor ? { cursor } : {}) }, encodeCursor,
        readPage: async options => {
          physicalCursors.push(options?.cursor);
          const start = options?.cursor ? rows.findIndex(row => row.artifactId === options.cursor) + 1 : 0;
          const items = rows.slice(start, start + (options?.limit ?? 500));
          return { items, ...(start + items.length < rows.length ? { nextCursor: items.at(-1)!.artifactId } : {}),
            ...(options?.coarseKind ? { hasUnclassified } : {}) };
        },
        readBodies: async items => {
          opened.push(...items.map(item => item.artifactId));
          return items.map(item => ({ ...item, body: `content:${item.artifactId}` }));
        },
      });
      expect(page.coverage).toBe('complete');
      returned.push(...page.items.map(item => item.artifactId));
      cursor = page.nextCursor;
    } while (cursor);
    expect(returned).toEqual(roles.map(role => role.artifactId));
    expect(opened).toHaveLength(roles.length);
    expect(opened).toEqual(returned);
    // Five physical pages for 2,402 headers, plus one completeness-witness
    // fallback per logical page when predecessor membership is unclassified.
    expect(physicalCursors).toHaveLength(hasUnclassified ? 8 : 5);
    expect(physicalCursors.filter(value => value === undefined)).toHaveLength(hasUnclassified ? 2 : 1);
  });

  it.each(['title_asc', 'created_desc'] as const)('opens only each returned body for %s', async sort => {
    const rows = [
      { artifactId: 'c', header: { kind: 'role.v1', title: 'Role C' }, createdAt: 1, updatedAt: 3 },
      { artifactId: 'a', header: { kind: 'role.v1', title: 'Role A' }, createdAt: 3, updatedAt: 2 },
      { artifactId: 'b', header: { kind: 'role.v1', title: 'Role B' }, createdAt: 2, updatedAt: 1 },
    ];
    const opened: string[] = [];
    const returned: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await listArtifactHeadersV1({ options: { kind: 'role.v1', includeBody: true,
        limit: 1, sort, search: 'ROLE', ...(cursor ? { cursor } : {}) }, encodeCursor,
        readPage: async () => ({ items: rows }),
        readBodies: async items => {
          opened.push(...items.map(item => item.artifactId));
          return items;
        } });
      returned.push(...page.items.map(item => item.artifactId));
      cursor = page.nextCursor;
    } while (cursor);
    expect(returned).toEqual(['a', 'b', 'c']);
    expect(opened).toEqual(returned);
  });

  it('keeps the updated-order cursor aligned with the transport id-desc tie break', async () => {
    const rows = ['c', 'b', 'a'].map(artifactId => ({ artifactId,
      header: { kind: 'role.v1' }, createdAt: 1, updatedAt: 1 }));
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await listArtifactHeadersV1({ options: { kind: 'role.v1', limit: 1,
        ...(cursor ? { cursor } : {}) }, encodeCursor,
        readPage: async options => ({ items: rows.slice(options?.cursor
          ? rows.findIndex(row => row.artifactId === options.cursor) + 1 : 0) }) });
      ids.push(...page.items.map(row => row.artifactId));
      cursor = page.nextCursor;
    } while (cursor);
    expect(ids).toEqual(['c', 'b', 'a']);
  });

  it('returns fresh selected revisions and keeps a changed-kind page from disclosing content', async () => {
    const rows = ['a', 'b', 'c'].map((artifactId, index) => ({ artifactId,
      header: { kind: 'role.v1', title: artifactId }, headerVersion: 1, bodyVersion: 1,
      createdAt: 1, updatedAt: 3 - index }));
    const page = await listArtifactHeadersV1({ options: { kind: 'role.v1', includeBody: true, limit: 2 }, encodeCursor,
      readPage: async () => ({ items: rows }),
      readBodies: async items => items.map(item => ({ ...item, headerVersion: 2, bodyVersion: 2,
        header: { kind: item.artifactId === 'a' ? 'role.v1' : 'document.v1', title: item.artifactId },
        body: `fresh:${item.artifactId}` })),
    });
    expect(page.items).toEqual([{ ...rows[0], headerVersion: 2, bodyVersion: 2, body: 'fresh:a' }]);
    // The structural continuation still advances over the page we admitted,
    // including a body whose fresh header no longer belongs to this selection.
    expect(page.nextCursor).toBe('b');
  });

  it('does not return a selected body if cancellation arrives while opening it', async () => {
    const controller = new AbortController();
    const reason = new Error('Caller cancelled body opening');
    await expect(listArtifactHeadersV1({ options: { kind: 'role.v1', includeBody: true, signal: controller.signal },
      encodeCursor, readPage: async () => ({ items: [{ ...prompt, header: { kind: 'role.v1' } }] }),
      readBodies: async items => { controller.abort(reason); return items; },
    })).rejects.toBe(reason);
  });

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

  it('keeps unclassified membership complete while continuing from the selected page', async () => {
    const requests: PageOptions[] = [];
    const readPage = async (options?: PageOptions) => {
      requests.push(options ?? {});
      if (options?.coarseKind) return { items: [skill], hasUnclassified: true };
      return options?.cursor ? { items: [legacy, prompt] } : { items: [skill], nextCursor: 'full-page-2' };
    };
    const page = await listArtifactHeadersV1({ options: { coarseKind: 'skill', limit: 1 }, encodeCursor, readPage });
    expect(page.items.map(row => row.artifactId)).toEqual(['skill']);
    expect(page.nextCursor).toBe('skill');
    expect(requests).toEqual([{ limit: 500, coarseKind: 'skill' }, { limit: 500 }]);
    const next = await listArtifactHeadersV1({ options: { coarseKind: 'skill', limit: 1, cursor: page.nextCursor }, encodeCursor, readPage });
    expect(next.items.map(row => row.artifactId)).toEqual(['legacy']);
    expect(next.nextCursor).toBeUndefined();
    expect(requests.slice(2)).toEqual([{ limit: 500, coarseKind: 'skill', cursor: 'skill' }, { limit: 500, cursor: 'skill' }]);
    expect(page.coverage).toBe('complete');
  });

});
