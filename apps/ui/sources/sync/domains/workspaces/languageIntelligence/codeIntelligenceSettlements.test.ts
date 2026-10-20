import { describe, expect, it, vi } from 'vitest';
import { createToolCallMessageFixture } from '@/dev/testkit';
import { deriveSettledFileWrites } from '@/sync/domains/session/changes/derivation/deriveLiveFileWrites';
import { forwardCodeIntelligenceSettlements } from './codeIntelligenceSettlements';

describe('language intelligence settlement forwarding', () => {
    it('forwards a completed tool path once only while the server accepts external changes', async () => {
        const running = createToolCallMessageFixture({ id: 'write-message', tool: {
            id: 'write-import', name: 'Write', input: { file_path: '/repo/src/imported.ts', content: 'changed' },
            state: 'running', createdAt: 1, startedAt: 1, completedAt: null, description: null,
        } });
        const syncExternal = vi.fn<(paths: readonly string[]) => Promise<void>>().mockResolvedValue(undefined);
        let acceptsExternalChanges = false;
        const port = { acceptsExternalChanges: () => acceptsExternalChanges, syncExternal };
        const pending = deriveSettledFileWrites([running], { workspaceRoot: '/repo' });
        expect(pending.size).toBe(0);
        for (const write of pending.values()) await forwardCodeIntelligenceSettlements(write.paths, port);
        expect(syncExternal).not.toHaveBeenCalled();

        const completed = createToolCallMessageFixture({ ...running, tool: { ...running.tool, state: 'completed', completedAt: 2 } });
        const settled = deriveSettledFileWrites([completed], { workspaceRoot: '/repo' });
        expect([...settled.values()].map((write) => write.paths)).toEqual([['src/imported.ts']]);
        for (const write of settled.values()) await forwardCodeIntelligenceSettlements(write.paths, port);
        expect(syncExternal).not.toHaveBeenCalled();

        acceptsExternalChanges = true;
        for (const write of settled.values()) await forwardCodeIntelligenceSettlements(write.paths, port);
        expect(syncExternal.mock.calls).toEqual([[['src/imported.ts']]]);
        acceptsExternalChanges = false;
        for (const write of settled.values()) await forwardCodeIntelligenceSettlements(write.paths, port);
        expect(syncExternal.mock.calls).toEqual([[['src/imported.ts']]]);
    });
});
