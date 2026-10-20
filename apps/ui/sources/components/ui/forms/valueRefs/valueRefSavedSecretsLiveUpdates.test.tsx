import 'fake-indexeddb/auto';
import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { resetSavedSecretCatalogEngineForTests, refreshSavedSecretCatalog } from '@/sync/engine/settings/savedSecretCatalogEngine';
import { resetSavedSecretCatalogSnapshotsForTests } from '@/sync/store/settings/savedSecretCatalogSnapshot';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { settingsParse } from '@/sync/domains/settings/settings';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const modalShowSpy = vi.hoisted(() => vi.fn());
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();
await vi.hoisted(async () => {
    const { installValueRefsCommonModuleMocks } = await import('./valueRefsTestHelpers');
    installValueRefsCommonModuleMocks({
        storage: importOriginal => importOriginal(),
        modal: async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
            spies: { show: modalShowSpy },
        }).module,
    });
});

// Load the real store, catalog and Action graph after the network/platform boundaries.
const { ValueRefEditorModal } = await import('./ValueRefEditorModal');
const { SavedSecretPickerModal } = await import('./SavedSecretPickerModal');
let home: Awaited<ReturnType<typeof createSecretSettingsTestHarness>> | undefined;

function namedRow(screen: Awaited<ReturnType<typeof renderScreen>>, testID: string) {
    return screen.findAllByTestId(testID).find(node => typeof node.props.title === 'string');
}

beforeEach(async () => {
    resetSavedSecretCatalogEngineForTests();
    resetSavedSecretCatalogSnapshotsForTests();
    modalShowSpy.mockClear();
    home = await createSecretSettingsTestHarness({ settings: settingsParse({ secrets: [] }) });
    await refreshSavedSecretCatalog(home.scope);
});
afterEach(async () => {
    await standardCleanup();
    resetSavedSecretCatalogEngineForTests();
    resetSavedSecretCatalogSnapshotsForTests();
    await home?.dispose();
    home = undefined;
});

