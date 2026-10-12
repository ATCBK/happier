import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { V2SessionRecord } from '@happier-dev/protocol';

import { fetchAndApplySessions, type SessionListEncryption } from './sessionSnapshot';

/**
 * Voice announcements are a genuine side-effect boundary reached by the hydrated
 * apply path; the session-list logic under test runs unchanged beneath it.
 */
vi.mock('@/voice/context/voiceHooks', () => ({
    voiceHooks: {
        onAgentRequest: vi.fn(),
    },
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({
        serverId: 'test',
        serverUrl: 'https://example.test',
        kind: 'custom',
        generation: 1,
    }),
}));

function buildPlainRow(id: string): V2SessionRecord {
    return {
        id,
        seq: 1,
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
        meaningfulActivityAt: 1_700_000_000_000,
        active: false,
        activeAt: 1_700_000_000_000,
        archivedAt: null,
        encryptionMode: 'plain',
        metadata: JSON.stringify({ path: '/repo', host: 'host' }),
        metadataVersion: 1,
        agentState: JSON.stringify({}),
        agentStateVersion: 1,
        lastViewedSessionSeq: 1,
        pendingPermissionRequestCount: 0,
        pendingUserActionRequestCount: 0,
        pendingBlockedCount: 0,
        dataEncryptionKey: null,
        share: null,
    };
}

function createEncryptionHarness(): SessionListEncryption {
    return {
        decryptEncryptionKeys: vi.fn(async (values: readonly string[]) => values.map(() => null)),
        initializeSessions: vi.fn(async () => {}),
        removeSessionEncryption: vi.fn(),
        getSessionEncryption: vi.fn(() => null),
    };
}

async function snapshotCoverage(page: { hasNext: boolean; nextCursor: string | null }): Promise<boolean | undefined> {
    const coverage: Array<boolean | undefined> = [];
    await fetchAndApplySessions({
        credentials: { token: 't', secret: 's' } as AuthCredentials,
        encryption: createEncryptionHarness(),
        sessionDataKeys: new Map<string, Uint8Array>(),
        request: async () => new Response(JSON.stringify({ sessions: [buildPlainRow('s1')], ...page }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        }),
        applySessionListRenderables: (_renderables, options) => {
            coverage.push(options?.coversWholeList);
        },
        applySessions: () => {},
        repairInvalidReadStateV1: async () => {},
        log: { log: () => {} },
    });
    expect(coverage).toHaveLength(1);
    return coverage[0];
}

afterEach(() => {
    vi.clearAllMocks();
});

describe('session-list snapshot replacement coverage', () => {
    it('declares the replacement authoritative for the whole list when the server has no further page', async () => {
        await expect(snapshotCoverage({ hasNext: false, nextCursor: null })).resolves.toBe(true);
    });

    it('declares the replacement partial when the server has a further page', async () => {
        await expect(snapshotCoverage({ hasNext: true, nextCursor: 'cursor_2' })).resolves.toBe(false);
    });

    it('keeps the replacement partial when the server reports a further page it cannot page to', async () => {
        await expect(snapshotCoverage({ hasNext: true, nextCursor: null })).resolves.toBe(false);
    });
});
