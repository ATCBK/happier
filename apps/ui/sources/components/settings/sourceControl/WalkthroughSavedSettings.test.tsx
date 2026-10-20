import * as React from 'react';
import '@/dev/testkit/harness/syncSingletonLoader';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { t } from '@/text';

const boundary = vi.hoisted(() => ({
    list: async (_machineId: string): Promise<unknown> => { throw new Error('Owning machine unavailable'); },
}));

// Device custody and the remote machine are external; binding, schemas and saved operations stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    const rpc = async (request: { machineId: string; method: string }) => {
        if (request.method === RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_LIST) return boundary.list(request.machineId);
        throw new Error(`Unexpected machine method: ${request.method}`);
    };
    // Method-specific wire answers at the external generic RPC boundary.
    return createServerScopedMachineRpcBoundaryMock(rpc as typeof import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc').machineRpcWithServerScope);
});

// Native rendering adapters only; the settings store and credential binding remain real.
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});
vi.mock('@expo/vector-icons/Ionicons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    const icons = createExpoVectorIconsMock();
    return { default: icons.Ionicons, Ionicons: icons.Ionicons };
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});

const { createHomeGovernanceHarness, installHomeGovernanceBoundaries } = await import('@/dev/testkit/harness/homeGovernanceHarness');
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();
const { installRealActionExecutorModuleLoader } = await import('@/dev/testkit/harness/actionHomesHttpHarness');
const disposeActionLoader = await installRealActionExecutorModuleLoader();
const { renderSettingsView } = await import('@/dev/testkit/harness/settingsViewHarness');
const { Switch } = await import('@/components/ui/forms/Switch');
const { WalkthroughSavedSettings } = await import('./WalkthroughSavedSettings');
afterAll(disposeActionLoader);
beforeEach(async () => homes.reset());
afterEach(async () => { standardCleanup(); await homes.reset(); });
async function addHome(name: string) {
    const id = await homes.addHome({ name, serverUrl: 'https://saved-settings.example.test', accountId: 'saved-account',
        accountEncryptionMode: 'plain', currentAccount: true });
    homes.answer(id, '/v1/account/encryption/currentness', { body: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
    } });
    return { id };
}

