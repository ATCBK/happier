import 'fake-indexeddb/auto';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ATMOSPHERE_PICTURES } from '@happier-dev/brand/atmosphere';
import { renderScreen } from '@/dev/testkit';
import { Modal } from '@/modal';
import { t } from '@/text';
import { pictureStore } from '../pictureStore';
import { PicturePicker } from './PicturePicker';

vi.mock('@/components/atmosphere/pictureStore', async () => import('../pictureStore.web'));
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

describe('picture credit and remove interactions', () => {
    beforeEach(() => vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 }))));
    afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

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

    it('admits one remove confirmation at a time and preserves bytes on cancellation', async () => {
        const localId = 'picker-remove-contract';
        await pictureStore.put({ localId, kind: 'user', data: new Blob(['pixels'], { type: 'image/webp' }) });
        let settle!: (confirmed: boolean) => void;
        const confirm = vi.spyOn(Modal, 'confirm').mockImplementation(() => new Promise<boolean>(resolve => { settle = resolve; }));
        const screen = await renderScreen(<PicturePicker pictures={[]} selected={{ kind: 'user', localId }} onSelect={() => {}} />);
        await vi.waitFor(async () => { await act(async () => {}); expect(screen.findByTestId('atmosphere-picture-remove')).not.toBeNull(); });
        const button = screen.findByTestId('atmosphere-picture-remove')!;
        expect(button.props.accessibilityLabel).toBe(t('settingsAppearance.glassControls.atmospherePictureRemove'));
        await act(async () => { button.props.onPress(); button.props.onPress(); });
        expect(confirm).toHaveBeenCalledTimes(1);
        await act(async () => { settle(false); });
        expect(await pictureStore.get(localId)).toBeDefined();
        confirm.mockResolvedValue(true);
        await act(async () => {
            screen.findByTestId('atmosphere-picture-remove')!.props.onPress();
            await vi.waitFor(async () => expect(await pictureStore.get(localId)).toBeUndefined());
        });
        await screen.unmount();
    });
});
