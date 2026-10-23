import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { serveAccountHomes, installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { storage } from '@/sync/domains/state/storageStore';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { Modal } from '@/modal';

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);

import { SettingsHistorySection } from './SettingsHistorySection';

describe('SettingsHistorySection Action composition', () => {
    let home: Awaited<ReturnType<typeof serveAccountHomes>>;
    let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
    let restoreLoader: () => void;
    const initial = storage.getState();

    beforeEach(async () => {
        restoreLoader = await installRealActionExecutorModuleLoader();
        home = await serveAccountHomes({
            homes: [{ key: 'a', serverUrl: 'https://settings-history.test', accountId: 'account-a', currentAccount: true }],
            route: request => {
                if (request.path === '/v2/account/settings/history') return Response.json({ snapshots: [
                    { version: 3, createdAt: '2026-01-01T00:00:00.000Z', contentKind: 'plain', byteLength: 50 },
                ] });
                if (request.path === '/v2/account/settings/history/3') return Response.json({ version: 3,
                    createdAt: '2026-01-01T00:00:00.000Z', content: { t: 'plain', v: { preferredLanguage: 'de' } } });
                return undefined;
            },
        });
        vi.mocked(Modal.confirm).mockClear();
        vi.mocked(Modal.confirm).mockResolvedValue(true);
        vi.mocked(Modal.alert).mockClear();
    });

    afterEach(async () => {
        await screen?.unmount();
        screen = undefined;
        await home.dispose();
        restoreLoader();
        storage.setState(initial, true);
        vi.restoreAllMocks();
    });

    async function open(expanded = true) {
        const credentials = await TokenStorage.getCredentialsForServerUrl(home.homes.a!.serverUrl);
        screen = await renderScreen(<SettingsHistorySection credentials={credentials} encryption={null} />);
        if (expanded) await act(async () => {
            screen!.findByTestId('settings-account-history')!.findByProps({ accessibilityRole: 'button' }).props.onPress();
        });
        return screen;
    }

    it('restores through the real Action front door and one-shot CAS, then refreshes history', async () => {
        const view = await open();
        await vi.waitFor(() => expect(view.findByTestId('settings-account-history-restore-3')).not.toBeNull());
        await view.pressByTestIdAsync('settings-account-history-restore-3');
        await vi.waitFor(() => expect(storage.getState().settings.preferredLanguage).toBe('de'));
        expect(home.httpRequests.filter(row => row.path === '/v2/account/settings' && row.method === 'POST')).toHaveLength(1);
        await vi.waitFor(() => expect(home.requests.filter(row => row.path === '/v2/account/settings/history').length).toBeGreaterThan(1));
    });

    it('leaves Settings untouched when the Action confirmation is declined', async () => {
        vi.mocked(Modal.confirm).mockResolvedValue(false);
        const view = await open();
        await vi.waitFor(() => expect(view.findByTestId('settings-account-history-restore-3')).not.toBeNull());
        await view.pressByTestIdAsync('settings-account-history-restore-3');
        await vi.waitFor(() => expect(Modal.confirm).toHaveBeenCalled());
        expect(home.requests.some(row => row.path === '/v2/account/settings/history/3')).toBe(false);
        expect(home.httpRequests.some(row => row.path === '/v2/account/settings' && row.method === 'POST')).toBe(false);
    });

    it('cannot bypass disabled settings.invoke through the restore control', async () => {
        storage.getState().applySettingsLocal({ actionsSettingsV1: ActionsSettingsV1Schema.parse({
            v: 1, actions: { 'settings.invoke': { enabled: false } },
        }) });
        const view = await open();
        await vi.waitFor(() => expect(view.findByTestId('settings-account-history-restore-3')).not.toBeNull());
        await view.pressByTestIdAsync('settings-account-history-restore-3');
        await vi.waitFor(() => expect(Modal.alert).toHaveBeenCalled());
        expect(home.requests.some(row => row.path === '/v2/account/settings/history/3')).toBe(false);
    });

    it('does not restore into an Account selected during confirmation', async () => {
        vi.mocked(Modal.confirm).mockImplementationOnce(async () => { await home.switchAccount('a', 'account-b'); return true; });
        const view = await open();
        await vi.waitFor(() => expect(view.findByTestId('settings-account-history-restore-3')).not.toBeNull());
        await view.pressByTestIdAsync('settings-account-history-restore-3');
        await vi.waitFor(() => expect(storage.getState().settingsScope?.accountId).toBe('account-b'));
        expect(home.requests.some(row => row.path === '/v2/account/settings/history/3')).toBe(false);
    });

    it('keeps saved versions behind the existing disclosure', async () => {
        const view = await open(false);
        await vi.waitFor(() => expect(view.getTextContent()).toContain('1 snapshot'));
        expect(view.findByTestId('settings-account-history-restore-3')).toBeNull();
    });
});
