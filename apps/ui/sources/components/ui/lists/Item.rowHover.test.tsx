import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { Text } from 'react-native';

import { renderScreen } from '@/dev/testkit';
import { installUiListsCommonModuleMocks } from './uiListsTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installUiListsCommonModuleMocks();

vi.mock('@/components/ui/rendering/normalizeNodeForView', () => ({
    normalizeNodeForView: (node: unknown) => node,
}));
vi.mock('@/components/ui/lists/ItemGroup', () => ({ ItemGroupSelectionContext: React.createContext(null) }));
vi.mock('@/components/ui/lists/ItemGroupRowPosition', () => ({ useItemGroupRowPosition: () => null }));
vi.mock('@/components/ui/lists/itemGroupRowCorners', () => ({ getItemGroupRowCornerRadii: () => null }));

describe('Item row hover', () => {
    it('tells its accessory whether the pointer is over the row', async () => {
        const { Item } = await import('./Item');
        const { useItemRowHovered } = await import('./ItemRowHover');
        function Accessory() {
            return <Text testID="accessory">{useItemRowHovered() ? 'hovered' : 'idle'}</Text>;
        }
        const screen = await renderScreen(
            <Item testID="row" title="Model" onPress={() => {}} rightElement={<Accessory />} />,
        );
        expect((screen.findByTestId('accessory') as any).props.children).toBe('idle');
        await act(async () => { (screen.findByTestId('row') as any).props.onHoverIn(); });
        expect((screen.findByTestId('accessory') as any).props.children).toBe('hovered');
        await act(async () => { (screen.findByTestId('row') as any).props.onHoverOut(); });
        expect((screen.findByTestId('accessory') as any).props.children).toBe('idle');
    });

    it('keeps the row engaged while the pointer moves from the row onto its outside accessory', async () => {
        // A row's own menu sits beside the row's press target; reaching for it must not hide it.
        const { Item } = await import('./Item');
        const { useItemRowHovered } = await import('./ItemRowHover');
        function Accessory() {
            return <Text testID="accessory">{useItemRowHovered() ? 'hovered' : 'idle'}</Text>;
        }
        const screen = await renderScreen(
            <Item testID="row" title="Project" onPress={() => {}} rightElementOutsidePressable rightElement={<Accessory />} />,
        );
        const accessorySection = () => screen.root.findAll((node: any) => typeof node.props?.onPointerEnter === 'function'
            && node.findAll((child: any) => child.props?.testID === 'accessory').length > 0)[0];
        await act(async () => { (screen.findByTestId('row') as any).props.onHoverIn(); });
        await act(async () => {
            (screen.findByTestId('row') as any).props.onHoverOut();
            accessorySection()!.props.onPointerEnter();
        });
        expect((screen.findByTestId('accessory') as any).props.children).toBe('hovered');
        await act(async () => { accessorySection()!.props.onPointerLeave(); });
        expect((screen.findByTestId('accessory') as any).props.children).toBe('idle');
    });
});
