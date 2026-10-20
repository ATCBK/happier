import 'fake-indexeddb/auto';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ATMOSPHERE_PICTURES } from '@happier-dev/brand/atmosphere';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { Modal } from '@/modal';
import { t } from '@/text';
import { pictureStore } from '../pictureStore';
import { PicturePicker } from './PicturePicker';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { settingsParse } from '@/sync/domains/settings/settings';

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async importOriginal => {
    const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
    const { createFrontDoorActionExecuteForVitest } = await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary');
    return { ...original, createFrontDoorActionExecute: createFrontDoorActionExecuteForVitest(original) };
});
installDisconnectedServerSocketBoundary();

vi.mock('@/components/atmosphere/pictureStore', async () => import('../pictureStore.web'));
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

describe('picture credit and remove interactions', () => {
    beforeEach(() => vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 }))));
    afterEach(() => { standardCleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

    it('exposes a named, keyboard-focusable credit link through the interaction owner', async () => {
        const picture = ATMOSPHERE_PICTURES[0];
        const screen = await renderScreen(<PicturePicker pictures={[picture]} selected={{ kind: 'builtin', id: picture.id }} onSelect={() => {}} />);
        const link = screen.findByTestId('atmosphere-picture-credit');
        expect(link?.props.accessibilityRole).toBe('link');
        expect(link?.props.accessibilityLabel).toContain(picture.title);
        expect(link?.props.onFocus).toBeTypeOf('function');
        expect(link?.props.onBlur).toBeTypeOf('function');
        await screen.unmount();
    });

    it('admits picture removal through Actions and honors a waiver without a second confirmation', async () => {
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({ actionsSettingsV1: {
            v: 1, actions: { 'settings.invoke': { disabledSurfaces: ['ui'] } },
        } }) });
        const localId = 'picker-remove-contract';
        await pictureStore.put({ localId, kind: 'user', data: new Blob(['pixels'], { type: 'image/webp' }) });
        const confirm = vi.spyOn(Modal, 'confirm').mockResolvedValue(false);
        try {
            const screen = await renderScreen(<PicturePicker pictures={[]} selected={{ kind: 'user', localId }} onSelect={() => {}} />);
            await vi.waitFor(async () => { await act(async () => {}); expect(screen.findByTestId('atmosphere-picture-remove')).not.toBeNull(); });
            const button = screen.findByTestId('atmosphere-picture-remove')!;
            expect(button.props.accessibilityLabel).toBe(t('settingsAppearance.glassControls.atmospherePictureRemove'));
            await act(async () => { await button.props.onPress(); });
            expect(confirm).not.toHaveBeenCalled();
            expect(await pictureStore.get(localId)).toBeDefined();
            await act(async () => { account.replaceSettings(settingsParse({ ...account.persistedSettings,
                actionsSettingsV1: { v: 1 },
            })); });
            await act(async () => { await screen.findByTestId('atmosphere-picture-remove')!.props.onPress(); });
            expect(confirm).toHaveBeenCalledTimes(1);
            expect(await pictureStore.get(localId)).toBeDefined();
            await act(async () => { account.replaceSettings(settingsParse({ ...account.persistedSettings, actionsSettingsV1: {
                v: 1, approvalWaivedSurfaces: { 'settings.invoke': ['ui'] },
            } })); });
            await act(async () => {
                await screen.findByTestId('atmosphere-picture-remove')!.props.onPress();
                await vi.waitFor(async () => expect(await pictureStore.get(localId)).toBeUndefined());
            });
            expect(confirm).toHaveBeenCalledTimes(1);
            await screen.unmount();
        } finally { await account.dispose(); }
    });
});
