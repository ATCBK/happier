import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { DEFAULT_MEMORY_SETTINGS } from '@happier-dev/protocol/memory/memorySettings';
import type { ConversationSearchResult, ConversationSearchSource } from './searchConversations';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
// Keep the scoped transport and candidate adapter beneath the real socket codec.
const rpc = vi.fn<(call: { method: string; payload: Record<string, unknown> }) => Promise<unknown>>();
installSessionActionRpcBoundary(request => rpc({ method: request.method,
    payload: request.params as Record<string, unknown> }));
await loadSyncSingletonForTests();
const { searchConversations } = await import('./searchConversations');
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let serverId: string;
beforeEach(async () => {
    await homes.reset();
    serverId = await homes.addHome({ name: 'Source progress Home', serverUrl: 'https://search-progress.test', accountId: 'account' });
    const machine = createPlainMachineRowFixture({ id: 'machine', accountId: 'account' });
    homes.answer(serverId, '/v1/machines/machine', { body: { machine } });
    homes.answer(serverId, '/v1/machines', { body: [machine] });
    connection = await restoreServerAccountForTest({ serverUrl: 'https://search-progress.test', accountId: 'account', request: homes.request });
    installHomeGovernanceBoundaries(homes);
    rpc.mockReset();
});
afterEach(async () => { await connection?.dispose(); connection = undefined; });

describe('conversation search incremental source pages', () => {
    it('publishes a completed source and its continuation while a second source runs', async () => {
        // Loading the real adapter belongs to setup, not the progress assertion.
        await import('@/sync/ops/machineExternalSessions');
        let release!: () => void;
        const slow = new Promise<void>(resolve => { release = resolve; });
        const controller = new AbortController();
        const pages: ConversationSearchResult[] = [];
        rpc.mockImplementation(async call => {
            if (call.method === `machine:${RPC_METHODS.DAEMON_MEMORY_SETTINGS_GET}`) return { ...DEFAULT_MEMORY_SETTINGS, enabled: false };
            expect(call.method).toBe(`machine:${RPC_METHODS.DAEMON_EXTERNAL_SESSIONS_CANDIDATES_LIST}`);
            if (call.payload.agentId === 'codex') await slow;
            return { ok: true, candidates: [{ remoteSessionId: call.payload.agentId, updatedAtMs: 10,
                match: { sourceItemId: 'message', snippet: 'design lab', messageIndex: 0 } }],
                contentCoverage: 'partial', nextCursor: `${call.payload.agentId}-next` };
        });
        const pending = searchConversations({ serverId, accountId: 'account', concurrencyLimit: 1,
            machines: [{ id: 'machine', online: true }], mode: 'standard', signal: controller.signal,
            query: { v: 1, query: 'design lab', scope: { type: 'global' }, mode: 'auto', corpora: ['external_transcripts'] },
            readSources: async (): Promise<readonly ConversationSearchSource[]> => [
                { agentId: 'claude', sourceKey: 'claude', source: { kind: 'claudeConfig' as const }, contentSearch: true },
                { agentId: 'codex', sourceKey: 'codex', source: { kind: 'codexHome' as const, home: 'user' as const }, contentSearch: true },
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
