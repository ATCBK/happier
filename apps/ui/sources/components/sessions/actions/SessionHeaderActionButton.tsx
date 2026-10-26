import { HappierPressable, type HappierPressableProps } from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';

import { motionTokens } from '@/components/ui/motion/motionTokens';

import { SESSION_HEADER_ACTION_SIZE_PX } from './sessionHeaderIconMetrics';

/** Half the 6 px gap the header keeps between its actions: neighbouring hit areas meet, never overlap. */
const HEADER_ACTION_HIT_REACH = { left: 3, right: 3 } as const;

/**
 * A direct session-header action: the page's control-height square around the header glyph. The
 * square is the whole drawn box; a finger reaches 44 through the shared pressable's hit area.
 */
export const SessionHeaderActionButton = React.memo(function SessionHeaderActionButton(props: Readonly<{
    testID?: string;
    accessibilityLabel: string;
    onPress: HappierPressableProps['onPress'];
    disabled?: boolean;
    expanded?: boolean;
    controlRef?: HappierPressableProps['controlRef'];
    children: React.ReactNode;
}>) {
    return (
        <HappierPressable
            testID={props.testID}
            accessibilityLabel={props.accessibilityLabel}
            onPress={props.onPress}
            disabled={props.disabled}
            expanded={props.expanded}
            controlRef={props.controlRef}
            hitReach={HEADER_ACTION_HIT_REACH}
            style={(state) => ({
                width: SESSION_HEADER_ACTION_SIZE_PX,
                height: SESSION_HEADER_ACTION_SIZE_PX,
                alignItems: 'center',
                justifyContent: 'center',
                opacity: props.disabled === true ? 0.45 : state.pressed ? motionTokens.press.opacity : 1,
            })}
        >
            {props.children}
        </HappierPressable>
    );
});
