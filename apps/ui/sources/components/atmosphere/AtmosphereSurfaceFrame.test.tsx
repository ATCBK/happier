import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { View } from 'react-native';
import { DEFAULT_HOME_ATMOSPHERE } from '@happier-dev/protocol/account/settings/accountSettings';
import { flattenTestStyle, renderScreen } from '@/dev/testkit';
import Color from 'color';
import { glassPresetMaterials } from '@/components/ui/glass/glassMaterial';
import { GlassRuntimeEnvironmentProvider } from '@/components/ui/glass/glassRuntimeEnvironment';
import { storage } from '@/sync/domains/state/storageStore';
import { AtmosphereSurfaceFrame } from './AtmosphereSurfaceFrame';
import { useAtmosphereBandBoundary } from './atmosphereBandBoundary';
import { atmosphereStageStore } from './atmosphereStage';
import { AtmosphereDissolve } from './AtmosphereDissolve';
import { NewSessionComposerCard } from '@/components/sessions/new/components/NewSessionComposerCard';
import { createNewSessionPromptStore } from '@/components/sessions/new/hooks/screenModel/newSessionPromptStore';
import type { NewSessionSimplePanelProps } from '@/components/sessions/new/components/NewSessionSimplePanel';
import { NewSessionSimplePanel } from '@/components/sessions/new/components/NewSessionSimplePanel';
import { setReducedMotionPreferenceOverride } from '@/hooks/ui/useReducedMotionPreference';

vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'android' });
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

function Composer(props: { sending: boolean }) {
    const boundary = useAtmosphereBandBoundary();
    return <View testID="composer" ref={boundary?.ref} onLayout={boundary?.onLayout}>
        <SessionComposer sending={props.sending} onCreate={async () => {}} />
    </View>;
}

function SessionComposer(props: { sending: boolean; onCreate: () => Promise<void>; panel?: boolean }) {
    const promptStore = React.useMemo(() => createNewSessionPromptStore('First line\nSecond line\nThird line'), []);
    const panelProps = {
        // Native refs begin unmounted; this fixture never measures the unused popover boundary.
        popoverBoundaryRef: React.useRef<View>(null) as NewSessionSimplePanelProps['popoverBoundaryRef'],
        headerHeight: 0, safeAreaTop: 0, safeAreaBottom: 0,
        newSessionTopPadding: 0, newSessionSidePadding: 0, newSessionBottomPadding: 0, containerStyle: {},
        promptStore, setSessionPrompt: promptStore.setPrompt,
        handleCreateSession: props.onCreate, canCreate: true, isCreating: props.sending,
        emptyAutocompleteKinds: [], emptyAutocompleteSuggestions: async () => [],
        agentType: 'codex', handleAgentClick: undefined, permissionMode: 'default',
        handlePermissionModeChange: undefined, modelMode: 'default', setModelMode: undefined,
        modelOptions: [], connectionStatus: undefined, machineName: undefined, selectedPath: '/repo',
        useProfiles: false, selectedProfileId: null,
        showResumePicker: false, resumeSessionId: null, isResumeSupportChecking: false,
    } satisfies NewSessionSimplePanelProps;
    return props.panel ? <NewSessionSimplePanel {...panelProps} />
        : <NewSessionComposerCard panelProps={panelProps} layout="screen" attachments={false} />;
}

