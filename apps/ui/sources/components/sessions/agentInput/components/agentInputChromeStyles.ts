import { Platform } from 'react-native';
import type { UnistylesThemes } from 'react-native-unistyles';

import { Typography } from '@/constants/Typography';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { glassSurfaceBackgroundColor } from '@/components/ui/glass/glassSurfacePaint';


type Theme = UnistylesThemes[keyof UnistylesThemes];

/**
 * The composer's own chrome: the panel around the input and the action chips under it. `AgentInput`
 * paints these, and settings previews render the same chips inside the same panel, so the two
 * cannot drift apart.
 */
/** Native rows state their rhythm as margins; chips and the rows around them share this one. */
export const NATIVE_ACTION_CHIP_GAP_Y = 1;
export const AGENT_INPUT_PANEL_PADDING_TOP = 2;

/**
 * The field's book and microphone accessories: sideways they touch each other, above them a new session's
 * Look chip sits 9 px away. The accessories take 5 px of that gap upward (the chip takes the other 4).
 */
export const AGENT_INPUT_FIELD_ACCESSORY_EDGES_PX = { leading: 0, trailing: 0, top: 5 } as const;
/**
 * Under the expand toggle the accessories' drawn top is 9 px below the toggle's bottom, so the toggle's hit
 * area takes the other 4 of the gap the accessories' 5 leave (the same split as the Look chip above them).
 */
export const AGENT_INPUT_EXPANSION_TOGGLE_HIT_REACH = { bottom: 4 } as const;
export const AGENT_INPUT_PANEL_PADDING_BOTTOM = 8;

/**
 * The composer's one edge (calm-shell C1), the same for live, read-only, document and preview composers and
 * for both composer styles: light draws no ink line, only the glass rim (white), so the fill and the contact/cast
 * shadow carry the edge; dark keeps one even glass line. Both read the theme's `glass.border`, so a custom
 * profile keeps its own edge. Width follows the predecessor glass recipe: a touch thicker on light, where the
 * rim must stay crisp over content.
 */
export function resolveAgentInputPanelEdgeStyle(theme: Theme) {
    const width = theme.dark ? 1.5 : 2;
    return { borderWidth: width, borderColor: theme.colors.glass.border } as const;
}

/** The material plane owns paint; this layout is shared by live input and previews. */
export function resolveAgentInputPanelLayoutStyle(theme: Theme) {
    return {
        // The composer stack's radius (`theme.parts.composer`), shared with the banners above it.
        borderRadius: theme.parts.composer.radius,
        ...resolveAgentInputPanelEdgeStyle(theme),
        overflow: 'hidden' as const,
        paddingTop: AGENT_INPUT_PANEL_PADDING_TOP,
        paddingBottom: AGENT_INPUT_PANEL_PADDING_BOTTOM,
        paddingHorizontal: theme.space.s8,
    };
}

export function resolveAgentInputPanelStyle(theme: Theme) {
    return {
        ...resolveAgentInputPanelLayoutStyle(theme),
        backgroundColor: glassSurfaceBackgroundColor(theme.colors.input.background, 'card'),
    };
}

export const AGENT_INPUT_ACTION_CHIP_STYLE = {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    borderRadius: Platform.select({ default: 16, android: 20 }),
    paddingHorizontal: 10,
    paddingVertical: 6,
    justifyContent: 'center' as const,
    height: 32,
    gap: 6,
    ...(Platform.OS === 'web' ? {} : { marginRight: 6, marginBottom: NATIVE_ACTION_CHIP_GAP_Y }),
};

/** A chip while pressed: the standard pressed dip. */
export const AGENT_INPUT_ACTION_CHIP_PRESSED_STYLE = {
    opacity: motionTokens.press.opacity,
};

/** A chip whose label is hidden (icon-only density). */
export const AGENT_INPUT_ACTION_CHIP_ICON_ONLY_STYLE = {
    paddingHorizontal: 8,
    gap: 0,
};

export function resolveAgentInputActionChipTextStyle(theme: Theme) {
    return {
        fontSize: 13,
        color: theme.colors.composer.chipTint,
        fontWeight: '600' as const,
        ...Typography.default('semiBold'),
    };
}