describe('Prepare walkthrough preference', () => {
    it('offers Retry for a failed online read and uses reconnect copy only for offline presence', async () => {
        const home = await addHome('Saved retry');
        const pending = createDeferred<unknown>();
        boundary.list = async () => pending.promise;
        const view = (machineAvailability: 'online' | 'offline' | 'unselected') => <WalkthroughSavedSettings
            machineId="retry-machine" serverId={home.id} machineName="Computer" machineAvailability={machineAvailability}
            prepareAfterTurn={false} onPrepareAfterTurn={() => {}} modelAvailable={false} />;
        const screen = await renderSettingsView(view('online'));
        expect(screen.getTextContent()).not.toContain(t('walkthroughSettings.unavailableData'));
        await act(async () => { pending.resolve({ success: false, errorCode: 'result_unavailable', error: 'Saved inventory read failed' }); });
        await vi.waitFor(() => expect(screen.findHostByTestId('settings.sourceControl.savedWalkthroughs.retry')).not.toBeNull());
        expect(screen.getTextContent()).not.toContain(t('walkthroughSettings.unavailableData'));
        expect(screen.getTextContent()).not.toContain(t('walkthroughSettings.costUnavailable'));
        await screen.update(view('unselected'));
        expect(screen.findHostByTestId('settings.sourceControl.savedWalkthroughs.retry') === null).toBe(true);
        await screen.update(view('online'));
        await vi.waitFor(() => expect(screen.findHostByTestId('settings.sourceControl.savedWalkthroughs.retry')).not.toBeNull());
        boundary.list = async () => ({ success: true, results: [], count: 0, bytes: 0,
            sevenDayCost: { status: 'unavailable', pricedRunCount: 0, unpricedRunCount: 0, sinceMs: 0, untilMs: 1 } });
        await screen.pressByTestIdAsync('settings.sourceControl.savedWalkthroughs.retry');
        await vi.waitFor(() => expect(screen.getTextContent()).toContain(t('walkthroughSettings.savedCount', { count: 0, bytes: '0 B' })));
        await screen.update(view('offline'));
        expect(screen.getTextContent()).toContain(t('walkthroughSettings.unavailableData'));
        await screen.unmount();
    });
    it('hides Clear only after the owning machine confirms an empty saved inventory', async () => {
        const empty = createDeferred<unknown>();
        const listed = { success: true, results: [{ cwd: '/repo', resultId: 'saved', revision: 1,
            comparisonId: 'comparison', source: { kind: 'workingTree' }, bytes: 12, updatedAtMs: 1 }], count: 1, bytes: 12,
            sevenDayCost: { status: 'unavailable', pricedRunCount: 0, unpricedRunCount: 0, sinceMs: 0, untilMs: 1 } };
        boundary.list = async machineId => {
            if (machineId === 'empty') return empty.promise;
            if (machineId === 'populated') return listed;
            throw new Error('Owning machine offline');
        };
        const home = await addHome('Saved Settings');
        const { createScmDiffSummarySavedResultOperations } = await import('@/sync/ops/scmDiffSummary/savedResultOperations');
        expect(await createScmDiffSummarySavedResultOperations({ machineId: 'populated', serverId: home.id,
            accountId: 'saved-account', shouldContinue: () => true }).list()).toEqual(listed);
        const view = (machineId: string) => <WalkthroughSavedSettings machineId={machineId} serverId={home.id} machineName="Computer"
            machineAvailability="online"
            prepareAfterTurn={false} onPrepareAfterTurn={() => {}} modelAvailable={false} />;
        const screen = await renderSettingsView(view('empty'));
        const clear = () => screen.findHostByTestId('settings.sourceControl.savedWalkthroughs.clear');
        // Nothing destructive is offered until the machine says there is something to clear.
        expect(clear()).toBeNull();
        await act(async () => { empty.resolve({ ...listed, results: [], count: 0, bytes: 0 }); });
        // Establish that the real binding and strict inventory parser settled before the visibility RED.
        await vi.waitFor(() => expect(screen.getTextContent())
            .toContain(t('walkthroughSettings.savedCount', { count: 0, bytes: '0 B' })));
        await vi.waitFor(() => expect(clear() === null).toBe(true));
        await screen.update(view('populated'));
        await vi.waitFor(() => expect(clear()?.props.disabled).toBe(false));
        await screen.update(view('offline'));
        await vi.waitFor(() => expect(screen.findHostByTestId('settings.sourceControl.savedWalkthroughs.retry')).not.toBeNull());
        expect(clear()).toBeNull();
        await screen.unmount();
    });

    it('names its machine prerequisite and offers no Clear while no machine is chosen', async () => {
        const screen = await renderSettingsView(<WalkthroughSavedSettings machineId={null} serverId={null} machineName=""
            machineAvailability="unselected" prepareAfterTurn={false} onPrepareAfterTurn={() => {}} modelAvailable />);
        expect(screen.getTextContent()).toContain(t('walkthroughSettings.chooseMachine'));
        expect(screen.getTextContent()).not.toContain(t('settingsSourceControl.page.routing.chooseMachineDescription'));
        expect(screen.findHostByTestId('settings.sourceControl.savedWalkthroughs.clear')).toBeNull();
        await screen.unmount();
    });

    it('waits for a chosen machine by name instead of asking to choose one', async () => {
        const screen = await renderSettingsView(<WalkthroughSavedSettings machineId={null} serverId={null} machineName="Studio Mac"
            machineAvailability="missing" prepareAfterTurn={false} onPrepareAfterTurn={() => {}} modelAvailable />);
        expect(screen.getTextContent()).toContain(t('walkthroughSettings.waitingMachine', { machine: 'Studio Mac' }));
        expect(screen.getTextContent()).not.toContain(t('walkthroughSettings.chooseMachine'));
        expect(screen.findHostByTestId('settings.sourceControl.savedWalkthroughs.clear')).toBeNull();
        await screen.unmount();
    });

    it('allows opting out with an unavailable model but refuses opting in', async () => {
        function Controlled() {
            const [enabled, setEnabled] = React.useState(true);
            return <WalkthroughSavedSettings machineId={null} serverId={null} machineName=""
                machineAvailability="unselected"
                prepareAfterTurn={enabled} onPrepareAfterTurn={setEnabled} modelAvailable={false} />;
        }
        const screen = await renderSettingsView(<Controlled />);
        // Without an eligible model the row still says what it does, then what it needs first.
        expect(screen.getTextContent()).toContain(t('walkthroughSettings.prefetchDescription'));
        expect(screen.getTextContent()).toContain(t('walkthroughSettings.chooseModelFirst'));
        const toggle = () => screen.findAll(node => node.type === Switch)[0];
        expect(toggle().props.value).toBe(true);
        expect(toggle().props.disabled).toBe(false);
        await act(async () => { toggle().props.onValueChange(false); });
        expect(toggle().props.value).toBe(false);
        expect(toggle().props.disabled).toBe(true);
        await act(async () => { toggle().props.onValueChange(true); });
        expect(toggle().props.value).toBe(false);
        await screen.unmount();
    });
});
