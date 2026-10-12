import { describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { DEFAULT_MEMORY_SETTINGS } from '@happier-dev/protocol/memory/memorySettings';
import { searchConversations, type ConversationSearchResult } from './searchConversations';

// Only the Account-scoped network transport is substituted. Source selection,
// request/response schemas, paging and the candidate adapter remain real.
const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: rpc }));

describe('conversation search incremental source pages', () => {
    it('publishes a completed source and its continuation while a second source runs', async () => {
        // Loading the real adapter belongs to setup, not the progress assertion.
        await import('@/sync/ops/machineExternalSessions');
        let release!: () => void;
        const slow = new Promise<void>(resolve => { release = resolve; });
        const controller = new AbortController();
        const pages: ConversationSearchResult[] = [];
        rpc.mockImplementation(async call => {
            if (call.method === RPC_METHODS.DAEMON_MEMORY_SETTINGS_GET) return { ...DEFAULT_MEMORY_SETTINGS, enabled: false };
            expect(call.method).toBe(RPC_METHODS.DAEMON_EXTERNAL_SESSIONS_CANDIDATES_LIST);
            expect(call).toMatchObject({ serverId: 'home', accountId: 'account', machineId: 'machine' });
            if (call.payload.agentId === 'codex') await slow;
            return { ok: true, candidates: [{ remoteSessionId: call.payload.agentId, updatedAtMs: 10,
                match: { sourceItemId: 'message', snippet: 'design lab', messageIndex: 0 } }],
                contentCoverage: 'partial', nextCursor: `${call.payload.agentId}-next` };
        });
        const pending = searchConversations({ serverId: 'home', accountId: 'account', concurrencyLimit: 1,
            machines: [{ id: 'machine', online: true }], mode: 'standard', signal: controller.signal,
            query: { v: 1, query: 'design lab', scope: { type: 'global' }, mode: 'auto', corpora: ['external_transcripts'] },
            readSources: async () => [
                { agentId: 'claude', sourceKey: 'claude', source: { kind: 'claudeConfig' }, contentSearch: true },
                { agentId: 'codex', sourceKey: 'codex', source: { kind: 'codexHome', home: 'user' }, contentSearch: true },
            ], onProgress: page => pages.push(page) });
        try {
            await vi.waitFor(() => expect(pages.some(page => page.hits.length === 1), JSON.stringify({ pages,
                methods: rpc.mock.calls.map(([call]) => call.method) })).toBe(true));
            const first = pages.find(page => page.hits.length === 1)!;
            expect(first.hits[0]).toMatchObject({ mode: 'standard', agentId: 'claude', candidate: { remoteSessionId: 'claude' } });
            expect(first.continuations).toEqual([{ machineId: 'machine', sourceKey: 'claude', cursor: 'claude-next' }]);
            expect(first.machines).toMatchObject([{ machineId: 'machine', status: 'partial' }]);
            release();
            const final = await pending;
            expect(final.hits).toHaveLength(2);
            // A published page is an immutable snapshot, not the shared work arrays.
            expect(first.hits).toHaveLength(1);
            expect(first.continuations).toHaveLength(1);
        } finally { release(); controller.abort(); await pending.catch(() => undefined); }
    });
});
