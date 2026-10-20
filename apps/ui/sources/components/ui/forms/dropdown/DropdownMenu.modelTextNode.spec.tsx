import * as React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { collectUnexpectedRawTextNodes, renderScreen, standardCleanup } from '@/dev/testkit';
import { withPopoverWebGlobals } from '@/dev/testkit/harness/popoverHarness';
import { installDropdownCommonModuleMocks } from './dropdownTestHelpers';

const installDropdownReactNativeMock = async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: 'View',
        Text: 'Text',
        TextInput: 'TextInput',
        Pressable: 'Pressable',
        ActivityIndicator: 'ActivityIndicator',
        Dimensions: {
            get: () => ({ width: 1280, height: 800, scale: 1, fontScale: 1 }),
        },
    });
};

const installDropdownModalMock = async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            alert: vi.fn(),
            prompt: vi.fn(async () => null),
        },
    }).module;
};

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.unmock('@/components/ui/icons/Icon');
// Exercise the vendor glyph fallback beneath the real Icon and row normalization.
vi.mock('phosphor-react-native/src/icons/ArrowClockwise', () => ({ ArrowClockwiseIcon: () => '.' }));
vi.mock('phosphor-react-native/src/icons/StackSimple', () => ({ StackSimpleIcon: () => '.' }));
vi.mock('phosphor-react-native/src/icons/PencilSimple', () => ({ PencilSimpleIcon: () => '.' }));

vi.mock('expo-clipboard', () => ({
    setStringAsync: vi.fn(async () => {}),
}));

installDropdownCommonModuleMocks({
    reactNative: installDropdownReactNativeMock,
    modal: installDropdownModalMock,
});

// This runtime-bearing icon adapter must load after the native/web boundary is installed.
const { renderDropdownItemIcon } = await import('@/components/settings/pickers/renderDropdownItemIcon');

describe('DropdownMenu model-style text node guard', () => {
    let restoreWebGlobals: (() => void) | undefined;
    let restoreIconFamily: (() => void) | undefined;
    beforeEach(async () => {
        restoreWebGlobals = withPopoverWebGlobals();
        const { getIconFamily, setIconFamily } = await import('@/components/ui/icons/iconFamily');
        const previous = getIconFamily();
        setIconFamily('phosphor');
        restoreIconFamily = () => setIconFamily(previous);
    });
    afterEach(() => {
        standardCleanup();
        restoreIconFamily?.();
        restoreWebGlobals?.();
    });
    it('does not emit raw period text nodes under non-Text parents when a model-id dropdown is open', async () => {
        const { DropdownMenu } = await import('./DropdownMenu');

        const items = [
            {
                id: '__refresh_models__',
                title: 'Refresh models',
                subtitle: 'Fetch the latest model list.',
                icon: renderDropdownItemIcon({ name: 'arrow-clockwise', color: '#999' }),
            },
            {
                id: 'default',
                title: 'Use CLI settings',
                icon: renderDropdownItemIcon({ name: 'stack-simple', color: '#999' }),
            },
            {
                id: '__custom__',
                title: 'Custom…',
                subtitle: 'Enter a model id',
                icon: renderDropdownItemIcon({ name: 'pencil-simple', color: '#999' }),
            },
        ];

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<DropdownMenu
                    open={true}
                    popoverAnchor={{ kind: 'rect', rect: { left: 10, top: 10, width: 320, height: 48 } }}
                    onOpenChange={() => {}}
                    items={items}
                    onSelect={() => {}}
                    search={true}
                    searchPlaceholder="Search models"
                    rowKind="item"
                    showCategoryTitles={false}
                    selectedId="gpt-5.3-codex-spark/medium"
                    itemTrigger={{
                        title: 'Voice agent chat model id',
                        subtitleFormatter: () => 'Used when the voice agent chat model source is set to Custom model.',
                        detailFormatter: () => 'gpt-5.3-codex-spark/medium',
                    }}
                />)).tree;

        // Inspect committed output: Icon's composite JSX child becomes a raw glyph only after rendering.
        expect(collectUnexpectedRawTextNodes(tree.toJSON(), []).filter((node) => node.value === '.'))
            .toContainEqual({ parent: 'Text', value: '.' });
        expect(collectUnexpectedRawTextNodes(tree.toJSON())).toEqual([]);
    });

});
