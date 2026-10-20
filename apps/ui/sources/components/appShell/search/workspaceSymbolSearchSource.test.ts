import { describe, expect, it } from 'vitest';

import { createWorkspaceSymbolSearchSource } from './workspaceSymbolSearchSource';
import type { DocumentOutlineServerAnswer } from '@/sync/domains/workspaces/languageIntelligence/documentOutline';

function fixture(serverId: string | null = 'home', serverOutline?: DocumentOutlineServerAnswer | null) {
    let text = 'class Old {}';
    let current = true;
    let flushed = false;
    let flush: () => Promise<void> | void = () => { text = 'class Fresh {\n    constructor() {}\n}'; flushed = true; };
    const source = createWorkspaceSymbolSearchSource({
        target: { kind: 'workspaceFile', path: 'src/box.ts', scope: { serverId: 'home', machineId: 'machine', rootPath: '/repo' },
            accountId: 'account', serverId, workspaceRefId: 'project', sessionId: null },
        resolverKey: 'holder-1', language: 'typescript', isDark: false, unavailableHint: 'Unavailable',
        accountLifetime: { scope: { serverId: 'home', accountId: 'account' }, isCurrent: () => current, onRetire: () => ({ dispose() {} }) },
        isCurrent: () => current,
        getText: () => { expect(flushed).toBe(true); return text; },
        flushPendingChange: () => flush(),
        ...(serverOutline !== undefined ? { getServerOutline: async () => serverOutline } : {}),
    });
    return { source, retire: () => { current = false; }, setFlush: (value: () => Promise<void>) => { flush = value; } };
}

describe('active file symbol source', () => {
    it('uses a passive server answer for rows and preserves an authoritative empty outline', async () => {
        const range = { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } };
        const answer: DocumentOutlineServerAnswer = { capable: true, state: 'ready', loading: false, symbols: [
            { serverId: 'language-server', name: 'Fresh', kind: 5, range,
                selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } },
                children: [{ serverId: 'language-server', name: 'constructor', kind: 9, range,
                    selectionRange: { start: { line: 1, character: 4 }, end: { line: 1, character: 15 } } }],
            },
        ] };
        // The getter is read only after the existing editor's flush, never from disk.
        const page = await fixture('home', answer).source.resolve('constructor', new AbortController().signal);
        expect(page.results.map(row => row.title)).toEqual(['constructor']);
        expect(page.results[0]).toMatchObject({ symbol: { kind: 'constructor', line: 2, depth: 1, container: 'Fresh' } });
        expect(page.results[0]?.target).toMatchObject({ anchor: { kind: 'fileLine', startLine: 2 } });
        expect((await fixture('home', { ...answer, symbols: [] }).source.resolve('', new AbortController().signal)).results).toEqual([]);
        expect((await fixture('home', { ...answer, loading: true, symbols: [] }).source.resolve('', new AbortController().signal)).results.map(row => row.title)).toEqual(['Fresh']);
    });

    it('flushes and reads the current holder on demand, then filters outline rows', async () => {
        const f = fixture();
        const page = await f.source.resolve('fresh', new AbortController().signal);
        expect(page.results.map(row => row.title)).toEqual(['Fresh']);
        expect(page.results[0]).toMatchObject({ symbol: { kind: 'class', line: 1, depth: 0 } });
        expect(page.results[0]?.symbol).not.toHaveProperty('container');
        expect(page.results[0]?.target).toMatchObject({ kind: 'workspaceSymbol', path: 'src/box.ts', anchor: { kind: 'fileLine', startLine: 1 } });
    });

    it('does not publish a result after its holder or Account retires during flush', async () => {
        const f = fixture();
        let finish!: () => void;
        f.setFlush(() => new Promise(resolve => { finish = resolve; }));
        const pending = f.source.resolve('', new AbortController().signal);
        f.retire();
        finish();
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('uses the exact workspace scope when the optional navigation Home is absent', async () => {
        const page = await fixture(null).source.resolve('fresh', new AbortController().signal);
        expect(page.results.map(row => row.title)).toEqual(['Fresh']);
        expect(page.results[0]?.target).toMatchObject({ serverId: 'home' });
    });

    it('preserves line anchors for lone CR editor text', async () => {
        const source = createWorkspaceSymbolSearchSource({
            target: { kind: 'workspaceFile', path: 'src/box.ts', scope: { serverId: 'home', machineId: 'machine', rootPath: '/repo' },
                accountId: 'account', serverId: 'home', workspaceRefId: 'project', sessionId: null },
            resolverKey: 'holder-cr', language: 'typescript', isDark: false, unavailableHint: 'Unavailable',
            accountLifetime: { scope: { serverId: 'home', accountId: 'account' }, isCurrent: () => true, onRetire: () => ({ dispose() {} }) },
            isCurrent: () => true, getText: () => '// first\rclass Fresh {}', flushPendingChange() {},
        });
        const page = await source.resolve('fresh', new AbortController().signal);
        expect(page.results[0]?.target).toMatchObject({ anchor: { kind: 'fileLine', startLine: 2 } });
    });
});