describe('value ref saved secrets live updates', () => {
    it('preserves a template header reference when saving without changing its value', async () => {
        const onSubmit = vi.fn(() => true);
        const initialValueRef = {
            t: 'template', template: 'Bearer {api_key}',
            vars: { api_key: { t: 'savedSecret', secretId: 'personal-key' } },
        } as const;
        const screen = await renderScreen(React.createElement(ValueRefEditorModal, {
            onClose: vi.fn(), kind: 'header', initialKey: 'Authorization',
            initialValueRef, secrets: [], onSubmit, scope: home!.scope,
        }));
        await screen.pressByTestIdAsync('mcp.valueRefEditor.save');
        expect(onSubmit).toHaveBeenCalledWith({ key: 'Authorization', valueRef: initialValueRef });
    });

    it('preserves an attested header reference when saving its existing editor value', async () => {
        const onSubmit = vi.fn(() => true);
        const initialValueRef = { t: 'sessionAttested', field: 'externalPrincipalId' } as const;
        const screen = await renderScreen(React.createElement(ValueRefEditorModal, {
            onClose: vi.fn(), kind: 'header', initialKey: 'X-Wilson-On-Behalf-Of',
            initialValueRef, secrets: [], onSubmit, scope: home!.scope,
        }));
        await screen.pressByTestIdAsync('mcp.valueRefEditor.save');
        expect(onSubmit).toHaveBeenCalledWith({ key: 'X-Wilson-On-Behalf-Of', valueRef: initialValueRef });
    });

    it('SavedSecretPickerModal reflects resources added after the modal opens on an Account change', async () => {
        const onSelectId = vi.fn();
        const screen = await renderScreen(React.createElement(SavedSecretPickerModal, {
            onClose: vi.fn(), selectedId: null, onSelectId, scope: home!.scope,
        }));
        expect(screen.findByTestId('saved-secret:empty')).not.toBeNull();
        const { entry } = await home!.addOwnerResource();
        await act(async () => { publishHomeAccountChange(home!.scope.serverId); });
        await vi.waitFor(() => expect(namedRow(screen, `saved-secret:${entry.ref}`)?.props.disabled).toBe(false));
        expect(screen.findByTestId('saved-secret:empty')).toBeNull();
        await screen.pressByTestIdAsync(`saved-secret:${entry.ref}`);
        expect(onSelectId).toHaveBeenCalledWith(entry.ref);
        expect(home!.settingsWrites).toEqual([]);
    });

    it('ValueRefEditorModal resolves saved-secret names from its live scoped catalog', async () => {
        const ref = 'happier:shared-secret:v1:resource-a';
        const screen = await renderScreen(React.createElement(ValueRefEditorModal, {
            onClose: vi.fn(), kind: 'header', initialKey: 'Authorization',
            initialValueRef: { t: 'savedSecret', secretId: ref }, secrets: [],
            onSubmit: () => true, scope: home!.scope,
        }));
        expect(namedRow(screen, 'mcp.valueRefEditor.secret')?.props.title).toBe('settings.mcpServersValueSecretSelect');
        expect(namedRow(screen, 'mcp.valueRefEditor.secret')?.props.subtitle).toBe(ref);
        const { entry } = await home!.addOwnerResource();
        await act(async () => { publishHomeAccountChange(home!.scope.serverId); });
        await vi.waitFor(() => expect(namedRow(screen, 'mcp.valueRefEditor.secret')?.props.title).toBe(entry.name));
        expect(namedRow(screen, 'mcp.valueRefEditor.secret')?.props.subtitle).toBe(ref);
        expect(home!.settingsWrites).toEqual([]);
    });

    it('ValueRefEditorModal opens the saved-secret picker with its captured scope and shared chrome', async () => {
        const screen = await renderScreen(React.createElement(ValueRefEditorModal, {
            onClose: vi.fn(), kind: 'header', initialKey: 'Authorization',
            initialValueRef: { t: 'literal', v: 'token' }, secrets: [],
            onSubmit: () => true, scope: home!.scope,
        }));
        const dropdown = screen.findAll(node => typeof node.props.onSelect === 'function'
            && node.props.items?.some((item: { id: string }) => item.id === 'savedSecret'))[0];
        if (!dropdown) throw new Error('Missing value source menu');
        await act(async () => { dropdown.props.onSelect('savedSecret'); });
        expect(modalShowSpy).toHaveBeenCalledTimes(1);
        expect(modalShowSpy.mock.calls[0]?.[0]).toMatchObject({
            component: SavedSecretPickerModal,
            props: { scope: home!.scope },
            chrome: { kind: 'card', title: 'settings.mcpServersPickSecretTitle', dimensions: { size: 'lg' } },
            closeOnBackdrop: true,
        });
    });

    it('clearing the picker disables save until another saved secret is selected', async () => {
        const onSubmit = vi.fn(() => true);
        const onClose = vi.fn();
        const screen = await renderScreen(React.createElement(ValueRefEditorModal, {
            onClose, kind: 'header', initialKey: 'Authorization',
            initialValueRef: { t: 'savedSecret', secretId: 'original-key' }, secrets: [],
            onSubmit, scope: home!.scope,
        }));
        await screen.pressByTestIdAsync('mcp.valueRefEditor.secret');
        const picker = modalShowSpy.mock.calls[0]?.[0];
        expect(picker.props.selectedId).toBe('original-key');
        await act(async () => { picker.props.onSelectId(null); });
        expect(namedRow(screen, 'mcp.valueRefEditor.save')?.props.disabled).toBe(true);
        expect(namedRow(screen, 'mcp.valueRefEditor.secret')?.props.subtitle).toBe('settings.mcpServersValueSecretSelectSubtitle');
        expect(onSubmit).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
        await act(async () => { picker.props.onSelectId('replacement-key'); });
        expect(namedRow(screen, 'mcp.valueRefEditor.save')?.props.disabled).toBe(false);
        await screen.pressByTestIdAsync('mcp.valueRefEditor.save');
        expect(onSubmit).toHaveBeenCalledWith({ key: 'Authorization', valueRef: { t: 'savedSecret', secretId: 'replacement-key' } });
        expect(onClose).toHaveBeenCalledOnce();
    });
});
