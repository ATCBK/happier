import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { StoredApprovalRequestSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { installConnectedServicesCommonModuleMocks } from '@/components/settings/connectedServices/connectedServicesTestHelpers';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import { setRuntimeFetch, resetRuntimeFetch } from '@/utils/system/runtimeFetch';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

installConnectedServicesCommonModuleMocks();
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
setRuntimeFetch(home.request);
await loadSyncSingletonForTests();
// Load the real composition once, after its network boundary. Cold module
// transformation belongs to collection, rather than an interaction's timeout.
const { SidebarUsagePopoverContent, SidebarUsagePopoverView } = await import('./SidebarUsagePopoverContent');
const { renderUsageFrame } = await import('@/components/dev/connectedServices/usageFrames');
const { storage } = await import('@/sync/domains/state/storage');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } =
    await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const restoreExecutorLoader = await installRealActionExecutorModuleLoader();

afterEach(async () => { await standardCleanup(); await home.reset(); });
afterAll(() => { restoreExecutorLoader(); resetRuntimeFetch(); });

describe('Usage identity privacy through real Action wiring', () => {
    it.each(['rail', 'dev-frame'] as const)('routes the %s control through approval before masking identities', async surface => {
        setRuntimeFetch(home.request);
        const serverId = await home.addHome({ name: 'Usage privacy', serverUrl: 'https://usage-privacy-admission.test',
            accountId: 'privacy-owner', currentAccount: true });
        const credentials = await TokenStorage.getCredentialsForServerUrl('https://usage-privacy-admission.test', { serverId });
        if (!credentials) throw new Error('Expected the admitted Home credentials');
        const connection = await restoreServerAccountForTest({ serverUrl: 'https://usage-privacy-admission.test',
            accountId: 'privacy-owner', credentials, request: home.request });
        await home.requireUiApproval(serverId, 'connectedServices.identityPrivacy.set');
        const previousRuntime = getAppliedActiveServerSnapshot();
        const previousAvailable = isAppliedActiveServerRuntimeAvailable();
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        const previousHidden = storage.getState().localSettings.hideConnectedAccountIdentities;
        storage.getState().applyLocalSettings({ hideConnectedAccountIdentities: false }, { source: 'ui' });
        const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}>
            {surface === 'rail' ? <SidebarUsagePopoverContent close={() => {}} maxHeight={520} /> : renderUsageFrame('U1')}
        </InjectedAuthProvider>);
        try {
            await flushHookEffects();
            // The mounted invocation waits for human approval. Press without
            // awaiting its result so the test can decide that same Artifact.
            await act(async () => { screen.pressByTestId('usage-popover-privacy'); });
            await expect.poll(async () => {
                await flushHookEffects();
                return home.artifacts(serverId).list().length;
            }).toBe(1);
            const artifact = home.artifacts(serverId).list()[0]!;
            expect(StoredApprovalRequestSchema.parse(JSON.parse(home.artifacts(serverId).readPlainBody(artifact.id)!)))
                .toMatchObject({ actionId: 'connectedServices.identityPrivacy.set', actionArgs: { hidden: true } });
            expect(storage.getState().localSettings.hideConnectedAccountIdentities).toBe(false);
            expect(screen.findAllByType(SidebarUsagePopoverView)[0]?.props.privacy.hidden).toBe(false);
            expect(await decideApprovalAsInbox(serverId, artifact.id, 'approve'))
                .toMatchObject({ ok: true, result: { status: 'executed' } });
            await expect.poll(async () => {
                await flushHookEffects();
                return storage.getState().localSettings.hideConnectedAccountIdentities;
            }).toBe(true);
            expect(screen.findAllByType(SidebarUsagePopoverView)[0]?.props.privacy.hidden).toBe(true);
        } finally {
            await screen.unmount();
            storage.getState().applyLocalSettings({ hideConnectedAccountIdentities: previousHidden }, { source: 'ui' });
            publishAppliedActiveServerSnapshot(previousRuntime, previousAvailable);
            await connection.dispose();
        }
    });
});
