import { describe, expect, it, vi } from 'vitest';
import type { CodeIntelligenceFallbackInput, CodeIntelligenceFallbackResult } from '@happier-dev/protocol/machines/codeIntelligenceFallback';
import type { LanguageIntelligenceQueryResult, LanguageIntelligenceWatchInput, LanguageIntelligenceWatchResult } from '@happier-dev/protocol/machines/languageIntelligence';
import { createCodeIntelligenceController } from './createCodeIntelligenceController';
import { selectDocumentOutline } from './documentOutline';
import { selectCodeDiagnostics } from './codeDiagnostics';

const result: Extract<CodeIntelligenceFallbackResult, { status: 'ok' }> = {
    status: 'ok', source: 'text_matches', coverage: 'complete', hasMore: false,
    locations: [{ path: 'src/target.ts', range: { start: { line: 3, character: 16 }, end: { line: 3, character: 22 } }, lineText: 'export function answer() {}' }],
};

function fixture() {
    let text = 'const total = answer(1);';
    let current = true;
    let retire: (() => void) | undefined;
    const requests: Array<{ input: CodeIntelligenceFallbackInput; signal: AbortSignal; resolve(value: CodeIntelligenceFallbackResult): void }> = [];
    const opened: string[] = [];
    const controller = createCodeIntelligenceController({
        scope: { serverId: 'home', machineId: 'machine', rootPath: '/repo' }, path: 'src/current.ts', languageId: 'typescript',
        accountLifetime: {
            scope: { serverId: 'home', accountId: 'account' }, isCurrent: () => current,
            onRetire: callback => { retire = callback; return { dispose: () => { retire = undefined; } }; },
        },
        getText: () => text,
        query: (input, signal) => new Promise(resolve => requests.push({ input, signal, resolve })),
        openLocation: location => { opened.push(location.path); },
    });
    return { controller, requests, opened, setText: (value: string) => { text = value; }, retire: () => { current = false; retire?.(); } };
}

describe('fallback code intelligence controller', () => {
    it('resolves the identifier from current text and opens the best definition through the provided file opener', async () => {
        const f = fixture();
        const pending = f.controller.definition({ line: 0, character: 16 });
        await Promise.resolve();
        expect(f.requests[0]?.input).toMatchObject({ path: 'src/current.ts', rootPath: '/repo', kind: 'definition', line: 1, symbol: 'answer' });
        expect(f.controller.getSnapshot().status).toBe('searching');
        f.requests[0].resolve(result);
        await pending;
        expect(f.opened).toEqual(['src/target.ts']);
        expect(f.controller.getSnapshot()).toMatchObject({ status: 'ready', kind: 'definition', result });
        f.controller.dispose();
    });

    it('cancels an older query and discards both late and edited-buffer results', async () => {
        const f = fixture();
        const first = f.controller.references({ line: 0, character: 16 });
        await Promise.resolve();
        const second = f.controller.definition({ line: 0, character: 16 });
        await Promise.resolve();
        expect(f.requests[0]?.signal.aborted).toBe(true);
        f.requests[0].resolve(result);
        await first;
        expect(f.controller.getSnapshot().status).toBe('searching');
        f.setText('const total = different(1);');
        f.requests[1].resolve(result);
        await second;
        expect(f.opened).toEqual([]);
        expect(f.controller.getSnapshot().status).toBe('idle');
        f.controller.dispose();
    });

    it('publishes same-token pointer state once and removes all result custody on Account retirement', async () => {
        const f = fixture();
        const notifications: string[] = [];
        f.controller.subscribe(() => notifications.push(f.controller.getSnapshot().status));
        f.controller.inspect({ line: 0, character: 16 });
        f.controller.inspect({ line: 0, character: 17 });
        expect(notifications).toHaveLength(1);
        const pending = f.controller.references({ line: 0, character: 16 });
        await Promise.resolve();
        f.retire();
        expect(f.requests[0]?.signal.aborted).toBe(true);
        f.requests[0].resolve(result);
        await pending;
        expect(f.controller.getSnapshot()).toMatchObject({ status: 'unavailable', result: null, selection: null, reason: 'account_unavailable' });
        expect(f.opened).toEqual([]);
        f.controller.dispose();
    });

    it('stops reporting a pending search when the caller cancels it', async () => {
        const f = fixture();
        const pending = f.controller.references({ line: 0, character: 16 });
        await Promise.resolve();
        f.controller.cancel();
        expect(f.controller.getSnapshot().status).toBe('idle');
        expect(f.requests[0]?.signal.aborted).toBe(true);
        f.requests[0].resolve(result);
        await pending;
        expect(f.controller.getSnapshot().result).toBeNull();
        f.controller.dispose();
    });

    it('refreshes neighboring name chips when the buffer changes around the same selected token', () => {
        const f = fixture();
        f.controller.inspect({ line: 0, character: 16 });
        f.setText('const total = answer(next);');
        f.controller.inspect({ line: 0, character: 16 });
        expect(f.controller.getSnapshot().selection?.names.map(name => name.symbol)).toContain('next');
        f.controller.dispose();
    });

    it('keeps the engine anchor in shared state and refreshes it when the line moves', () => {
        const f = fixture();
        const anchor = { x: 12, y: 28, width: 8, height: 16 };
        f.controller.inspect({ line: 0, character: 16, anchor });
        expect(f.controller.getSnapshot().selection?.anchor).toEqual(anchor);
        f.controller.inspect({ line: 0, character: 16, anchor: { ...anchor, y: 48 } });
        expect(f.controller.getSnapshot().selection?.anchor?.y).toBe(48);
        f.controller.dispose();
    });

    it('keeps reference results tied to their queried name while another name is inspected', async () => {
        const f = fixture();
        const pending = f.controller.references({ line: 0, character: 16 });
        await Promise.resolve();
        f.controller.inspect({ line: 0, character: 7 });
        f.requests[0].resolve(result);
        await pending;
        expect(f.controller.getSnapshot().selection?.identifier.symbol).toBe('total');
        expect(f.controller.getSnapshot().querySelection?.identifier.symbol).toBe('answer');
        f.controller.inspect(null);
        expect(f.controller.getSnapshot()).toMatchObject({ selection: null, querySelection: { identifier: { symbol: 'answer' } }, result });
        f.controller.dismiss();
        expect(f.controller.getSnapshot().querySelection).toBeNull();
        f.controller.dispose();
    });
});

