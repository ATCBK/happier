import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen } from '@/dev/testkit';
import { RightSidebarActionRail } from './RightSidebarActionRail';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { storage } from '@/sync/domains/state/storage';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const initialStorageState = storage.getState();
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);

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

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => `en:${key}` });
});

await import('@/components/ui/navigation/NavigationPlacementCustomizer');

describe('RightSidebarActionRail', () => {
    beforeEach(() => storage.setState(initialStorageState, true));
    afterEach(() => storage.setState(initialStorageState, true));

    it('uses shared ordering and placements, overflowing only after the measured rail no longer fits', async () => {
        storage.getState().applyLocalSettings({ navigationSurfacePlacementsV1: { sessionRail: {
            orderedIds: ['plugin:acme.review:panel', 'git', 'files', 'hidden'],
            placements: { hidden: 'hidden', files: 'overflow' },
        } } }, { persist: false });
        const screen = await renderScreen(<RightSidebarActionRail surfaceId="sessionRail" testIDPrefix="rail" actions={[
            ...['git', 'files', 'hidden', 'plugin:acme.review:panel'].map((id) => ({
                id, label: id, icon: 'folder' as const, active: false, onPress: () => {},
            })),
        ]} />);
        const menu = screen.tree.findByType(DropdownMenu);
        expect(menu.props.items.map((item: { id: string }) => item.id)).toEqual(['files', 'customize']);
        const measure = async (height: number) => {
            await act(async () => { screen.findByTestId('right-sidebar-action-rail')!.props.onLayout({ nativeEvent: { layout: { height } } }); });
        };
        await measure(200);
        expect(screen.findByTestId('rail:plugin:acme.review:panel')).toBeTruthy();
        expect(screen.findByTestId('rail:git')).toBeTruthy();
        expect(screen.findByTestId('rail:files')).toBeNull();
        expect(screen.findByTestId('rail:hidden')).toBeNull();
        await measure(88);
        expect(screen.findByTestId('rail:plugin:acme.review:panel')).toBeTruthy();
        expect(screen.findByTestId('rail:git')).toBeNull();
        expect(screen.findByTestId('rail:more')).toBeTruthy();
        expect(screen.tree.findByType(DropdownMenu).props.items.map((item: { id: string }) => item.id)).toEqual(['git', 'files', 'customize']);
    });

    it('keeps every pinned action visible when the measured height fits them without a More slot', async () => {
        const screen = await renderScreen(<RightSidebarActionRail surfaceId="workspaceRail" testIDPrefix="rail" actions={
            ['one', 'two', 'three'].map((id) => ({ id, label: id, icon: 'folder' as const, active: false, onPress: () => {} }))
        } />);
        await act(async () => { screen.findByTestId('right-sidebar-action-rail')!.props.onLayout({ nativeEvent: { layout: { height: 128 } } }); });
        expect(screen.findByTestId('rail:three')).toBeTruthy();
        expect(screen.findByTestId('rail:more')).toBeNull();
    });

    it('offers long-press and context customization after every action is hidden, retaining those actions in its catalog', async () => {
        storage.getState().applyLocalSettings({ navigationSurfacePlacementsV1: { sessionRail: { orderedIds: [], placements: { git: 'hidden' } } } }, { persist: false });
        const { Modal } = await import('@/modal');
        const screen = await renderScreen(<RightSidebarActionRail surfaceId="sessionRail" testIDPrefix="rail" actions={[
            { id: 'git', label: 'Git', icon: 'folder', active: false, onPress: () => {} },
        ]} />);
        expect(screen.findByTestId('rail:git')).toBeNull();
        expect(screen.findByTestId('rail:more')).toBeTruthy();
        await act(async () => { await screen.findByTestId('rail:more')!.props.onLongPress(); });
        expect(Modal.show).toHaveBeenCalledWith(expect.objectContaining({ props: expect.objectContaining({
            surfaceId: 'sessionRail', items: [expect.objectContaining({ id: 'git' })],
        }) }));
        vi.mocked(Modal.show).mockClear();
        const preventDefault = vi.fn();
        await act(async () => { screen.findByTestId('right-sidebar-action-rail')!.props.onContextMenu({ preventDefault }); });
        expect(preventDefault).toHaveBeenCalled();
        expect(Modal.show).toHaveBeenCalledWith(expect.objectContaining({ props: expect.objectContaining({ surfaceId: 'sessionRail' }) }));
    });
    it('separates the code, session and machine groups with one hairline each, keeping the given order', async () => {
        const action = (id: string, group: string) => ({
            id, group, label: id, icon: 'folder' as const, active: false, onPress: () => {},
        });
        const screen = await renderScreen(
            <RightSidebarActionRail
                surfaceId="sessionRail"
                testIDPrefix="rail"
                actions={[
                    action('git', 'code'), action('review', 'code'), action('files', 'code'),
                    action('agents', 'session'), action('navigation', 'session'),
                    action('services', 'machine'), action('terminal', 'machine'),
                ]}
            />,
        );

        const order = screen.findAll((node) => typeof node.type === 'string'
            && typeof node.props.testID === 'string'
            && /^rail:(git|review|files|agents|navigation|services|terminal|separator:\w+)$/.test(node.props.testID))
            .map((node) => node.props.testID as string)
            .filter((id, index, all) => all.indexOf(id) === index);
        expect(order).toEqual([
            'rail:git', 'rail:review', 'rail:files',
            'rail:separator:session',
            'rail:agents', 'rail:navigation',
            'rail:separator:machine',
            'rail:services', 'rail:terminal',
        ]);
    });
});
