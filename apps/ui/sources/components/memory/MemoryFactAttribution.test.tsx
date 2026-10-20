import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UserProfileSchema } from '@happier-dev/protocol/social/friends';
import { MemoryFactV1Schema, type MemoryFactV1 } from '@happier-dev/protocol/prompts/library/memoryDocV1';

import { renderScreen } from '@/dev/testkit';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import type { MemoryDocumentSource } from './useMemoryDocument';

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

// Only Home HTTP, credential persistence and the cold Socket transport are substituted.
// Both Memory presenters, profile-scope admission and Account actor projection stay real.
installDisconnectedServerSocketBoundary(socket => { socket.connected = true; });
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { MemoryDocumentBody } = await import('./MemoryDocumentBody');
const { MemoryFactDetail } = await import('./MemoryFactDetail');
const { ItemList } = await import('@/components/ui/lists/ItemList');
const baseline = storage.getState();
let serverId: string;
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
let webLocks: ReturnType<typeof installWebLockManagerMock>;

beforeEach(async () => {
    webLocks = installWebLockManagerMock();
    await homes.reset();
    storage.setState(baseline, true);
    serverId = await homes.addHome({ name: 'Memory Home', serverUrl: 'https://memory-attribution.test', accountId: 'reader' });
    connection = await restoreServerAccountForTest({ serverUrl: 'https://memory-attribution.test', accountId: 'reader', request: homes.request });
    installHomeGovernanceBoundaries(homes);
    storage.getState().activateProfileScope({ serverId, accountId: 'reader' });
});

afterEach(async () => {
    await standardCleanup();
    await connection?.dispose();
    connection = null;
    const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
    await serverScopedRpcSocketPool.stopAll();
    webLocks.restore();
    installHomeGovernanceBoundaries(homes);
});

function note(): MemoryFactV1 {
    return MemoryFactV1Schema.parse({ id: 'fact', text: 'Keep the deployment window explicit', createdAtMs: 1_000, sourceSessionRef: null });
}

function decision(approver: string | null = 'approver'): MemoryFactV1 {
    return MemoryFactV1Schema.parse({ ...note(), decision: {
        reason: 'Deployments need a predictable window',
        sourceMessageRef: { kind: 'session', session: { serverId, sessionId: 'source-session' }, messageId: 'committed-message' },
        approvedBy: approver === null ? null : { accountId: approver, atMs: 2_000 },
    } });
}

function profile(name: string) {
    return UserProfileSchema.parse({ id: 'approver', name, firstName: name, lastName: null,
        avatar: null, username: 'approver', bio: null, status: 'friend', publicKey: null });
}

function FactSurfaces({ fact, documentServerId = serverId }: Readonly<{ fact: MemoryFactV1; documentServerId?: string }>) {
    const source: MemoryDocumentSource = { status: 'ready', stale: false, target: null, draftCustody: null,
        refresh: async () => null, view: { artifactId: 'shared-memory', ref: { kind: 'doc', serverId: documentServerId, artifactId: 'shared-memory' },
            access: 'view', shared: true, audience: null, title: 'Shared memory', revision: { headerVersion: 1, bodyVersion: 1 },
            facts: [fact], topics: [], topic: { title: 'Deployments', summary: '' } } };
    return <>
        <ItemList><MemoryDocumentBody testID="memory-row" source={source} serverId={serverId}
            composing={false} onComposingChange={() => undefined} emptyText="" readOnly viewerAccountId="reader" /></ItemList>
        <MemoryFactDetail testID="memory-detail" fact={fact} documentRef={source.view!.ref} serverId={serverId}
            viewerAccountId="reader" archived={false} />
    </>;
}

describe('Memory fact attribution across row and detail', () => {
    it('does not credit a source-less shared note to its reader', async () => {
        const screen = await renderScreen(<FactSurfaces fact={note()} />);
        expect(screen.getTextContent()).not.toContain('memoryContext.memory.addedByYou');
        expect(screen.getTextContent()).not.toContain('reader');
    });

    it('uses the current authorized approver name in both views, and retires it when the profile is revoked', async () => {
        storage.getState().applyUsers({ approver: profile('Ana Rivera') });
        const screen = await renderScreen(<FactSurfaces fact={decision()} />);
        expect(screen.getTextContent().match(/Ana Rivera/g)).toHaveLength(2);
        await act(async () => { storage.getState().applyUsers({ approver: profile('Ana Chen') }); });
        expect(screen.getTextContent().match(/Ana Chen/g)).toHaveLength(2);
        expect(screen.getTextContent()).not.toContain('Ana Rivera');
        await act(async () => { storage.getState().applyUsers({ approver: null }); });
        expect(screen.getTextContent()).not.toContain('Ana Chen');
        expect(screen.getTextContent()).not.toContain('approver');
        expect(screen.getTextContent()).toContain('memoryContext.memory.detailApprovedOn');
    });

    it('keeps an unknown or differently scoped approver neutral without exposing the stored id or another Home name', async () => {
        const screen = await renderScreen(<FactSurfaces fact={decision()} />);
        expect(screen.getTextContent()).not.toContain('approver');
        await act(async () => {
            storage.setState({ users: { approver: profile('Private profile') },
                profileScope: { serverId: 'another-home', accountId: 'reader' } });
        });
        expect(screen.getTextContent()).not.toContain('Private profile');
        expect(screen.getTextContent()).not.toContain('approver');
    });

    it('does not use an ambient same-id profile for a document from another Home', async () => {
        storage.getState().applyUsers({ approver: profile('Local namesake') });
        const screen = await renderScreen(<FactSurfaces fact={decision()} documentServerId="another-home" />);
        expect(screen.getTextContent()).not.toContain('Local namesake');
        expect(screen.getTextContent()).not.toContain('approver');
    });

    it('distinguishes witnessed self approval from the absence of person approval', async () => {
        const screen = await renderScreen(<FactSurfaces fact={decision('reader')} />);
        expect(screen.getTextContent()).toContain('memoryContext.memory.decisionApprovedByYou');
        expect(screen.getTextContent()).toContain('memoryContext.memory.detailApprovedByYou');
        await screen.update(<FactSurfaces fact={decision(null)} />);
        expect(screen.getTextContent().match(/memoryContext.memory.decisionNotApproved/g)).toHaveLength(2);
        expect(screen.getTextContent()).not.toContain('ApprovedByYou');
    });
});
