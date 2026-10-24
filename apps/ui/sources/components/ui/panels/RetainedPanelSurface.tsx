import * as React from 'react';
import { Platform, View, type ViewProps } from 'react-native';
import { Freeze } from 'react-freeze';
import { StyleSheet } from 'react-native-unistyles';

import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';

/**
 * `flow` fills the height its host gives it (a pane). `content` takes its own content's height, for a surface that sits
 * in a page's scroll with other blocks after it (a page's tab body and the block that closes it).
 */
type RetainedPanelSurfaceMode = 'absolute-overlay' | 'flow' | 'content';

const WebInertView = View as React.ComponentType<
    ViewProps & Pick<React.HTMLAttributes<HTMLElement>, 'inert'>
>;

export const RetainedPanelSurface = React.memo((props: Readonly<{
    isActive: boolean;
    testID?: string;
    mode?: RetainedPanelSurfaceMode;
    /** Opt in only for bodies proven safe to suspend, including their layout-effect lifetimes. */
    suspendWhenHidden?: boolean;
    /** Activity withdraws effects while preserving previously presented local state. */
    hiddenMode?: 'activity';
    children: React.ReactNode;
}>) => {
    const active = props.isActive;
    const [hasMounted, setHasMounted] = React.useState(active);
    const [frozen, setFrozen] = React.useState(!active);
    const mode = props.mode ?? 'flow';
    const isWeb = Platform.OS === 'web';

    React.useLayoutEffect(() => {
        if (active) {
            setHasMounted(true);
        }
    }, [active]);

    // Commit presentation=false once so demand/focus owners withdraw before suspending renders.
    // Freeze preserves passive effects but disconnects layout effects. Generic
    // retained content (including external plugin renderers) must stay connected.
    React.useEffect(() => {
        setFrozen(!active);
    }, [active]);

    if (!active && !hasMounted) {
        return null;
    }

    const content = (
        <PluginSurfaceFocusEligibilityProvider active={active}>
            <React.Activity mode={props.hiddenMode === 'activity' && !active ? 'hidden' : 'visible'}>
                <Freeze freeze={props.hiddenMode !== 'activity' && props.suspendWhenHidden === true && !active && frozen}>{props.children}</Freeze>
            </React.Activity>
        </PluginSurfaceFocusEligibilityProvider>
    );

    if (mode === 'absolute-overlay') {
        return (
            <WebInertView
                testID={props.testID}
                pointerEvents={active ? 'auto' : 'none'}
                inert={isWeb && !active ? true : undefined}
                aria-hidden={isWeb && !active ? true : undefined}
                accessibilityElementsHidden={isWeb ? undefined : !active}
                importantForAccessibility={isWeb ? undefined : active ? 'auto' : 'no-hide-descendants'}
                style={[
                    StyleSheet.absoluteFillObject,
                    {
                        opacity: active ? 1 : 0,
                        display: isWeb ? (active ? 'flex' : 'none') : 'flex',
                    },
                ]}
            >
                {content}
            </WebInertView>
        );
    }

    return (
        <WebInertView
            testID={props.testID}
            pointerEvents={active ? 'auto' : 'none'}
            inert={isWeb && !active ? true : undefined}
            aria-hidden={isWeb && !active ? true : undefined}
            accessibilityElementsHidden={isWeb ? undefined : !active}
            importantForAccessibility={isWeb ? undefined : active ? 'auto' : 'no-hide-descendants'}
            style={[
                mode === 'content' ? { minWidth: 0 } : { flex: 1, minHeight: 0, minWidth: 0 },
                !active ? { display: 'none' } : null,
            ]}
        >
            {content}
        </WebInertView>
    );
});
