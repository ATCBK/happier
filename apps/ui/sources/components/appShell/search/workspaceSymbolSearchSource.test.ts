import { describe, expect, it } from 'vitest';

import { createWorkspaceSymbolSearchSource } from './workspaceSymbolSearchSource';

function fixture(serverId: string | null = 'home') {
    let text = 'class Old {}';
    let current = true;
    let flushed = false;
    let flush: () => Promise<void> | void = () => { text = 'class Fresh {}'; flushed = true; };
    const source = createWorkspaceSymbolSearchSource({
        target: { kind: 'workspaceFile', path: 'src/box.ts', scope: { serverId: 'home', machineId: 'machine', rootPath: '/repo' },
            accountId: 'account', serverId, workspaceRefId: 'project', sessionId: null },
        resolverKey: 'holder-1', language: 'typescript', isDark: false, unavailableHint: 'Unavailable',
        accountLifetime: { scope: { serverId: 'home', accountId: 'account' }, isCurrent: () => current, onRetire: () => ({ dispose() {} }) },
        isCurrent: () => current,
        getText: () => { expect(flushed).toBe(true); return text; },
        flushPendingChange: () => flush(),
    });
    return { source, retire: () => { current = false; }, setFlush: (value: () => Promise<void>) => { flush = value; } };
}

describe('active file symbol source', () => {
    it('flushes and reads the current holder on demand, then filters outline rows', async () => {
        const f = fixture();
        const page = await f.source.resolve('fresh', new AbortController().signal);
        expect(page.results.map(row => row.title)).toEqual(['Fresh']);
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
