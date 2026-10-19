import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flattenTestStyle, renderScreen, standardCleanup } from '@/dev/testkit';
import { SurfaceCard } from './SurfaceCard';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { WidgetFrame } from '@/components/widgets/frame/WidgetFrame';
import { GlassMaterialSettingsProvider } from '@/components/ui/glass/useGlassMaterialSettings';
import { GlassRuntimeEnvironmentProvider } from '@/components/ui/glass/glassRuntimeEnvironment';
import { glassPresetMaterials } from '@/components/ui/glass/glassMaterial';
import { GlassSurface } from '@/components/ui/glass/GlassSurface';

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
afterEach(standardCleanup);

function scene(children: React.ReactNode, atmosphereBehind: 'wallpaper' | 'none') {
    return <GlassMaterialSettingsProvider value={{ glassSurfaceMaterials: glassPresetMaterials('auto') }}>
        <GlassRuntimeEnvironmentProvider value={{ atmosphereBehind }}>
            <GlassSurface surfaceGroup="content" finishRole={null}>{children}</GlassSurface>
        </GlassRuntimeEnvironmentProvider>
    </GlassMaterialSettingsProvider>;
}

describe('in-flow Elements material', () => {
    it.each([
        ['Home card', <SurfaceCard testID="card">Home content</SurfaceCard>],
        ['settings sheet', <ListPresentationProvider value="page"><ItemGroup title="Preferences">Settings content</ItemGroup></ListPresentationProvider>],
        ['grouped sheet', <ItemGroup title="Drafts">Draft content</ItemGroup>],
        ['widget frame', <WidgetFrame testID="widget" title="Notes" frameStyle="card" placement="home" body={{ kind: 'content', children: 'Widget content' }} />],
    ])('gives the %s one material only when the backing is visible', async (_name, content) => {
        const screen = await renderScreen(scene(content, 'wallpaper'));
        const backdrop = () => screen.findAll(node => typeof node.type === 'string'
            && typeof flattenTestStyle(node.props.style)?.backdropFilter === 'string'
            && flattenTestStyle(node.props.style).backdropFilter !== 'none');
        expect(backdrop()).toHaveLength(1);
        // The card coat: the CSS material variable, or a concrete mix when the fixed point raised Subtle's hair.
        expect(String(flattenTestStyle(backdrop()[0]!.props.style).backgroundColor)).toMatch(/--happier-glass-card-background-color|^color-mix\(/);
        await screen.update(scene(content, 'none'));
        expect(backdrop()).toHaveLength(0);
    });
    it('inherits one coat and finish when a Home card contains another card', async () => {
        const screen = await renderScreen(scene(<SurfaceCard><SurfaceCard>Retained nested content</SurfaceCard></SurfaceCard>, 'wallpaper'));
        expect(screen.findAll(node => typeof node.type === 'string'
            && typeof flattenTestStyle(node.props.style)?.backdropFilter === 'string'
            && flattenTestStyle(node.props.style).backdropFilter !== 'none')).toHaveLength(1);
        expect(screen.findAll(node => typeof node.type === 'string'
            && typeof flattenTestStyle(node.props.style)?.backgroundImage === 'string')).toHaveLength(1);
        expect(screen.getTextContent()).toContain('Retained nested content');
    });
});