describe('on-demand language intelligence controller', () => {
    it.each([false, true])('re-asks a loading query after an early ready watch with unrelated failed server %s', async unrelatedFailed => {
        let updateWatch!: (answer: LanguageIntelligenceWatchResult) => void;
        let finishQuery!: (answer: LanguageIntelligenceQueryResult) => void;
        let started!: () => void;
        const began = new Promise<void>(resolve => { started = resolve; });
        let queries = 0;
        const server = { serverId: 'ts', label: 'TS', state: 'ready' as const, loading: false, generation: 'g1' };
        const servers = [server, ...(unrelatedFailed ? [{ ...server, serverId: 'other', state: 'crashed' as const }] : [])];
        const controller = createCodeIntelligenceController({
            scope: { serverId: 'home', machineId: 'machine', rootPath: '/repo' }, path: 'a.ts', languageId: 'typescript',
            accountLifetime: { scope: { serverId: 'home', accountId: 'account' }, isCurrent: () => true, onRetire: () => ({ dispose() {} }) },
            getText: () => 'answer()', query: async () => result, openLocation() {},
            languageServer: {
                sync: async () => ({ status: 'ok', generation: 'g1', version: 1, servers,
                    capabilities: { hover: true, definition: true, references: true, documentSymbol: true, diagnostics: 'pull', acceptsExternalChanges: false } }),
                query: async () => {
                    queries += 1;
                    if (queries > 1) return { status: 'ok', kind: 'references', locations: [], hasMore: false };
                    started();
                    return new Promise(resolve => { finishQuery = resolve; });
                },
                watch: (_request, signal) => new Promise((resolve, reject) => {
                    updateWatch = resolve;
                    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
                }),
                restart: async () => ({ status: 'ok' }),
            },
        });
        try {
            const pending = controller.references({ line: 0, character: 2 });
            await began;
            updateWatch({ status: 'ok', revision: 1, servers: servers.map(item => item.serverId === server.serverId ? { ...item, loading: true } : item), diagnostics: {} });
            await vi.waitFor(() => expect(controller.getSnapshot().servers?.[0]?.loading).toBe(true));
            updateWatch({ status: 'ok', revision: 2, servers, diagnostics: {} });
            await vi.waitFor(() => expect(controller.getSnapshot().servers?.[0]?.loading).toBe(false));
            finishQuery({ status: 'loading' });
            await pending;
            await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('ready'));
            expect(queries).toBe(2);
        } finally { controller.dispose(); }
    });

    it('drops a pre-restart watch after the replacement snapshot without restoring old-root problems or consuming its revision', async () => {
        let generation = 'g1';
        const watches: Array<{ request: LanguageIntelligenceWatchInput; resolve(value: LanguageIntelligenceWatchResult): void }> = [];
        const server = (value: string) => ({ serverId: 'ts', label: 'TS', state: 'ready' as const, loading: false, generation: value });
        const controller = createCodeIntelligenceController({
            scope: { serverId: 'home', machineId: 'machine', rootPath: '/repo' }, path: 'a.ts', languageId: 'typescript',
            accountLifetime: { scope: { serverId: 'home', accountId: 'account' }, isCurrent: () => true, onRetire: () => ({ dispose() {} }) },
            getText: () => 'const value = 1;', query: async () => result, openLocation() {},
            languageServer: {
                sync: async request => ({ status: 'ok', generation: `root-${generation}`,
                    ...('version' in request.op ? { version: request.op.version } : {}), servers: [server(generation)],
                    capabilities: { hover: true, definition: true, references: true, documentSymbol: true, diagnostics: 'pull', acceptsExternalChanges: true } }),
                query: async request => ({ status: 'ok', kind: 'diagnostics', generation: `root-${generation}`, version: request.version, diagnostics: [], hasMore: false }),
                restart: async () => { generation = 'g2'; return { status: 'ok' }; },
                watch: (request, signal) => new Promise((resolve, reject) => {
                    watches.push({ request, resolve });
                    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
                }),
            },
        });
        try {
            await controller.checkProblems();
            expect(watches).toHaveLength(1);
            await controller.restart();
            expect(controller.getSnapshot().servers?.[0]?.generation).toBe('g2');
            watches[0].resolve({ status: 'ok', revision: 10, servers: [server('g1')], diagnostics: {
                'b.ts': { ts: { state: 'ready', version: 1, generation: 'g1', items: [{
                    serverId: 'ts', path: 'b.ts', severity: 'error', message: 'Old generation problem',
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
                }] } },
            } });
            await vi.waitFor(() => expect(watches).toHaveLength(2));
            expect(controller.getSnapshot().servers?.[0]?.generation).toBe('g2');
            expect(selectCodeDiagnostics(controller.getDiagnosticsProjection()).items).toEqual([]);
            expect(watches[1].request.sinceRevision).toBeUndefined();
        } finally { controller.dispose(); }
    });

    it.each(['crashed', 'loading'] as const)('keeps a capable server answer authoritative while another server is %s', async other => {
        const server = { serverId: 'lang:server', label: 'Language', state: 'ready' as const, loading: false, generation: 'g1' };
        const range = { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } };
        const symbols = other === 'crashed' ? [{ serverId: server.serverId, name: 'Accurate', kind: 5, range, selectionRange: range }] : [];
        const controller = createCodeIntelligenceController({
            scope: { serverId: 'home', machineId: 'machine', rootPath: '/repo' }, path: 'src/current.ts', languageId: 'typescript',
            accountLifetime: { scope: { serverId: 'home', accountId: 'account' }, isCurrent: () => true, onRetire: () => ({ dispose() {} }) },
            getText: () => 'class Box {}', query: async () => result, openLocation() {},
            languageServer: {
                sync: async () => ({ status: 'ok', generation: 'g1', version: 1,
                    servers: [server, { ...server, serverId: 'lang:other', state: other === 'crashed' ? 'crashed' : 'starting', loading: other === 'loading' }],
                    capabilities: { hover: true, definition: true, references: true, documentSymbol: true, diagnostics: 'none', acceptsExternalChanges: false } }),
                query: async request => request.kind === 'documentSymbols'
                    ? { status: 'ok', kind: 'documentSymbols', generation: 'g1', version: 1, hasMore: false, symbols }
                    : { status: 'ok', kind: 'definition', generation: 'g1', version: 1, hasMore: false, locations: [] },
                watch: (_request, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
                restart: async () => ({ status: 'ok' }),
            },
        });
        try {
            await controller.definition({ line: 0, character: 6 });
            const baseline = { status: 'ok' as const, symbols: [{ name: 'Baseline', kind: 'class', line: 1, column: 6, depth: 0 }] };
            const selected = selectDocumentOutline({ baseline, server: await controller.outline() });
            expect(selected).toMatchObject({ status: 'ok', symbols: other === 'crashed' ? [{ name: 'Accurate' }] : [] });
            expect(controller.getSnapshot().servers?.[1]).toMatchObject({ state: other === 'crashed' ? 'crashed' : 'starting', loading: other === 'loading' });
        } finally { controller.dispose(); }
    });

    it('rejects a pending outline after its server crashes into another generation', async () => {
        let finishSymbols!: (answer: LanguageIntelligenceQueryResult) => void;
        let updateWatch!: (answer: LanguageIntelligenceWatchResult) => void;
        let startedSymbols!: () => void;
        const symbolStarted = new Promise<void>(resolve => { startedSymbols = resolve; });
        const server = { serverId: 'lang:server', label: 'Language', state: 'ready' as const, loading: false, generation: 'g1' };
        const controller = createCodeIntelligenceController({
            scope: { serverId: 'home', machineId: 'machine', rootPath: '/repo' }, path: 'src/current.ts', languageId: 'typescript',
            accountLifetime: { scope: { serverId: 'home', accountId: 'account' }, isCurrent: () => true, onRetire: () => ({ dispose() {} }) },
            getText: () => 'class Box {}', query: async () => result, openLocation() {},
            languageServer: {
                sync: async () => ({ status: 'ok', generation: 'g1', version: 1, servers: [server],
                    capabilities: { hover: true, definition: true, references: true, documentSymbol: true, diagnostics: 'none', acceptsExternalChanges: false } }),
                query: async request => {
                    if (request.kind !== 'documentSymbols') return { status: 'ok', kind: 'definition', generation: 'g1', version: 1, hasMore: false, locations: [] };
                    startedSymbols();
                    return new Promise(resolve => { finishSymbols = resolve; });
                },
                watch: (_request, signal) => new Promise((resolve, reject) => {
                    updateWatch = resolve;
                    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
                }),
                restart: async () => ({ status: 'ok' }),
            },
        });
        try {
            await controller.definition({ line: 0, character: 6 });
            const pending = controller.outline();
            await symbolStarted;
            const observedCrash = new Promise<void>(resolve => {
                const stop = controller.subscribe(() => {
                    if (controller.getSnapshot().servers?.[0]?.state === 'crashed') { stop(); resolve(); }
                });
            });
            updateWatch({ status: 'ok', revision: 1, servers: [{ ...server, state: 'crashed', generation: 'g2' }], diagnostics: {} });
            await observedCrash;
            const range = { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } };
            finishSymbols({ status: 'ok', kind: 'documentSymbols', generation: 'g1', version: 1, hasMore: false,
                symbols: [{ serverId: 'lang:server', name: 'Ghost', kind: 5, range, selectionRange: range }] });
            const baseline = { status: 'ok' as const, symbols: [{ name: 'Box', kind: 'class', line: 1, column: 6, depth: 0 }] };
            expect(selectDocumentOutline({ baseline, server: await pending })).toBe(baseline);
        } finally { controller.dispose(); }
    });

    it('keeps file open and outline passive, starts on the first explicit query, and closes the one document lease', async () => {
        const calls: string[] = [];
        const controller = createCodeIntelligenceController({
            scope: { serverId: 'home', machineId: 'machine', rootPath: '/repo' }, path: 'src/current.ts', languageId: 'typescript',
            accountLifetime: { scope: { serverId: 'home', accountId: 'account' }, isCurrent: () => true, onRetire: () => ({ dispose() {} }) },
            getText: () => 'const total = answer(1);',
            query: async () => { calls.push('fallback'); return result; },
            openLocation: location => { calls.push(`open:${location.path}`); },
            languageServer: {
                sync: async request => {
                    calls.push(request.op.op);
                    return { status: 'ok', generation: 'g1', version: 1,
                        servers: [{ serverId: 'lang:server', label: 'Language', state: 'ready', loading: false, generation: 'g1' }],
                        capabilities: { hover: true, definition: true, references: true, documentSymbol: true, diagnostics: 'pull', acceptsExternalChanges: true } };
                },
                query: async request => {
                    calls.push(request.kind);
                    return { status: 'ok', kind: 'definition', generation: 'g1', version: 1, hasMore: false,
                        locations: [{ serverId: 'lang:server', path: 'src/server-target.ts', range: result.locations[0].range }] };
                },
                watch: (_request, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
                restart: async () => ({ status: 'ok' }),
            },
        });
        expect(calls).toEqual([]);
        expect(await controller.outline()).toBeNull();
        expect(calls).toEqual([]);
        await controller.definition({ line: 0, character: 16 });
        expect(calls).toEqual(['open', 'definition', 'open:src/server-target.ts']);
        expect(controller.getSnapshot()).toMatchObject({ mode: 'server', status: 'ready' });
        controller.dismiss();
        expect(controller.getSnapshot().servers?.[0]?.serverId).toBe('lang:server');
        expect(controller.getSnapshot().capabilities?.documentSymbol).toBe(true);
        controller.dispose();
        await vi.waitFor(() => expect(calls.filter(call => call === 'close')).toHaveLength(1));
        expect(calls).not.toContain('diagnostics');
    });
});
