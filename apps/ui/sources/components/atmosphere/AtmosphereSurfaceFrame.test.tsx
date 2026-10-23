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
import { PlanetCanvas } from './PlanetCanvas';
import { NewSessionComposerCard } from '@/components/sessions/new/components/NewSessionComposerCard';
import { createNewSessionPromptStore } from '@/components/sessions/new/hooks/screenModel/newSessionPromptStore';
import type { NewSessionSimplePanelProps } from '@/components/sessions/new/components/NewSessionSimplePanel';
import { NewSessionSimplePanel } from '@/components/sessions/new/components/NewSessionSimplePanel';
import { setReducedMotionPreferenceOverride } from '@/hooks/ui/useReducedMotionPreference';
import { DestinationInstanceContext } from '@/components/appShell/workspace/destinationInstanceContext';

const planetPaints = vi.hoisted(() => ({ count: 0, font: {} }));
vi.mock('@shopify/react-native-skia', async () => ({
    ...(await import('@/dev/testkit/mocks/reactNativeSkia')).createReactNativeSkiaMock(),
    // Native picture allocation is the physical drawing boundary.
    useFont: () => planetPaints.font,
    createPicture: () => { planetPaints.count++; return { dispose() {} }; },
}));

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

function SessionComposer(props: { sending: boolean; onCreate: () => Promise<void>; panel?: boolean; topContent?: React.ReactNode }) {
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
        composerTopContent: props.topContent,
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

    it('does no planet or band work for a retained inactive destination and resumes when presented', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
        let timerFires = 0;
        const interval = globalThis.setInterval;
        vi.spyOn(globalThis, 'setInterval').mockImplementation((callback, delay, ...args) =>
            interval(() => { timerFires++; callback(...args); }, delay));
        let mounts = 0;
        function Draft() {
            React.useEffect(() => { mounts++; }, []);
            return <View testID="retained-draft" />;
        }
        const scene = (visible: boolean, focused = visible) => <DestinationInstanceContext.Provider value={{
            tabId: 'retained-project', ref: { kind: 'home', params: {} }, pathname: '/', visible, focused,
        }}>
            <AtmosphereSurfaceFrame surface={{ project: { serverId: 'srv', projectKey: 'p1' } }}>
                <Draft />
            </AtmosphereSurfaceFrame>
        </DestinationInstanceContext.Provider>;
        const screen = await renderScreen(scene(true), { createNodeMock: () => ({
            measureInWindow: (done: (x: number, y: number, width: number, height: number) => void) => done(0, 0, 390, 844),
        }) });
        try {
            expect(planetPaints.count).toBeGreaterThan(0);
            expect(atmosphereStageStore.get().panes).toHaveLength(1);
            await screen.update(scene(false));
            const hiddenPaints = planetPaints.count;
            await act(async () => {
                storage.setState(state => ({ ...state, settings: { ...state.settings, homeAtmosphere: {
                    ...state.settings.homeAtmosphere, planet: { ...state.settings.homeAtmosphere.planet, style: 'rich' },
                } } }));
                vi.advanceTimersByTime(300_000);
            });
            expect.soft(planetPaints.count - hiddenPaints).toBe(0);
            expect.soft(screen.findAllByType(PlanetCanvas)).toHaveLength(0);
            expect(atmosphereStageStore.get().panes).toHaveLength(0);
            expect(timerFires).toBe(0);
            expect(vi.getTimerCount()).toBe(0);
            // A visible split pane still paints without keyboard focus.
            await screen.update(scene(true, false));
            expect(planetPaints.count).toBeGreaterThan(hiddenPaints);
            expect(screen.findAllByType(PlanetCanvas)).toHaveLength(1);
            expect(atmosphereStageStore.get().panes).toHaveLength(1);
            expect(mounts).toBe(1);
        } finally {
            await screen.unmount();
            vi.restoreAllMocks();
            vi.useRealTimers();
        }
    });

    it('lays the Project band over the page column, not over the whole pane group that holds it', async () => {
        function Scene() {
            const column = React.useRef<View>(null);
            return <AtmosphereSurfaceFrame surface={{ project: { serverId: 'srv', projectKey: 'p1' } }} column={column}>
                <View testID="project-column" ref={column} />
            </AtmosphereSurfaceFrame>;
        }
        const screen = await renderScreen(<Scene />, { createNodeMock: (element: { props: { testID?: string } }) => ({
            measureInWindow: (done: (x: number, y: number, width: number, height: number) => void) =>
                element.props.testID === 'project-column' ? done(700, 40, 400, 850) : done(300, 40, 800, 850),
        }) });
        try {
            expect(atmosphereStageStore.get().panes[0]?.geometry?.rect).toEqual({ x: 700, y: 40, width: 400, height: 850 });
        } finally {
            await screen.unmount();
        }
    });

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

    it.each(['corner', 'rise', 'side'] as const)('keeps a Project\'s %s planet inside its band, ending at the tabs', async (placement) => {
        // R-7: the Project band ends below the Project tabs; the page under them keeps its ground.
        storage.setState(state => ({ ...state, settings: { ...state.settings, homeAtmosphere: {
            ...state.settings.homeAtmosphere, planet: { ...state.settings.homeAtmosphere.planet, placement },
        } } }));
        const screen = await renderScreen(<AtmosphereSurfaceFrame surface={{ project: { serverId: 'srv', projectKey: 'p1' } }} focused visible>
            <Composer sending={false} />
        </AtmosphereSurfaceFrame>, { createNodeMock: element => ({
            measureInWindow: (done: (x: number, y: number, width: number, height: number) => void) =>
                element.props.testID === 'composer' ? done(0, 40, 900, 50) : done(0, 0, 900, 800),
        }) });
        try {
            const canvas = screen.findByType(PlanetCanvas);
            const fade = canvas.props.fade as { from: number; to: number } | undefined;
            expect(fade?.to).toBe(90);
            expect(fade!.from).toBeLessThan(90);
            const { cy, R } = canvas.props.options as { cy: number; R: number };
            // Corner and Rise show their disc inside the band; Side keeps its pane geometry (only its halo reaches up).
            if (placement !== 'side') expect(cy - R).toBeLessThan(90);
        } finally {
            await screen.unmount();
        }
    });

    it('ends the band and seats the hero at the composer itself, never at content stacked above it', async () => {
        // A New bot draft stacks its title, instructions and status above the composer; the planet's
        // limb and the band follow the input, so that copy stays on the page ground (DA R-1).
        const screen = await renderScreen(<AtmosphereSurfaceFrame surface="new-session" focused visible>
            <SessionComposer sending={false} onCreate={async () => {}} topContent={<View testID="draft-header" />} />
        </AtmosphereSurfaceFrame>, { createNodeMock: element => ({
            measureInWindow: (done: (x: number, y: number, width: number, height: number) => void) =>
                element.props.testID === 'new-session-composer-band' ? done(0, 300, 800, 120) : done(0, 0, 800, 600),
        }) });
        try {
            const geometry = atmosphereStageStore.get().stage!.geometry!;
            expect(geometry.band).toBe(420);
            expect(geometry.focus.y).toBe(360);
            const band = screen.findByTestId('new-session-composer-band')!;
            expect(band.findAll(node => node.props.testID === 'draft-header')).toHaveLength(0);
            expect(band.findAll(node => node.props.testID === 'new-session-composer-input').length).toBeGreaterThan(0);
        } finally {
            await screen.unmount();
        }
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
