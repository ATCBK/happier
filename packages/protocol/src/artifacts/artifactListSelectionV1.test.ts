import { describe, expect, it } from 'vitest';
import { listArtifactHeadersV1 } from './artifactListSelectionV1.js';
import { createRoleSourceReaderV1 } from '../prompts/roles/accountRoleActions.js';
import { BUILT_IN_ROLES_V1 } from '../prompts/roles/builtInRolesV1.js';

const skill = { artifactId: 'skill', header: { kind: 'prompt_bundle.v2', bundleSchemaId: 'skills.skill_md_v1' }, createdAt: 1, updatedAt: 3 };
const legacy = { ...skill, artifactId: 'legacy', updatedAt: 2 };
const prompt = { artifactId: 'prompt', header: { kind: 'prompt_doc.v2' }, createdAt: 1, updatedAt: 1 };
type PageOptions = Readonly<{ cursor?: string; coarseKind?: string }>;
const encodeCursor = (row: Readonly<{ artifactId: string }>) => row.artifactId;

describe('Artifact coarse selection', () => {
  it('finds legacy exact kinds beyond 500 using headers only and opens only the selected page', async () => {
    const rows = Array.from({ length: 1001 }, (_, index) => ({ artifactId: `legacy-${index}`,
      header: { kind: index === 700 || index === 1000 ? 'account_notice.v1' : 'document.v1' },
      createdAt: 1, updatedAt: 2000 - index }));
    const indexed = { ...rows[700]!, artifactId: 'indexed', updatedAt: 1400 };
    const kindCoverage = { status: 'partial' as const, unclassifiedCount: rows.length,
      reason: 'unclassified_legacy_rows' as const };
    const requests: unknown[] = [];
    const bodies: string[] = [];
    const returned: string[] = [];
    let cursor: string | undefined;
    do {
      const result = await listArtifactHeadersV1({ options: { kinds: ['account_notice.v1'], includeBody: true, ownerAccountId: 'owner',
        limit: 2, ...(cursor ? { cursor } : {}) }, encodeCursor,
        readPage: async options => {
          requests.push(options);
          const source = options?.unclassified ? [...rows, indexed].sort((left, right) => right.updatedAt - left.updatedAt) : [indexed];
          const after = options?.cursor === indexed.artifactId ? indexed : rows.find(row => row.artifactId === options?.cursor);
          const remaining = source.filter(row => !after || row.updatedAt < after.updatedAt);
          const items = remaining.slice(0, options?.limit ?? 500);
          return { items, hasUnclassified: true, kindCoverage,
            ...(remaining.length > items.length ? { nextCursor: items.at(-1)!.artifactId } : {}) };
        },
        readBodies: async items => { bodies.push(...items.map(row => row.artifactId)); return items; },
      });
      expect(result).toMatchObject({ coverage: 'complete', kindCoverage });
      returned.push(...result.items.map(row => row.artifactId));
      cursor = result.nextCursor;
    } while (cursor);
    expect(returned).toEqual(['indexed', 'legacy-700', 'legacy-1000']);
    expect(bodies).toEqual(returned);
    expect(requests.filter(value => typeof value === 'object' && value && Reflect.get(value, 'unclassified'))).toHaveLength(4);
    expect(requests.every(value => typeof value === 'object' && value && Reflect.get(value, 'includeBody') !== true)).toBe(true);
    expect(requests.every(value => typeof value === 'object' && value && Reflect.get(value, 'ownerAccountId') === 'owner')).toBe(true);
  });

  it.each(['readable', 'unreadable'] as const)('keeps a legacy Role catalog %s through the real shared Role reader', async availability => {
    const row = { artifactId: 'legacy-role', header: { kind: 'role.v1' }, headerVersion: 1,
      bodyVersion: 1, createdAt: 1, updatedAt: 1, ownerAccountId: 'account', access: 'owner' as const };
    const kindCoverage = { status: 'partial' as const, unclassifiedCount: 1,
      reason: 'unclassified_legacy_rows' as const };
    const bodyIds: string[] = [];
    const read = createRoleSourceReaderV1({ artifactStore: {
      read: async () => { throw new Error('Catalog must use the selected list body'); },
      list: options => listArtifactHeadersV1({ options, encodeCursor,
        readPage: async selection => ({ items: selection?.unclassified && availability === 'readable' ? [row] : [],
          coverage: selection?.unclassified && availability === 'unreadable' ? 'partial' : 'complete',
          hasUnclassified: true, kindCoverage }),
        readBodies: async items => { bodyIds.push(...items.map(item => item.artifactId));
          return items.map(item => ({ ...item, body: JSON.stringify(BUILT_IN_ROLES_V1.builder) })); },
      }),
    } });
    const result = await read();
    expect(result.status).toBe(availability === 'readable' ? 'ready' : 'partial');
    expect(result.entries.some(entry => entry.roleId === row.artifactId)).toBe(availability === 'readable');
    expect(bodyIds).toEqual(availability === 'readable' ? [row.artifactId] : []);
  });

  it('keeps complete exact coverage indexed-only and carries its derived count', async () => {
    let queries = 0;
    const kindCoverage = { status: 'complete' as const, unclassifiedCount: 0 as const };
    const result = await listArtifactHeadersV1({ options: { kinds: ['account_notice.v1'] }, encodeCursor,
      readPage: async options => {
        queries++;
        expect(options).toEqual({ limit: 500, kinds: ['account_notice.v1'] });
        return { items: [], hasUnclassified: false, kindCoverage };
      } });
    expect(result).toEqual({ items: [], coverage: 'complete', kindCoverage });
    expect(queries).toBe(1);
  });

  it('does not confuse complete kind classification with readable content coverage', async () => {
    const kindCoverage = { status: 'complete' as const, unclassifiedCount: 0 as const };
    const result = await listArtifactHeadersV1({ options: { kinds: ['account_notice.v1'] }, encodeCursor,
      readPage: async () => ({ items: [], coverage: 'partial', kindCoverage }) });
    expect(result).toEqual({ items: [], coverage: 'partial', kindCoverage });
  });

  it('keeps exact selection query-only and reports unresolved legacy membership', async () => {
    const requests: unknown[] = [];
    const page = await listArtifactHeadersV1({ options: { kinds: ['role.v1'], includeBody: true }, encodeCursor,
      readPage: async options => {
        requests.push(options);
        return { items: [{ ...legacy, header: { kind: 'role.v1' } }], hasUnclassified: true };
      },
      readBodies: async items => items.map(row => ({ ...row, body: 'selected' })),
    });
    expect(requests).toEqual([{ limit: 500, kinds: ['role.v1'] }]);
    expect(page).toMatchObject({ items: [{ artifactId: 'legacy', body: 'selected' }], coverage: 'partial' });
  });

  it('never opens 35k unrelated headers to refine known coarse classifications', async () => {
    const rows = Array.from({ length: 35000 }, (_, index) => ({ ...prompt, artifactId: String(index) }));
    let opened = 0;
    let queries = 0;
    const result = await listArtifactHeadersV1({ options: { coarseKind: 'skill' }, encodeCursor,
      readPage: async options => {
        queries++;
        if (!options?.unclassified) return { items: [], hasUnclassified: false };
        const start = Number(options.cursor ?? 0);
        const items = rows.slice(start, start + 500);
        opened += items.length;
        return { items, ...(start + 500 < rows.length ? { nextCursor: String(start + 500) } : {}) };
      } });
    expect(opened).toBe(0);
    expect(queries).toBe(1);
    expect(result).toEqual({ items: [], coverage: 'complete' });
  });

  it('reports unresolved classification as partial without an inventory fallback', async () => {
    const requests: unknown[] = [];
    const page = await listArtifactHeadersV1({ options: { kinds: ['role.v1'] }, encodeCursor,
      readPage: async options => { requests.push(options); return { items: [], hasUnclassified: true }; } });
    expect(page).toEqual({ items: [], coverage: 'partial' });
    expect(requests).toEqual([{ limit: 500, kinds: ['role.v1'] }]);
  });
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
          const candidates = options?.kinds ? roles : rows;
          const start = options?.cursor ? candidates.findIndex(row => row.artifactId === options.cursor) + 1 : 0;
          const items = candidates.slice(start, start + (options?.limit ?? 500));
          return { items, ...(start + items.length < candidates.length ? { nextCursor: items.at(-1)!.artifactId } : {}), hasUnclassified };
        },
        readBodies: async items => {
          opened.push(...items.map(item => item.artifactId));
          return items.map(item => ({ ...item, body: `content:${item.artifactId}` }));
        },
      });
      expect(page.coverage).toBe(hasUnclassified ? 'partial' : 'complete');
      returned.push(...page.items.map(item => item.artifactId));
      cursor = page.nextCursor;
    } while (cursor);
    expect(returned).toEqual(roles.map(role => role.artifactId));
    expect(opened).toHaveLength(roles.length);
    expect(opened).toEqual(returned);
    expect(physicalCursors).toHaveLength(3);
    expect(physicalCursors.filter(value => value === undefined)).toHaveLength(1);
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

  it('keeps unresolved classification partial while continuing only the indexed selector', async () => {
    const requests: PageOptions[] = [];
    const readPage = async (options?: PageOptions) => {
      requests.push(options ?? {});
      return options?.cursor ? { items: [legacy], hasUnclassified: true }
        : { items: [skill], nextCursor: 'skill', hasUnclassified: true };
    };
    const page = await listArtifactHeadersV1({ options: { coarseKind: 'skill', limit: 1 }, encodeCursor, readPage });
    expect(page.items.map(row => row.artifactId)).toEqual(['skill']);
    expect(page.nextCursor).toBe('skill');
    expect(requests).toEqual([{ limit: 500, coarseKind: 'skill' }]);
    const next = await listArtifactHeadersV1({ options: { coarseKind: 'skill', limit: 1, cursor: page.nextCursor }, encodeCursor, readPage });
    expect(next.items.map(row => row.artifactId)).toEqual(['legacy']);
    expect(next.nextCursor).toBeUndefined();
    expect(requests.slice(1)).toEqual([{ limit: 500, coarseKind: 'skill', cursor: 'skill' }]);
    expect(page.coverage).toBe('partial');
    expect(next.coverage).toBe('partial');
  });

});