describe('New Session atmosphere at the real stage and focus boundary', () => {
    let previous: ReturnType<typeof storage.getState>;
    beforeEach(() => {
        previous = storage.getState();
        storage.setState(state => ({ ...state, settings: { ...state.settings, homeAtmosphere: {
            ...DEFAULT_HOME_ATMOSPHERE, planet: { ...DEFAULT_HOME_ATMOSPHERE.planet, digits: false },
        } } }));
    });
    afterEach(() => { storage.setState(previous, true); atmosphereStageStore.setSending(false); setReducedMotionPreferenceOverride(null); });

    it.each(['screen', 'modal'] as const)('uses Elements in the %s New composer instead of the content or menu material', async (mode) => {
        storage.setState(state => ({ ...state, settings: { ...state.settings,
            newSessionPresentationModeV1: mode,
            glassBlurEnabled: true,
            glassSurfaceMaterials: { ...glassPresetMaterials('clear'),
                content: { blur: 'off', opacity: 1 }, card: { blur: 'off', opacity: 0.347 }, floating: { blur: 'off', opacity: 0.02 },
            },
        } }));
        const scene = (reduceTransparency: boolean) => <GlassRuntimeEnvironmentProvider value={{ atmosphereBehind: 'wallpaper', reduceTransparency }}>
            <SessionComposer sending={false} onCreate={async () => {}} panel />
        </GlassRuntimeEnvironmentProvider>;
        const screen = await renderScreen(scene(false));
        const alpha = () => Color(flattenTestStyle(screen.findByTestId('agent-input-material-surface')!.props.style).backgroundColor as string).alpha();
        try {
            expect(alpha()).toBe(0.347);
            await screen.update(scene(true));
            expect(alpha()).toBe(1);
        } finally {
            await screen.unmount();
        }
    });

    it('dissolves the default Planet on the shared send signal and respects the send switch', async () => {
        let screen: Awaited<ReturnType<typeof renderScreen>>;
        const surface = (sending: boolean): React.ReactElement => <AtmosphereSurfaceFrame surface="new-session" focused visible>
            <SessionComposer sending={sending} onCreate={async () => screen.update(surface(true))} />
        </AtmosphereSurfaceFrame>;
        screen = await renderScreen(surface(false), { createNodeMock: element => ({
            measureInWindow: (done: (x: number, y: number, width: number, height: number) => void) =>
                done(0, element.props.testID === 'composer' ? 200 : 0, 800, element.props.testID === 'composer' ? 180 : 600),
        }) });
        expect(screen.findByType(AtmosphereDissolve).props.visible).toBe(true);
        await screen.pressByTestIdAsync('new-session-composer-send');
        expect(screen.findByType(AtmosphereDissolve).props.visible).toBe(false);
        expect(screen.findByType(AtmosphereDissolve).props.leave).toBe('climb');
        await screen.update(surface(false));
        await act(async () => storage.setState(state => ({ ...state, settings: { ...state.settings,
            homeAtmosphere: { ...state.settings.homeAtmosphere, moments: { ...state.settings.homeAtmosphere.moments, send: false } },
        } })));
        await screen.update(surface(true));
        expect(screen.findByType(AtmosphereDissolve).props.visible).toBe(true);
        await screen.update(surface(false));
        await act(async () => {
            setReducedMotionPreferenceOverride(true);
            storage.setState(state => ({ ...state, settings: { ...state.settings,
                homeAtmosphere: { ...state.settings.homeAtmosphere, moments: { ...state.settings.homeAtmosphere.moments, send: true } },
            } }));
        });
        await screen.pressByTestIdAsync('new-session-composer-send');
        expect(screen.findByType(AtmosphereDissolve).props.visible).toBe(false);
        expect(screen.findByType(AtmosphereDissolve).props.reducedMotion).toBe(true);
        await screen.unmount();
    });

    it('holds the native band and focus through draft shrink and growth until blur or viewport resize', async () => {
        let composerHeight = 180;
        let paneHeight = 600;
        const screen = await renderScreen(<AtmosphereSurfaceFrame surface="new-session" focused visible>
            <Composer sending={false} />
        </AtmosphereSurfaceFrame>, { createNodeMock: element => ({
            measureInWindow: (done: (x: number, y: number, width: number, height: number) => void) =>
                done(0, element.props.testID === 'composer' ? 200 : 0, 800, element.props.testID === 'composer' ? composerHeight : paneHeight),
        }) });
        const initial = atmosphereStageStore.get().stage!.geometry!;
        expect(initial.band).toBe(380);
        await act(async () => screen.findByTestId('new-session-composer-input')!.props.onFocus());
        const remeasure = async () => act(async () => screen.findByTestId('composer')!.props.onLayout());
        composerHeight = 70;
        await remeasure();
        expect(atmosphereStageStore.get().stage!.geometry!.band).toBe(initial.band);
        expect(atmosphereStageStore.get().stage!.geometry!.focus).toEqual(initial.focus);
        composerHeight = 240;
        await remeasure();
        expect(atmosphereStageStore.get().stage!.geometry!.band).toBe(initial.band);
        expect(atmosphereStageStore.get().stage!.geometry!.focus).toEqual(initial.focus);
        paneHeight = 500;
        await remeasure();
        expect(atmosphereStageStore.get().stage!.geometry!.band).toBe(440);
        composerHeight = 90;
        await remeasure();
        expect(atmosphereStageStore.get().stage!.geometry!.band).toBe(440);
        await act(async () => screen.findByTestId('new-session-composer-input')!.props.onBlur());
        expect(atmosphereStageStore.get().stage!.geometry!.band).toBe(290);
        await screen.unmount();
    });
});
