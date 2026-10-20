import * as React from 'react';
import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@/dev/testkit/hooks/renderHook';
import type { CodeIntelligenceControllerInput } from './createCodeIntelligenceController';
import { useCodeIntelligenceController } from './useCodeIntelligenceController';

describe('mounted code intelligence custody', () => {
    it('survives StrictMode effect replay and releases the sole Account subscription on unmount', async () => {
        let subscriptions = 0;
        let queries = 0;
        const input: CodeIntelligenceControllerInput = {
            scope: { serverId: 'home', machineId: 'machine', rootPath: '/repo' }, path: 'file.ts', languageId: 'typescript',
            getText: () => 'answer()',
            accountLifetime: {
                scope: { serverId: 'home', accountId: 'account' }, isCurrent: () => true,
                onRetire: () => {
                    subscriptions++;
                    let disposed = false;
                    return { dispose() { if (!disposed) { disposed = true; subscriptions--; } } };
                },
            },
            query: async () => {
                queries++;
                return { status: 'ok', source: 'text_matches', coverage: 'complete', hasMore: false, locations: [] };
            },
            openLocation() {},
        };
        const hook = await renderHook(() => useCodeIntelligenceController(input), { wrapper: React.StrictMode });
        try {
            await act(async () => { await hook.getCurrent()?.references({ line: 0, character: 2 }); });
            expect(queries).toBe(1);
            expect(subscriptions).toBe(1);
        } finally { await hook.unmount(); }
        expect(subscriptions).toBe(0);
    });
});
