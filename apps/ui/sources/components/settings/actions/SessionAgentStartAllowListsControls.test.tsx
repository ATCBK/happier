import * as React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
import { act } from 'react-test-renderer';
import { standardCleanup } from '@/dev/testkit';
import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { useSetting } from '@/sync/domains/state/storage';
import { createSecretSettingsTestHarness, type SecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { settingsParse } from '@/sync/domains/settings/settings';
import { applyAcpCatalogSnapshot, resetAcpCatalogSnapshotsForTests } from '@/sync/store/settings/acpCatalogSnapshot';
import { resetAcpCatalogEngineForTests } from '@/sync/engine/settings/acpCatalogEngine';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { SessionAgentStartAllowListsControls } from './SessionAgentStartAllowListsControls';

// Native rendering is a boundary; catalog hooks, stores, selectors and menu policy stay real.
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeNativeMock({ platformOS: 'ios' }));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: key => key }));
installDisconnectedServerSocketBoundary();
beforeAll(loadSyncSingletonForTests);
let account: SecretSettingsTestHarness;
beforeEach(async () => {
    account = await createSecretSettingsTestHarness({ settings: settingsParse({
        actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] } },
    }) });
});
afterEach(async () => {
    await standardCleanup();
    await account.dispose();
    resetAcpCatalogEngineForTests();
    resetAcpCatalogSnapshotsForTests();
});

describe('session start Agent allow-list catalog readiness', () => {
    it('does not expand All into an incomplete finite Agent policy when a bundled choice is toggled while ACP is unavailable', async () => {
        // The real observer refreshes on demand; the HTTP row must remain unavailable too.
        account.catalogRows.set('/v1/account/entity-rows/acp', { status: 'account-mode-mismatch' });
        applyAcpCatalogSnapshot(account.scope, { status: 'unavailable', reason: 'account-mode-mismatch' }, true);
        function PolicyOwner() {
            const lists = useSetting('sessionAgentStartAllowListsV1');
            return <SessionAgentStartAllowListsControls rawAllowLists={lists} />;
        }
        const screen = await renderSettingsView(<PolicyOwner />);
        await screen.pressByTestIdAsync('settings-actions:session-start-allow-lists:agents');
        const menu = () => screen.findAll(node => node.type === DropdownMenu)[0];
        expect(menu()).toBeDefined();
        expect(menu().props.items).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'all', checked: true }),
            expect.objectContaining({ id: 'none' }),
        ]));
        expect(menu().props.items.find((item: { id: string }) => item.id === 'all').disabled).not.toBe(true);
        expect(menu().props.items.find((item: { id: string }) => item.id === 'none').disabled).not.toBe(true);
        const bundledChoice = menu().props.items.find((item: { id: string }) => item.id.startsWith('choice:agent:'));
        expect(bundledChoice).toBeDefined();
        expect(bundledChoice.disabled).toBe(true);
        await act(async () => { menu().props.onSelect(bundledChoice.id); });
        // null means every Agent, including configured IDs that have not been read.
        // A partial list of rendered choices cannot author that finite replacement.
        expect(account.settingsWrites).toHaveLength(0);
        await act(async () => { menu().props.onSelect('none'); });
        await vi.waitFor(() => expect(account.persistedSettings.sessionAgentStartAllowListsV1.allowedAgentTargetKeys).toEqual([]));
        await act(async () => { menu().props.onSelect('all'); });
        await vi.waitFor(() => expect(account.persistedSettings.sessionAgentStartAllowListsV1.allowedAgentTargetKeys).toBeNull());
        await act(async () => { screen.tree.unmount(); });

        const retained = 'backend:retained:configured:retained';
        account.replaceSettings(settingsParse({ ...account.persistedSettings,
            sessionAgentStartAllowListsV1: { v: 1, allowedAgentTargetKeys: [retained] },
        }));
        const finite = await renderSettingsView(<PolicyOwner />);
        await finite.pressByTestIdAsync('settings-actions:session-start-allow-lists:agents');
        const finiteMenu = () => finite.findAll(node => node.type === DropdownMenu)[0];
        expect(finiteMenu().props.items).toContainEqual(expect.objectContaining({ id: `choice:${retained}`, checked: true }));
        expect(finiteMenu().props.items.find((item: { id: string }) => item.id === bundledChoice.id).disabled).not.toBe(true);
        await act(async () => { finiteMenu().props.onSelect(bundledChoice.id); });
        await vi.waitFor(() => expect(account.persistedSettings.sessionAgentStartAllowListsV1.allowedAgentTargetKeys)
            .toEqual([retained, bundledChoice.id.slice('choice:'.length)]));
        await act(async () => { finiteMenu().props.onSelect(bundledChoice.id); });
        await vi.waitFor(() => expect(account.persistedSettings.sessionAgentStartAllowListsV1.allowedAgentTargetKeys).toEqual([retained]));
        await act(async () => { applyAcpCatalogSnapshot(account.scope, { status: 'ready', revision: 2, record: { v: 1, definitions: [] } }, true); });
        await act(async () => { finiteMenu().props.onSelect('all'); });
        await vi.waitFor(() => expect(account.persistedSettings.sessionAgentStartAllowListsV1.allowedAgentTargetKeys).toBeNull());
        await act(async () => { finiteMenu().props.onSelect(bundledChoice.id); });
        await vi.waitFor(() => expect(account.persistedSettings.sessionAgentStartAllowListsV1.allowedAgentTargetKeys).toEqual(expect.any(Array)));
        const knownFinite = account.persistedSettings.sessionAgentStartAllowListsV1.allowedAgentTargetKeys;
        expect(knownFinite).not.toContain(bundledChoice.id.slice('choice:'.length));
    });
});
