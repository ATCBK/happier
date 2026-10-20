import { describe, expect, it } from 'vitest';

import { createTestMetadata } from './sessionMetadata';
import * as mod from './sessionFixtures';

describe('session fixtures', () => {
    it('defaults runtime session metadata to the canonical metadata helper', async () => {
        const { getMetadata } = mod.createSessionClientWithMetadata();

        expect(getMetadata()).toEqual(createTestMetadata());
    });

    it('creates a mock session with canonical metadata defaults', async () => {
        const mockSession = mod.createMockSession();

        expect(mockSession.metadata).toEqual(createTestMetadata());
    });

    it('merges partial mock-session metadata overrides onto canonical defaults', async () => {
        const mockSession = mod.createMockSession({
            metadata: {
                path: '/tmp/override',
            },
        });

        expect(mockSession.metadata).toEqual(
            createTestMetadata({
                path: '/tmp/override',
            }),
        );
    });

    it('creates plaintext session fixtures with canonical metadata defaults', async () => {
        const session = mod.createPlainSessionFixture();

        expect(session).toMatchObject({
            id: 'test-session-id',
            seq: 0,
            encryptionMode: 'plain',
            metadata: createTestMetadata(),
            metadataVersion: 0,
            agentState: null,
            agentStateVersion: 0,
        });
        expect('encryptionKey' in session).toBe(false);
    });

    it('creates plaintext session fixtures with metadata overrides', async () => {
        const session = mod.createPlainSessionFixture({
            id: 'plain-1',
            metadata: createTestMetadata({ machineId: 'machine-1' }),
        });

        expect(session).toMatchObject({
            id: 'plain-1',
            encryptionMode: 'plain',
            metadata: createTestMetadata({ machineId: 'machine-1' }),
        });
    });

    it('creates session record fixtures with stable defaults', async () => {
        const row = mod.createSessionRecordFixture({ id: 'sess-1' });

        expect(row).toMatchObject({
            id: 'sess-1',
            seq: 0,
            active: false,
            activeAt: 0,
            metadata: 'metadata',
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            pendingCount: 0,
            pendingVersion: 0,
            dataEncryptionKey: null,
        });
    });

    it('creates session list response fixtures with stable pagination defaults', async () => {
        const row = mod.createSessionRecordFixture({ id: 'sess-1' });
        const response = mod.createSessionListResponseFixture([row]);

        expect(response).toEqual({
            sessions: [row],
            nextCursor: null,
            hasNext: false,
        });
    });

    it('creates lightweight api session clients with metadata snapshots', async () => {
        const session = mod.createApiSessionClientFixture({
            metadataPermissionMode: 'read-only',
        });

        expect(session.getMetadataSnapshot?.()).toEqual(
            createTestMetadata({ permissionMode: 'read-only' }),
        );
    });

    it('creates mutable api session clients with canonical metadata lifecycle helpers', async () => {
        const session = mod.createMutableApiSessionClientFixture({
            sessionId: 'session-port-1',
            metadataPermissionMode: 'read-only',
        });

        expect(session.getMetadataSnapshot?.()).toEqual(
            createTestMetadata({ permissionMode: 'read-only' }),
        );

        const currentMetadata = session.__getMetadata();
        if (!currentMetadata) {
            throw new Error('Expected metadata fixture');
        }

        session.updateMetadata((current) => ({
            ...(current ?? currentMetadata),
            permissionMode: 'default',
        }));

        expect(session.__getMetadata()).toMatchObject({ permissionMode: 'default' });

        const replacement = createTestMetadata({ permissionMode: 'acceptEdits' });
        session.__setMetadata(replacement);
        expect(session.getMetadataSnapshot?.()).toEqual(replacement);

        let metadataUpdated = 0;
        const onMetadataUpdated = () => { metadataUpdated += 1; };
        session.on('metadata-updated', onMetadataUpdated);
        session.updateMetadata((current) => current);
        expect(metadataUpdated).toBe(1);
        session.off('metadata-updated', onMetadataUpdated);
        session.updateMetadata((current) => current);
        expect(metadataUpdated).toBe(1);

        session.rpcHandlerManager.registerHandler('test.echo', async (input) => ({ input }));
        await expect(session.rpcHandlerManager.invokeLocal('test.echo', { value: 1 })).resolves.toEqual({
            input: { value: 1 },
        });

        await session.updateAgentState((current) => ({ ...current, ready: true }));
        expect(session.__getAgentState()).toEqual({ ready: true });
        expect(session.sessionId).toBe('session-port-1');
    });

    it('waits for mutable Session metadata and releases waits on abort or close', async () => {
        const session = mod.createMutableApiSessionClientFixture({ metadata: createTestMetadata() });
        const changed = session.waitForMetadataUpdate();
        session.updateMetadata((current) => current);
        await expect(changed).resolves.toBe(true);

        const abort = new AbortController();
        const aborted = session.waitForMetadataUpdate(abort.signal);
        abort.abort();
        await expect(aborted).resolves.toBe(false);
        await expect(session.waitForMetadataUpdate(abort.signal)).resolves.toBe(false);

        const closed = session.waitForMetadataUpdate();
        await session.close();
        await expect(closed).resolves.toBe(false);
        await expect(session.waitForMetadataUpdate()).resolves.toBe(false);
    });

    it('keeps current-publisher updates on the supplied metadata transport boundary', async () => {
        let metadata = createTestMetadata({ permissionMode: 'read-only' });
        const session = mod.createMutableApiSessionClientFixture({
            metadata,
            overrides: {
                updateMetadata(update) {
                    const next = update(metadata);
                    if (next) metadata = next;
                },
            },
        });
        await session.updateMetadataAsCurrentPublisher(current => ({ ...current, permissionMode: 'default' }));
        expect(metadata.permissionMode).toBe('default');
    });

    it('retains the immutable server binding captured when the Session is constructed', async () => {
        const binding = { serverId: 'fixture-home', serverUrl: 'https://fixture-home.example' };
        const session = mod.createMutableApiSessionClientFixture({ serverBinding: binding });
        binding.serverUrl = 'https://another-home.example';

        expect(session.getServerBinding()).toEqual({ serverId: 'fixture-home', serverUrl: 'https://fixture-home.example' });
        expect(Object.isFrozen(session.getServerBinding())).toBe(true);
    });

    it('creates basic session clients with selective overrides', async () => {
        const seen: string[] = [];
        const session = mod.createBasicSessionClientWithOverrides({
            enqueueAgentMessageCommitted: async (_provider, body) => {
                seen.push(String((body as { type?: string })?.type ?? 'unknown'));
                return { persisted: true, delivered: false };
            },
        });

        await session.enqueueAgentMessageCommitted('provider', { type: 'thinking' } as never, {
            localId: 'thinking-1',
            provenance: { kind: 'non_dependent', source: 'background' },
        });

        expect(seen).toEqual(['thinking']);
    });
});
