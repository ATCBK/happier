import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { useDestinationFocus, useDestinationInstanceKey, useDestinationVisibility } from '@/components/appShell/workspace/DestinationInstanceHost';
import { useDeviceType } from '@/utils/platform/responsive';
import { GlassSurface } from '@/components/ui/glass/GlassSurface';
import { useSetting } from '@/sync/store/hooks';
import { HomePlanet } from './HomePlanet';
import { LookChip } from './look/LookChip';
import { useAtmosphere } from './useAtmosphere';
import { useAtmosphereStage, useAtmospherePictureShown, useAtmosphereSending, type AtmosphereRect, type AtmosphereStageGeometry } from './atmosphereStage';
import type { AtmosphereSurface } from './resolveAtmosphere';
import type { AtmosphereEditor } from './look/atmosphereEditor';
import { projectAtmosphereBand } from './atmosphereGeometry';
import { AtmosphereBandBoundary } from './atmosphereBandBoundary';

function measure(node: View | null): Promise<AtmosphereRect | null> {
    return new Promise(resolve => node ? node.measureInWindow((x, y, width, height) => resolve({ x, y, width, height })) : resolve(null));
}

/** Surface geometry and controls only: the shell remains the sole picture renderer. */
export function AtmosphereSurfaceFrame(props: Readonly<{
    surface: AtmosphereSurface;
    enabled?: boolean;
    focused?: boolean;
    visible?: boolean;
    session?: boolean;
    editor?: AtmosphereEditor;
    /** False when the surface seats Look itself (the floating New Session composer's status row). */
    showLook?: boolean;
    children: React.ReactNode;
}>) {
    const destinationFocus = useDestinationFocus();
    const destinationVisible = useDestinationVisibility();
    const destinationKey = useDestinationInstanceKey();
    const { theme } = useUnistyles();
    const phone = useDeviceType() === 'phone';
    const atmosphere = useAtmosphere(props.surface);
    const homeAtmosphere = useSetting('homeAtmosphere');
    const behindSessions = homeAtmosphere.behindSessions;
    const sending = useAtmosphereSending() && homeAtmosphere.moments.send !== false;
    const pictureShown = useAtmospherePictureShown();
    const enabled = props.enabled !== false;
    const focused = props.focused ?? destinationFocus;
    // Workspace panes expose visibility separately from focus; an ordinary Expo route does not.
    const visible = enabled && (props.visible ?? (destinationKey !== null ? destinationVisible : focused));
    const paneRef = React.useRef<View>(null);
    const bandRef = React.useRef<View>(null);
    const [geometry, setGeometry] = React.useState<AtmosphereStageGeometry | null>(null);
    const request = React.useRef(0);
    const writing = React.useRef(false);
    const onLayout = React.useCallback(() => {
        const id = ++request.current;
        void Promise.all([measure(paneRef.current), measure(bandRef.current)]).then(([pane, tabs]) => {
            if (!pane || id !== request.current) return;
            const band = tabs ? projectAtmosphereBand({ pane, tabs }) : 0;
            setGeometry(previous => previous && writing.current && previous.rect.width === pane.width
                && previous.rect.height === pane.height
                ? { ...previous, rect: pane }
                : { rect: pane, band, horizonAt: 0.86,
                    focus: { x: pane.width / 2, y: tabs ? tabs.y + tabs.height / 2 - pane.y : pane.height / 2 } });
        });
    }, [props.session]);
    React.useEffect(() => { onLayout(); return () => { request.current++; }; }, [onLayout, visible]);
    // Every visible pane contributes its rectangle, including opaque transcripts. Only an atmosphere
    // surface (or the session opt-in) may select the scene; toggling the coat does not recrop its neighbors.
    useAtmosphereStage(visible ? props.surface : null, geometry, focused && !props.session, !props.session || behindSessions);
    const onFocusChange = React.useCallback((focused: boolean) => { writing.current = focused; if (!focused) onLayout(); }, [onLayout]);
    const boundary = React.useMemo(() => ({ ref: bandRef, onLayout, onFocusChange }), [onLayout, onFocusChange]);
    const target = typeof props.surface === 'object' && props.editor
        ? { surface: props.surface, editor: props.editor }
        : { surface: 'new-session' as const };
    return <View ref={paneRef} onLayout={onLayout} style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
        <GlassSurface plane surfaceGroup="content" finishRole={null}
            atmosphereCoat={props.session ? behindSessions && pictureShown ? 'reading' : 'opaque' : undefined}
            style={{ flex: 1, minWidth: 0, minHeight: 0 }} testID={props.session ? 'session-atmosphere-coat' : 'atmosphere-surface'}>
            {enabled && !props.session && geometry && atmosphere.source === 'planet' ? <HomePlanet
                pane={{ width: geometry.rect.width, height: geometry.rect.height }} placement={atmosphere.planet.placement}
                style={atmosphere.planet.style} digits={atmosphere.planet.digits} theme={theme.dark ? 'dark' : 'light'} phone={phone}
                hero={geometry.band > 0 ? { composerTop: 2 * geometry.focus.y - geometry.band, aboveBottom: geometry.band, nextTop: null } : null}
                band={typeof props.surface === 'object' && geometry.band > 0 ? geometry.band : undefined}
                hidden={!visible || sending} leave={sending ? 'climb' : 'fade'} reducedMotion={atmosphere.reducedMotion} /> : null}
            <AtmosphereBandBoundary.Provider value={enabled ? boundary : null}>{props.children}</AtmosphereBandBoundary.Provider>
            {enabled && !props.session && props.showLook !== false && typeof props.surface === 'string' ? <View style={{ position: 'absolute', right: 16, top: 14 }}>
                <LookChip target={target} testID="new-session-look" />
            </View> : null}
        </GlassSurface>
    </View>;
}
