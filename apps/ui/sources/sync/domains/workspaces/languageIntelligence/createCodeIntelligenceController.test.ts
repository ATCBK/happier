import { describe, expect, it } from 'vitest';
import type { CodeIntelligenceFallbackInput, CodeIntelligenceFallbackResult } from '@happier-dev/protocol/machines/codeIntelligenceFallback';
import { createCodeIntelligenceController } from './createCodeIntelligenceController';

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
});
