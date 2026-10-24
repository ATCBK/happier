import { replacePersistentUiStateForTest } from '@/dev/testkit/harness/persistentUiState';
import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod/mini';
import { getPersistenceStorage } from './persistenceStorage';
import { createPersistentUiState, UiStatePersistenceError } from './persistentUiState';
import { parseRecentWorkspaceFiles } from '@/sync/domains/workspaces/files/recentWorkspaceFiles';
import { appendFileEditorAiSuggestionUsage, FileEditorAiSuggestionDailyUsageSchema } from '@/sync/domains/workspaces/languageIntelligence/fileEditorAiSuggestionUsage';

describe('device-local keyed UI state', () => {
    it('withdraws retained projections when the canonical persistence lifecycle clears device data', async () => {
        const state = createPersistentUiState('clear-lifecycle', value => z.string().parse(value));
        state.set('draft', 'private content');
        const listener = vi.fn();
        const unsubscribe = state.subscribeKey('draft', listener);
        try {
            const { clearPersistence } = await import('./persistenceLifecycle');
            await clearPersistence();
            expect(state.read('draft')).toBeUndefined();
            expect(state.readAll()).toEqual({});
            expect(listener).toHaveBeenCalledTimes(1);
        } finally { unsubscribe(); }
    });
    it('restores real recents and usage through their persisted readers after a new owner loads', () => {
        const recents = createPersistentUiState('reload-recents', value => parseRecentWorkspaceFiles({ paths: value }).paths);
        const usage = createPersistentUiState('reload-usage', value => FileEditorAiSuggestionDailyUsageSchema.parse(value));
        recents.set('workspace-a', ['src/a.ts', 'src/b.ts']);
        const event = appendFileEditorAiSuggestionUsage({}, 'account-a', { kind: 'acceptedFull', inputTokens: 50, costUsd: 0.01 });
        usage.set('account-a', event['account-a']);
        const restoredRecents = createPersistentUiState('reload-recents', value => parseRecentWorkspaceFiles({ paths: value }).paths);
        const restoredUsage = createPersistentUiState('reload-usage', value => FileEditorAiSuggestionDailyUsageSchema.parse(value));
        expect(restoredRecents.read('workspace-a')).toEqual(['src/a.ts', 'src/b.ts']);
        expect(restoredUsage.read('account-a')).toMatchObject({ acceptedFull: 1, inputTokens: 50, reportedCostUsd: 0.01 });
        expect(restoredUsage.read('account-b')).toBeUndefined();
    });

    it('writes only a changed record and keeps unrelated readers quiet across a thousand scopes', () => {
        const state = createPersistentUiState('cost-contract', value => z.object({ position: z.number() }).parse(value));
        replacePersistentUiStateForTest(state, Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`scope-${i}`, { position: i }])));
        const unchanged = state.read('scope-0');
        const unaffected = vi.fn();
        const changed = vi.fn();
        const unsubscribe = state.subscribeKey('scope-0', unaffected);
        const unsubscribeChanged = state.subscribeKey('scope-999', changed);
        const writes = vi.spyOn(getPersistenceStorage(), 'set');
        try {
            state.set('scope-999', { position: 1001 });
            state.set('scope-999', { position: 1001 });
            expect(writes).toHaveBeenCalledTimes(1);
            expect(writes.mock.calls[0][0]).toBe('ui-state:cost-contract:scope-999');
            expect(unaffected).not.toHaveBeenCalled();
            expect(changed).toHaveBeenCalledTimes(1);
            expect(state.read('scope-0')).toBe(unchanged);
            const loaded = createPersistentUiState('cost-contract', value => z.object({ position: z.number() }).parse(value));
            const reads = vi.spyOn(getPersistenceStorage(), 'getString');
            try {
                expect(loaded.read('scope-999')).toEqual({ position: 1001 });
                expect(reads).toHaveBeenCalledTimes(1);
            } finally { reads.mockRestore(); }
        } finally { writes.mockRestore(); unsubscribe(); unsubscribeChanged(); }
    });

    it('retains the last persisted value and does not notify when the device refuses a write', () => {
        const state = createPersistentUiState('write-failure', value => z.string().parse(value));
        state.set('draft', 'before');
        const listener = vi.fn();
        const unsubscribe = state.subscribeKey('draft', listener);
        const write = vi.spyOn(getPersistenceStorage(), 'set').mockImplementation(() => { throw new Error('storage refused'); });
        try {
            expect(() => state.set('draft', 'after')).toThrow(UiStatePersistenceError);
            expect(state.read('draft')).toBe('before');
            expect(listener).not.toHaveBeenCalled();
        } finally { write.mockRestore(); unsubscribe(); }
        state.set('draft', 'after');
        expect(state.read('draft')).toBe('after');
    });
});
