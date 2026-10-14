import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installPanelCommonModuleMocks } from '@/components/ui/panels/panelTestHelpers';
import DevRouteLayout from './_layout';
import { NavigationTitleChromeProvider, PageHeader } from '@/components/ui/layout/PageHeader';

installPanelCommonModuleMocks();
const sdkScene = vi.hoisted(() => ({ body: null as import('react').ReactNode, segments: ['(app)', 'dev', 'artifacts'] }));
vi.mock('expo-router', async () => {
    const module = (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
        pathname: '/dev/artifacts', segments: ['(app)', 'dev', 'artifacts'],
    }).module;
    // Expo mounts the selected scene beneath the layout; the actual PageHeader
    // and chrome context below this SDK boundary stay real.
    const React = await import('react');
    return { ...module, useSegments: () => sdkScene.segments, Stack: Object.assign((props: { children?: React.ReactNode }) =>
        React.createElement('DevNavigator', props, props.children, sdkScene.body), { Screen: module.Stack.Screen }) };
});
afterEach(() => { sdkScene.body = null; sdkScene.segments = ['(app)', 'dev', 'artifacts']; });

describe('development phone chrome', () => {
    it('preserves the desktop shell decision that title chrome is absent', async () => {
        vi.stubGlobal('__DEV__', true);
        sdkScene.segments = ['(app)', 'dev', 'typography'];
        sdkScene.body = <PageHeader title="Typography specimen" />;
        const screen = await renderScreen(<NavigationTitleChromeProvider showsTitle={false}><DevRouteLayout /></NavigationTitleChromeProvider>);
        expect(screen.getTextContent()).toContain('Typography specimen');
    });
    it('keeps page actions visible beneath the inherited root title context when the dev header is hidden', async () => {
        vi.stubGlobal('__DEV__', true);
        sdkScene.body = <PageHeader title="Artifacts" alwaysShowTitle
            primaryAction={{ title: 'Create', onPress: () => {}, testID: 'dev-artifact-create' }} />;
        const screen = await renderScreen(<NavigationTitleChromeProvider showsTitle><DevRouteLayout /></NavigationTitleChromeProvider>);
        expect(screen.findByTestId('dev-artifact-create')).not.toBeNull();
    });
    it('leaves the changes specimen chrome with its own rendered content', async () => {
        vi.stubGlobal('__DEV__', true);
        const screen = await renderScreen(<DevRouteLayout />);
        const declaration = screen.root.findAllByType('StackScreen').find(node => node.props.name === 'changes');
        expect(declaration?.props.options?.headerShown).toBe(false);
    });
    it('uses the production Artifacts header policy for its specimen', async () => {
        vi.stubGlobal('__DEV__', true);
        const screen = await renderScreen(<DevRouteLayout />);
        const declaration = screen.root.findAllByType('StackScreen').find(node => node.props.name === 'artifacts');
        expect(declaration?.props.options?.headerShown).toBe(false);
    });
});
