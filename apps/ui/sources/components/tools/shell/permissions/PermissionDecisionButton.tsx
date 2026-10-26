import * as React from 'react';
import { TouchableOpacity, type TouchableOpacityProps, type View } from 'react-native';
import type { HappierHitReach } from '@happier-dev/plugin-ui/environment';
import { useHappierHitArea } from '@happier-dev/plugin-ui/presentation';
import { useUnistyles } from 'react-native-unistyles';

/**
 * One decision button of an approval or question card. The button keeps its drawn size (the compact
 * pill and its padding); under a finger the shared hit-area owner reaches the touch target past it.
 * By default the hit area reaches half of the `s6` gap the permission footer wraps its decisions
 * with, on every side, so neighbouring decisions never overlap: Allow and Deny must not share a tap.
 * A card whose button has more room passes the free space it may reach into as `hitReach`.
 */
export const PermissionDecisionButton = React.forwardRef<View, TouchableOpacityProps & Readonly<{ hitReach?: HappierHitReach }>>(
    function PermissionDecisionButton({ style, children, hitReach, ...props }, ref) {
        const { theme } = useUnistyles();
        const hitArea = useHappierHitArea({ restingStyle: () => style, hitReach: hitReach ?? theme.space.s6 / 2 });
        return (
            <TouchableOpacity {...props} ref={ref} style={style} hitSlop={hitArea.hitSlop} onLayout={hitArea.onLayout}>
                {hitArea.frame}
                {children}
            </TouchableOpacity>
        );
    },
);
