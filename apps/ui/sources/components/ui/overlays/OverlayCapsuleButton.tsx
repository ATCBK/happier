import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { GlassPanel } from '@/components/ui/glass/GlassPanel';
import { Icon } from '@/components/ui/icons/Icon';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { motionTokens } from '@/components/ui/motion/motionTokens';

/**
 * The small floating capsule control that sits beside a bottom-anchored overlay surface — the
 * new-session composer's close/dismiss capsules and the native Search overlay's equivalents.
 *
 * It is one owner rather than one per surface because the capsule is the same product object in
 * both places: the same glass material as the card and the tab bar, the same circular size, and the
 * same real press frame around the compact visual capsule. The row owns enough
 * space for that frame, so adjacent controls never overlap and Android cannot
 * clip an invisible hit-slop extension at the parent boundary.
 */

/** Clamps to a full circle at this size; matches the tab bar and composer capsules. */
const CAPSULE_RADIUS = 999;
export const OVERLAY_CAPSULE_BUTTON_SIZE = 36;
const CAPSULE_ICON_SIZE = 16;

/** Separates the capsule row from the surface it floats above without letting their hit areas meet. */
export const OVERLAY_CAPSULE_BUTTON_GAP = 10;

/** Total vertical space a capsule row takes above the surface it floats over. */
export const OVERLAY_CAPSULE_ROW_HEIGHT = Math.max(OVERLAY_CAPSULE_BUTTON_SIZE, resolveMinimumInteractiveTargetSize(Platform.OS))
    + OVERLAY_CAPSULE_BUTTON_GAP;

const styles = StyleSheet.create({
    capsule: {
        width: OVERLAY_CAPSULE_BUTTON_SIZE,
        height: OVERLAY_CAPSULE_BUTTON_SIZE,
    },
    press: {
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: CAPSULE_RADIUS,
    },
    visual: {
        width: OVERLAY_CAPSULE_BUTTON_SIZE,
        height: OVERLAY_CAPSULE_BUTTON_SIZE,
        alignItems: 'center',
        justifyContent: 'center',
    },
    pressed: {
        opacity: motionTokens.press.opacitySubtle,
    },
});

export const OverlayCapsuleButton = React.memo(function OverlayCapsuleButton(
    props: Readonly<{
        accessibilityLabel: string;
        icon: React.ComponentProps<typeof Icon>['name'];
        onPress: () => void;
        testID: string;
    }>,
): React.ReactElement {
    const { theme } = useUnistyles();
    const minimumInteractiveTargetSize = Math.max(OVERLAY_CAPSULE_BUTTON_SIZE, resolveMinimumInteractiveTargetSize(Platform.OS));

    return (
        <Pressable
            testID={props.testID}
            accessibilityRole="button"
            accessibilityLabel={props.accessibilityLabel}
            onPress={props.onPress}
            style={({ pressed }) => [
                styles.press,
                { width: minimumInteractiveTargetSize, height: minimumInteractiveTargetSize },
                pressed ? styles.pressed : null,
            ]}
        >
            <View pointerEvents="none">
                <GlassPanel
                    radius={CAPSULE_RADIUS}
                    shadowLevel={2}
                    innerShadow={false}
                    style={styles.capsule}
                >
                    <View style={styles.visual}>
                        <Icon name={props.icon} size={CAPSULE_ICON_SIZE} color={theme.colors.text.secondary} />
                    </View>
                </GlassPanel>
            </View>
        </Pressable>
    );
});
