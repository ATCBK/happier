import * as React from 'react';
import { useHappierMaterialColorResolver } from '@happier-dev/plugin-ui/presentation';
import { Dimensions, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import { useUnistyles } from 'react-native-unistyles';

import { useOptionalModal } from '@/modal';
import { useIsInsideModalBoundary } from '@/modal/context/ModalBoundaryContext';
import { useReportSessionCockpitComposerChromeHeight } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import { ComposerKeyboardProvider } from './ComposerKeyboardContext';
import type { ComposerKeyboardScaffoldProps } from './ComposerKeyboardScaffoldTypes';
import { useComposerKeyboardLayout } from './useComposerKeyboardLayout.web';

function normalizeScaffoldHeight(height: number): number | undefined {
    if (!Number.isFinite(height) || height <= 0) return undefined;
    return Math.round(height);
}

function flattenStyleItems(style: StyleProp<ViewStyle>): Array<StyleProp<ViewStyle>> {
    if (Array.isArray(style)) {
        return style.flatMap((item) => flattenStyleItems(item as StyleProp<ViewStyle>));
    }
    return style ? [style] : [];
}

export function ComposerKeyboardScaffold(props: ComposerKeyboardScaffoldProps): React.ReactElement {
    const { theme } = useUnistyles();
    const materialColor = useHappierMaterialColorResolver('content');
    const [availablePanelMaxHeight, setAvailablePanelMaxHeight] = React.useState<number | undefined>(undefined);
    const modal = useOptionalModal();
    const isInsideModalBoundary = useIsInsideModalBoundary();
    const modalKeyboardLiftSuppressed = modal?.isKeyboardLiftSuppressedByModal === true;
    const keyboardLiftSuppressed = props.keyboardLiftSuppressed === true
        || (!isInsideModalBoundary && modalKeyboardLiftSuppressed);
    const layout = useComposerKeyboardLayout({
        availablePanelMaxHeight,
        headerHeight: props.headerHeight,
        keyboardLiftSuppressed,
        layoutBottomInset: props.layoutBottomInset,
        safeAreaBottom: props.safeAreaBottom,
    });
    // A worklet captures only what it reads: the whole `props` carries React elements, which the
    // web mapper walks as inputs and overflows on.
    const safeAreaBottom = props.safeAreaBottom ?? 0;
    // The composer floats above the bottom chrome, so it is an obstacle for app-shell overlays that
    // sit outside the session screen (the Voice orb). Publish it there; a modal-hosted composer is
    // already covered by its modal and stays out of the shell's obstacle set.
    const reportComposerChromeHeight = useReportSessionCockpitComposerChromeHeight(!isInsideModalBoundary);
    // Window-space overlays also need where the band starts: on desktop the workspace frame lifts
    // it off the window edge. Measured at rest — the keyboard lift is the keyboard owner's fact.
    const composerRef = React.useRef<View | null>(null);
    const composerHeightRef = React.useRef<number | null>(null);
    const publishComposerBand = React.useCallback(() => {
        const height = composerHeightRef.current;
        if (height === null) return;
        const node = composerRef.current;
        if (!node || typeof node.measureInWindow !== 'function') {
            reportComposerChromeHeight(height);
            return;
        }
        node.measureInWindow((_x, y, width, measuredHeight) => {
            if (composerHeightRef.current !== height) return;
            // A composer in a display:none screen measures 0×0 at the window origin: it is not on
            // screen, so it is no obstacle. Publishing its "top" (the whole window) would lift every
            // shell overlay placed above composers onto the title strip.
            if (!(width > 0 && measuredHeight > 0)) {
                reportComposerChromeHeight(null);
                return;
            }
            const lift = Math.max(0, layout.bottomInset.value - safeAreaBottom);
            const top = Dimensions.get('window').height - y - lift;
            reportComposerChromeHeight(height, Number.isFinite(top) ? top : 0);
        });
    }, [layout, reportComposerChromeHeight, safeAreaBottom]);
    const handleScaffoldLayout = React.useCallback((event: LayoutChangeEvent) => {
        const nextHeight = normalizeScaffoldHeight(event.nativeEvent.layout.height);
        setAvailablePanelMaxHeight((current) => (current === nextHeight ? current : nextHeight));
        // A window resize moves the band without resizing it.
        publishComposerBand();
    }, [publishComposerBand]);
    const handleComposerLayout = React.useCallback((event: LayoutChangeEvent) => {
        layout.setComposerMeasuredHeight(event.nativeEvent.layout.height);
        composerHeightRef.current = event.nativeEvent.layout.height;
        publishComposerBand();
    }, [layout, publishComposerBand]);
    const liftPaddingStyle = useAnimatedStyle(() => ({
        paddingBottom: Math.max(0, layout.bottomInset.value - safeAreaBottom),
    }));

    const { style: contentPropsStyle, ...contentProps } = props.contentProps ?? {};
    // Same contract as the native scaffold: a transparent scaffold paints no ground of its own and
    // lets the caller supply a `backdrop` sibling instead. The prop is declared on the shared type,
    // so honouring it on both implementations keeps it from becoming a native-only promise.
    const surfaceBackgroundColor = props.surface === 'transparent' ? undefined : materialColor(theme.colors.surface.base, 'transparent');

    return (
        <ComposerKeyboardProvider layout={layout}>
            <Animated.View
                accessibilityLabel={props.accessibilityLabel}
                accessibilityRole={props.accessibilityRole}
                testID={props.testID}
                onLayout={handleScaffoldLayout}
                style={[
                    { flexBasis: 0, flexGrow: 1, minHeight: 0, minWidth: 0, backgroundColor: surfaceBackgroundColor },
                    liftPaddingStyle,
                    ...flattenStyleItems(props.style),
                ]}
            >
                {/* Sibling of the content, never a wrapper — see the native scaffold. */}
                    <View
                    {...contentProps}
                    testID={props.contentTestID}
                    style={[{ flexBasis: 0, flexGrow: 1, minHeight: 0, minWidth: 0 }, contentPropsStyle, props.contentStyle]}
                >
                    {props.children}
                </View>
                <View
                    ref={composerRef}
                    testID={props.composerTestID}
                    onLayout={handleComposerLayout}
                    style={{ backgroundColor: surfaceBackgroundColor }}
                >
                    {props.composer}
                </View>
            </Animated.View>
        </ComposerKeyboardProvider>
    );
}
