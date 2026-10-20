import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ReactTestInstance } from 'react-test-renderer';

import { renderScreen } from '@/dev/testkit';
import { t } from '@/text';

const nativeFocus = vi.hoisted(() => ({
    input: {},
    focusedInput: null as object | null,
    blurTextInput: vi.fn(),
    focusTextInput: vi.fn(),
    setAccessibilityFocus: vi.fn(),
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: (props: any) => React.createElement('View', props, props.children),
        TextInput: {
            State: {
                currentlyFocusedInput: () => nativeFocus.focusedInput,
                blurTextInput: nativeFocus.blurTextInput,
                focusTextInput: nativeFocus.focusTextInput,
            },
        },
        AccessibilityInfo: {
            setAccessibilityFocus: nativeFocus.setAccessibilityFocus,
        },
    });
});

// Cold compilation belongs to collection, outside the per-test interaction timeout.
await import('./PluginSurfaceInteractionBoundary.native');

describe('PluginSurfaceInteractionBoundary.native', () => {
    it('shows owner-proven content on a cold offline mount while keeping it inaccessible', async () => {
        const { PluginSurfaceInteractionBoundary } = await import('./PluginSurfaceInteractionBoundary.native');
        const screen = await renderScreen(
            <PluginSurfaceInteractionBoundary surfaceId="cold-content" snapshotTitle="Saved content" enabled={false} hasContent>
                <PluginNativeSnapshot testID="saved-content" />
            </PluginSurfaceInteractionBoundary>,
        );
        expect(screen.findByTestId('saved-content')).toBeTruthy();
        expect(screen.findByTestId('plugin-surface-snapshot:cold-content')?.props).toMatchObject({ pointerEvents: 'none', accessibilityElementsHidden: true });
        expect(screen.findByTestId('plugin-surface-offline-state:cold-content')).toBeNull();
    });
    it('omits the loaded runtime marker until a current native runtime identity is present', async () => {
        const { PluginSurfaceInteractionBoundary } = await import('./PluginSurfaceInteractionBoundary.native');
        const markerA = loadedRuntimeMarkerId('surface-native-load-lifecycle', 'acme.panels', 'occurrence-a');
        const screen = await renderScreen(
            <PluginSurfaceInteractionBoundary
                surfaceId="surface-native-load-lifecycle"
                snapshotTitle="Build summary"
                enabled
            >
                <PluginNativeSnapshot testID="plugin-native-load-lifecycle-snapshot" />
            </PluginSurfaceInteractionBoundary>,
        );

        expect(screen.findByTestId(markerA)).toBeNull();

        await screen.update(
            <PluginSurfaceInteractionBoundary
                surfaceId="surface-native-load-lifecycle"
                snapshotTitle="Build summary"
                enabled
                loadedRuntimeIdentity={{
                    pluginId: 'acme.panels',
                    occurrenceId: 'occurrence-a',
                    artifactDigest: 'sha256-runtime',
                    machineId: 'machine-a',
                    serverId: 'server-1',
                }}
            >
                <PluginNativeSnapshot testID="plugin-native-load-lifecycle-snapshot" />
            </PluginSurfaceInteractionBoundary>,
        );

        expect(screen.findByTestId(markerA)).toBeTruthy();
    });

    it('replaces the loaded runtime marker when a newer native runtime identity loads', async () => {
        const { PluginSurfaceInteractionBoundary } = await import('./PluginSurfaceInteractionBoundary.native');
        const markerA = loadedRuntimeMarkerId('surface-native-replacement', 'acme.panels', 'occurrence-a');
        const markerB = loadedRuntimeMarkerId('surface-native-replacement', 'acme.panels', 'occurrence-b');
        const element = (occurrenceId: string) => (
            <PluginSurfaceInteractionBoundary
                surfaceId="surface-native-replacement"
                snapshotTitle="Build summary"
                enabled
                loadedRuntimeIdentity={{
                    pluginId: 'acme.panels',
                    occurrenceId,
                    artifactDigest: 'sha256-runtime',
                    machineId: 'machine-a',
                    serverId: 'server-1',
                }}
            >
                <PluginNativeSnapshot testID="plugin-native-replacement-snapshot" />
            </PluginSurfaceInteractionBoundary>
        );
        const screen = await renderScreen(element('occurrence-a'));

        expect(screen.findByTestId(markerA)).toBeTruthy();
        expect(screen.findByTestId(markerB)).toBeNull();

        await screen.update(element('occurrence-b'));
        expect(screen.findByTestId(markerA)).toBeNull();
        expect(screen.findByTestId(markerB)).toBeTruthy();
    });

    it('omits the loaded runtime marker for retained stale or failed native snapshots', async () => {
        const { PluginSurfaceInteractionBoundary } = await import('./PluginSurfaceInteractionBoundary.native');
        const markerA = loadedRuntimeMarkerId('surface-native-stale', 'acme.panels', 'occurrence-a');
        const stale = (enabled: boolean) => (
            <PluginSurfaceInteractionBoundary
                surfaceId="surface-native-stale"
                snapshotTitle="Build summary"
                enabled={enabled}
            >
                <PluginNativeSnapshot testID="plugin-native-stale-snapshot" />
            </PluginSurfaceInteractionBoundary>
        );
        // A retained snapshot exists only once the surface was live.
        const screen = await renderScreen(stale(true));
        await screen.update(stale(false));

        expect(screen.findByTestId('plugin-native-stale-snapshot')).toBeTruthy();
        expect(screen.findByTestId(markerA)).toBeNull();
    });

    it('carries loaded runtime identity as a non-accessible diagnostic marker', async () => {
        const { PluginSurfaceInteractionBoundary } = await import('./PluginSurfaceInteractionBoundary.native');
        const screen = await renderScreen(
            <PluginSurfaceInteractionBoundary
                surfaceId="surface-native-loaded-runtime"
                snapshotTitle="Build summary"
                enabled
                loadedRuntimeIdentity={{
                    pluginId: 'acme.panels',
                    occurrenceId: 'occurrence-7',
                    artifactDigest: 'sha256-runtime',
                    machineId: 'machine-a',
                    serverId: 'server-1',
                }}
            >
                <PluginNativeSnapshot testID="plugin-native-loaded-runtime-snapshot" />
            </PluginSurfaceInteractionBoundary>,
        );

        expect(screen.findByTestId('plugin-surface-interaction-boundary:surface-native-loaded-runtime')?.props.dataSet)
            .toBeUndefined();
        expect(screen.findByTestId([
            'plugin-surface-interaction-boundary',
            'surface-native-loaded-runtime',
            'surface-native-loaded-runtime',
            'acme.panels',
            'occurrence-7',
            'sha256-runtime',
            'machine-a',
            'server-1',
        ].map((part) => encodeURIComponent(part)).join(':'))?.props).toMatchObject({
            accessible: false,
            pointerEvents: 'none',
            accessibilityElementsHidden: true,
            importantForAccessibility: 'no-hide-descendants',
        });
        expect(screen.findByTestId('plugin-surface-snapshot:surface-native-loaded-runtime')).toBeTruthy();
    });

    it('keeps an enabled but presentation-ineligible snapshot inert without an offline announcement', async () => {
        const { PluginSurfaceInteractionBoundary } = await import('./PluginSurfaceInteractionBoundary.native');
        const screen = await renderScreen(
            <PluginSurfaceInteractionBoundary
                surfaceId="surface-native-presentation-ineligible"
                snapshotTitle="Build summary"
                enabled
                focusEligible={false}
            >
                <PluginNativeSnapshot testID="plugin-native-presentation-ineligible-snapshot" />
            </PluginSurfaceInteractionBoundary>,
        );

        expect(screen.findByTestId('plugin-native-presentation-ineligible-snapshot')).toBeTruthy();
        expect(screen.findByTestId('plugin-surface-snapshot:surface-native-presentation-ineligible')?.props)
            .toMatchObject({
                pointerEvents: 'none',
                accessibilityElementsHidden: true,
                importantForAccessibility: 'no-hide-descendants',
            });
        expect(screen.findByTestId('plugin-surface-offline-summary:surface-native-presentation-ineligible')).toBeNull();
    });

    it('keeps the snapshot mounted while native input and accessibility descendants are disabled', async () => {
        const { PluginSurfaceInteractionBoundary } = await import('./PluginSurfaceInteractionBoundary.native');
        const element = (enabled: boolean) => (
            <PluginSurfaceInteractionBoundary
                surfaceId="surface-native"
                snapshotTitle="Build summary"
                enabled={enabled}
            >
                <PluginNativeSnapshot testID="plugin-native-snapshot" />
            </PluginSurfaceInteractionBoundary>
        );
        const screen = await renderScreen(element(true));
        await screen.update(element(false));

        expect(screen.findByTestId('plugin-native-snapshot')).toBeTruthy();
        expect(hasInaccessibleAncestor(screen.findByTestId('plugin-native-snapshot')!)).toBe(true);
        expect(screen.findByTestId('plugin-surface-offline-summary:surface-native-freshness-text')).toBeTruthy();
        expect(screen.findByTestId('plugin-surface-snapshot:surface-native')?.props).toMatchObject({
            pointerEvents: 'none',
            accessibilityElementsHidden: true,
            importantForAccessibility: 'no-hide-descendants',
        });
        expect(screen.findByTestId('plugin-surface-offline-summary:surface-native')?.props).toMatchObject({
            accessible: true,
            accessibilityRole: 'summary',
            accessibilityLiveRegion: 'polite',
        });
        expect(
            screen.findByTestId('plugin-surface-offline-summary:surface-native')?.props.accessibilityLabel,
        ).toContain('Build summary');

        await screen.update(element(true));
        expect(screen.findByTestId('plugin-native-snapshot')).toBeTruthy();
        expect(screen.findByTestId('plugin-surface-snapshot:surface-native')?.props).toMatchObject({
            pointerEvents: 'auto',
            accessibilityElementsHidden: false,
            importantForAccessibility: 'auto',
        });
        expect(screen.findByTestId('plugin-surface-offline-summary:surface-native')).toBeNull();
    });

    it('blurs a captured native input offline and restores it only after re-enable', async () => {
        const { PluginSurfaceInteractionBoundary } = await import('./PluginSurfaceInteractionBoundary.native');
        const element = (enabled: boolean) => (
            <PluginSurfaceInteractionBoundary
                surfaceId="surface-native-focus"
                snapshotTitle="Build summary"
                enabled={enabled}
            >
                <PluginNativeSnapshot testID="plugin-native-focus-snapshot" />
            </PluginSurfaceInteractionBoundary>
        );
        nativeFocus.focusedInput = nativeFocus.input;
        const screen = await renderScreen(element(true));
        screen.findByTestId('plugin-surface-snapshot:surface-native-focus')?.props.onFocusCapture({
            nativeEvent: { target: 42 },
        });

        await screen.update(element(false));
        expect(nativeFocus.blurTextInput).toHaveBeenCalledWith(nativeFocus.input);
        expect(nativeFocus.focusTextInput).not.toHaveBeenCalled();

        await screen.update(element(true));
        expect(nativeFocus.focusTextInput).toHaveBeenCalledWith(nativeFocus.input);
        expect(nativeFocus.setAccessibilityFocus).not.toHaveBeenCalled();
        expect(screen.findByTestId('plugin-native-focus-snapshot')).toBeTruthy();
    });

    it('blurs a captured native input when presentation eligibility falls without restoring it when eligibility returns', async () => {
        const { PluginSurfaceInteractionBoundary } = await import('./PluginSurfaceInteractionBoundary.native');
        const element = (focusEligible: boolean) => (
            <PluginSurfaceInteractionBoundary
                surfaceId="surface-native-presentation-focus"
                snapshotTitle="Build summary"
                enabled
                focusEligible={focusEligible}
            >
                <PluginNativeSnapshot testID="plugin-native-presentation-focus-snapshot" />
            </PluginSurfaceInteractionBoundary>
        );
        nativeFocus.blurTextInput.mockClear();
        nativeFocus.focusTextInput.mockClear();
        nativeFocus.setAccessibilityFocus.mockClear();
        nativeFocus.focusedInput = nativeFocus.input;
        const screen = await renderScreen(element(true));
        screen.findByTestId('plugin-surface-snapshot:surface-native-presentation-focus')?.props.onFocusCapture({
            nativeEvent: { target: 42 },
        });

        await screen.update(element(false));
        expect(nativeFocus.blurTextInput).toHaveBeenCalledWith(nativeFocus.input);
        expect(nativeFocus.focusTextInput).not.toHaveBeenCalled();

        await screen.update(element(true));
        expect(nativeFocus.focusTextInput).not.toHaveBeenCalled();
        expect(nativeFocus.setAccessibilityFocus).not.toHaveBeenCalled();
    });

    it('does not restore an offline return target while the retained surface remains presentation-ineligible', async () => {
        const { PluginSurfaceInteractionBoundary } = await import('./PluginSurfaceInteractionBoundary.native');
        const element = (enabled: boolean, focusEligible: boolean) => (
            <PluginSurfaceInteractionBoundary
                surfaceId="surface-native-presentation-return"
                snapshotTitle="Build summary"
                enabled={enabled}
                focusEligible={focusEligible}
            >
                <PluginNativeSnapshot testID="plugin-native-presentation-return-snapshot" />
            </PluginSurfaceInteractionBoundary>
        );
        nativeFocus.blurTextInput.mockClear();
        nativeFocus.focusTextInput.mockClear();
        nativeFocus.setAccessibilityFocus.mockClear();
        nativeFocus.focusedInput = nativeFocus.input;
        const screen = await renderScreen(element(true, true));
        screen.findByTestId('plugin-surface-snapshot:surface-native-presentation-return')?.props.onFocusCapture({
            nativeEvent: { target: 42 },
        });

        await screen.update(element(false, true));
        expect(nativeFocus.blurTextInput).toHaveBeenCalledWith(nativeFocus.input);

        await screen.update(element(true, false));
        expect(nativeFocus.focusTextInput).not.toHaveBeenCalled();
        expect(nativeFocus.setAccessibilityFocus).not.toHaveBeenCalled();

        await screen.update(element(true, true));
        expect(nativeFocus.focusTextInput).not.toHaveBeenCalled();
        expect(nativeFocus.setAccessibilityFocus).not.toHaveBeenCalled();
    });

    it.each([null, 'unavailable', 'required', 'connecting'] as const)('keeps cold host identity and the %s explanation accessible', async (cause) => {
        const { PluginSurfaceInteractionBoundary } = await import('./PluginSurfaceInteractionBoundary.native');
        const { PluginSurfacePageHeaderContext, PluginSurfaceSourceCauseContext } = await import('./pluginSurfaceInteractionAvailability');
        const screen = await renderScreen(
            <PluginSurfaceSourceCauseContext.Provider value={cause}>
                <PluginSurfacePageHeaderContext.Provider value={{ header: <PluginNativeSnapshot testID="host-page-identity" />, loadingFrame: 'column' }}>
                    <PluginSurfaceInteractionBoundary surfaceId="surface-native-empty" snapshotTitle="PRs & Issues" enabled={false}>
                        <PluginNativeSnapshot testID="plugin-native-placeholder" />
                    </PluginSurfaceInteractionBoundary>
                </PluginSurfacePageHeaderContext.Provider>
            </PluginSurfaceSourceCauseContext.Provider>,
        );
        expect(screen.findByTestId('plugin-native-placeholder')).toBeNull();
        const state = screen.findByTestId('plugin-surface-offline-state:surface-native-empty');
        const identity = screen.findByTestId('host-page-identity');
        expect(state).toBeTruthy();
        expect(identity).toBeTruthy();
        expect(hasInaccessibleAncestor(state!)).toBe(false);
        expect(hasInaccessibleAncestor(identity!)).toBe(false);
        expect(screen.findByTestId('plugin-surface-offline-summary:surface-native-empty')).toBeNull();
    });

    it('states a missing source instead of an offline machine when the mount reports that cause', async () => {
        const { PluginSurfaceInteractionBoundary } = await import('./PluginSurfaceInteractionBoundary.native');
        const { PluginSurfaceSourceCauseContext } = await import('./pluginSurfaceInteractionAvailability');
        const screen = await renderScreen(
            <PluginSurfaceSourceCauseContext.Provider value="unavailable">
                <PluginSurfaceInteractionBoundary surfaceId="surface-native-source" snapshotTitle="PRs & Issues" enabled={false}>
                    <PluginNativeSnapshot testID="plugin-native-placeholder" />
                </PluginSurfaceInteractionBoundary>
            </PluginSurfaceSourceCauseContext.Provider>,
        );
        expect(screen.getTextContent()).toContain(t('pluginSurfaces.state.sourceUnavailable.title'));
        expect(screen.getTextContent()).not.toContain(t('pluginSurfaces.state.offline.titleNothingLoaded'));
    });
});

function hasInaccessibleAncestor(node: ReactTestInstance): boolean {
    for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
        if (ancestor.props.accessibilityElementsHidden === true
            || ancestor.props.importantForAccessibility === 'no-hide-descendants') return true;
    }
    return false;
}

function loadedRuntimeMarkerId(surfaceId: string, pluginId: string, occurrenceId: string): string {
    return [
        'plugin-surface-interaction-boundary',
        'surface-native-loaded-runtime',
        surfaceId,
        pluginId,
        occurrenceId,
        'sha256-runtime',
        'machine-a',
        'server-1',
    ].map((part) => encodeURIComponent(part)).join(':');
}

function PluginNativeSnapshot(props: Readonly<{ testID: string }>): React.ReactElement {
    return React.createElement('PluginNativeSnapshot', props);
}
