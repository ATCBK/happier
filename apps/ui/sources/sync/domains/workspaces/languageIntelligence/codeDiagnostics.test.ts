import { describe, expect, it, vi } from 'vitest';
import type { LanguageIntelligenceDiagnostic, LanguageIntelligenceWatchResult } from '@happier-dev/protocol/machines/languageIntelligence';
import { EMPTY_CODE_DIAGNOSTICS, bindCodeDiagnosticDecorations, mergeCodeDiagnostics, selectCodeDiagnostics } from './codeDiagnostics';

const diagnostic = (serverId: string, message = 'Unknown name'): LanguageIntelligenceDiagnostic => ({
    serverId, path: 'a.ts', range: { start: { line: 1, character: 3 }, end: { line: 1, character: 7 } }, severity: 'error', message,
});
const server = (serverId: string, state: 'ready' | 'crashed' = 'ready') => ({ serverId, label: serverId, state, loading: false, generation: 'g1' });
const fence = { documentVersions: new Map([['a.ts', 2]]), serverGenerations: new Map([['one', 'g1'], ['two', 'g1']]) };
type Watch = Extract<LanguageIntelligenceWatchResult, { status: 'ok' }>;
const update = (revision: number, diagnostics: Watch['diagnostics'], servers = [server('one'), server('two')]): Watch => ({ status: 'ok', revision, diagnostics, servers });

describe('code diagnostics client projection', () => {
    it('replaces each server/path, dedupes markers, clears one crashed server and fences stale input', () => {
        const item = diagnostic('one');
        let projection = mergeCodeDiagnostics(EMPTY_CODE_DIAGNOSTICS, update(1, { 'a.ts': {
            one: { state: 'ready', version: 2, generation: 'g1', items: [item] },
            two: { state: 'ready', version: 2, generation: 'g1', items: [diagnostic('two'), diagnostic('two', 'Different problem')] },
        } }), fence);
        expect(selectCodeDiagnostics(projection, 'a.ts')).toMatchObject({ state: 'ready', count: 2 });
        const layers: unknown[][] = [];
        let changed = () => {};
        const unsubscribe = vi.fn();
        const dispose = bindCodeDiagnosticDecorations({ path: 'a.ts', getProjection: () => projection,
            subscribe: (listener) => { changed = listener; return unsubscribe; },
            handle: { setDecorations: (layer, items) => layers.push([layer, items]) } });
        expect(layers.at(-1)).toEqual(['diagnostic', [expect.objectContaining({ severity: 'error', startLine: 2, startCharacter: 3 }),
            expect.objectContaining({ message: 'Different problem' })]]);
        projection = mergeCodeDiagnostics(projection, update(2, {}, [server('one', 'crashed'), server('two')]), fence);
        changed();
        expect(selectCodeDiagnostics(projection, 'a.ts').count).toBe(2);
        projection = mergeCodeDiagnostics(projection, update(3, { 'a.ts': { two: { state: 'ready', version: 2, generation: 'g1', items: [] } } }), fence);
        changed();
        expect(layers.at(-1)).toEqual(['diagnostic', []]);
        expect(selectCodeDiagnostics(projection, 'a.ts').count).toBe(0);
        const stale = mergeCodeDiagnostics(projection, update(4, { 'a.ts': { two: { state: 'ready', version: 1, generation: 'g1', items: [item] } } }), fence);
        expect(selectCodeDiagnostics(stale, 'a.ts').count).toBe(0);
        const oldGeneration = mergeCodeDiagnostics(stale, update(5, { 'a.ts': { two: { state: 'ready', version: 2, generation: 'old', items: [item] } } }), fence);
        expect(selectCodeDiagnostics(oldGeneration, 'a.ts').count).toBe(0);
        expect(mergeCodeDiagnostics(oldGeneration, update(1, { 'a.ts': { two: { state: 'ready', version: 2, generation: 'g1', items: [item] } } }), fence)).toBe(oldGeneration);
        dispose();
        expect(unsubscribe).toHaveBeenCalledOnce();
        expect(layers.at(-1)).toEqual(['diagnostic', []]);
    });

    it('has no speculative count and never presents checking as an authoritative empty', () => {
        expect(selectCodeDiagnostics(EMPTY_CODE_DIAGNOSTICS)).toMatchObject({ state: 'idle', count: null });
        const projection = mergeCodeDiagnostics(EMPTY_CODE_DIAGNOSTICS, update(1, { 'a.ts': {
            one: { state: 'checking', version: 2, generation: 'g1', items: [] },
        } }), fence);
        expect(selectCodeDiagnostics(projection, 'a.ts')).toMatchObject({ state: 'checking', count: null });
    });
});
