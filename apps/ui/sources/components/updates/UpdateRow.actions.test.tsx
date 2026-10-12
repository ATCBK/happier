import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import type { UpdateItem } from '@/updates/items/updateItem';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
const clipboard = vi.hoisted(() => ({ write: vi.fn(async () => true) }));
// Expo's clipboard SDK is the genuine platform effect boundary.
vi.mock('expo-clipboard', () => ({ setStringAsync: clipboard.write }));
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { UpdateRow } = await import('./UpdateRow');
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
afterEach(() => { standardCleanup(); vi.unstubAllGlobals(); });

const failed: UpdateItem = {
    id: 'studio:happier-cli', subject: { kind: 'happier-cli' }, machineId: 'studio', title: 'Happier CLI',
    currentVersion: '1.0.0', latestVersion: '1.1.0', state: 'failed', progressPercent: null, step: null,
    managedBy: 'happier', action: { kind: 'run', verb: 'retry' },
    failure: { kind: 'message', message: 'Failed.' }, skipped: false,
    logPath: 'C:\\Users\\Alice\\Happier logs\\update.txt',
};

describe('Updates log-copy Action admission', () => {
    it('keeps the exact remote log path out of the clipboard before canonical confirmation', async () => {
        await homes.reset();
        clipboard.write.mockClear();
        const serverId = await homes.addHome({ name: 'Updates', serverUrl: 'https://updates-copy.test', accountId: 'alice' });
        await homes.requireUiApproval(serverId, 'clipboard.write');
        const screen = await renderScreen(<UpdateRow item={failed} where="Studio" presentation="screen" secondaryAction={false} onRun={() => {}} />);
        await screen.pressByTestIdAsync(`updates.row.${failed.id}.viewLog`);
        expect(clipboard.write).not.toHaveBeenCalled();
        expect(screen.findAllByTestId(`updates.row.${failed.id}.viewLog.copied`)).toHaveLength(0);
        await vi.waitFor(() => expect(homes.artifacts(serverId).list()).toHaveLength(1));
        const approval = homes.artifacts(serverId).list()[0];
        expect(approval).toBeDefined();
        const replay = await createDefaultActionExecutor().execute('approval.request.decide', {
            artifactId: approval.id, decision: 'approve',
        }, { surface: 'ui', serverId, expectedAccountId: 'alice' });
        expect(replay).toMatchObject({ ok: true, result: { status: 'executed', execution: {
            ok: true, result: { status: 'copied' },
        } } });
        expect(clipboard.write.mock.calls).toEqual([[failed.logPath]]);
    });

    it('does not claim a remote log was copied when the platform clipboard rejects the write', async () => {
        await homes.reset();
        clipboard.write.mockClear();
        clipboard.write.mockRejectedValueOnce(new Error('Clipboard unavailable'));
        await homes.addHome({ name: 'Updates', serverUrl: 'https://updates-copy-failure.test', accountId: 'alice' });
        const screen = await renderScreen(<UpdateRow item={failed} where="Studio" presentation="screen" secondaryAction={false} onRun={() => {}} />);
        await screen.pressByTestIdAsync(`updates.row.${failed.id}.viewLog`);
        await vi.waitFor(() => expect(clipboard.write).toHaveBeenCalledWith(failed.logPath));
        expect(screen.findAllByTestId(`updates.row.${failed.id}.viewLog.copied`)).toHaveLength(0);
    });

    it('shows copied feedback only after an admitted successful platform write', async () => {
        await homes.reset();
        clipboard.write.mockClear();
        await homes.addHome({ name: 'Updates', serverUrl: 'https://updates-copy-success.test', accountId: 'alice' });
        const screen = await renderScreen(<UpdateRow item={failed} where="Studio" presentation="screen" secondaryAction={false} onRun={() => {}} />);
        await screen.pressByTestIdAsync(`updates.row.${failed.id}.viewLog`);
        await vi.waitFor(() => expect(screen.findAllByTestId(`updates.row.${failed.id}.viewLog.copied`).length).toBeGreaterThan(0));
        expect(clipboard.write.mock.calls).toEqual([[failed.logPath]]);
    });

    it('opens a local desktop log through the existing path Action only after admission', async () => {
        await homes.reset();
        clipboard.write.mockClear();
        // The desktop shell's native command bridge is the platform effect boundary.
        const invoke = vi.fn(async () => undefined);
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
        const serverId = await homes.addHome({ name: 'Updates', serverUrl: 'https://updates-local-log.test', accountId: 'alice' });
        await homes.requireUiApproval(serverId, 'relay.runtime.open_path');
        const screen = await renderScreen(<UpdateRow item={failed} where="This computer" presentation="screen" secondaryAction={false} isThisComputer onRun={() => {}} />);
        await screen.pressByTestIdAsync(`updates.row.${failed.id}.viewLog`);
        expect(invoke).not.toHaveBeenCalled();
        expect(clipboard.write).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(homes.artifacts(serverId).list()).toHaveLength(1));
        const approval = homes.artifacts(serverId).list()[0];
        expect(await createDefaultActionExecutor().execute('approval.request.decide', {
            artifactId: approval.id, decision: 'approve',
        }, { surface: 'ui', serverId, expectedAccountId: 'alice' }))
            .toMatchObject({ ok: true, result: { status: 'executed' } });
        expect(invoke.mock.calls).toEqual([['system_tasks_open_log_path', { path: failed.logPath }]]);
        expect(clipboard.write).not.toHaveBeenCalled();
    });
});
