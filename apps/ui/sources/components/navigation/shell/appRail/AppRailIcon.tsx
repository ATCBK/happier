import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { Icon, type IconName } from '@/components/ui/icons/Icon';

import { APP_RAIL_ICON_GLYPH_SIZE_PX } from './appRailMetrics';

/**
 * At rest a rail glyph is the secondary ink drawn at this opacity: lighter than the labels it sits
 * beside, and still above 3:1 against the rail in light and dark (non-text UI minimum, WCAG 1.4.11).
 * `text.tertiary` is lighter still but falls under 3:1 on the light rail.
 */
const RAIL_GLYPH_REST_OPACITY = 0.8;
const REST_STYLE = Object.freeze({ opacity: RAIL_GLYPH_REST_OPACITY });

/** The rail glyph's ink: quiet at rest, the primary ink at full strength while its destination is open. */
export function useAppRailGlyphInk(active: boolean): Readonly<{ color: string; style?: typeof REST_STYLE }> {
    const { theme } = useUnistyles();
    return active
        ? { color: theme.colors.text.primary }
        : { color: theme.colors.text.secondary, style: REST_STYLE };
}

/**
 * The one rail glyph: every icon on the rail is this size in the same box. At rest it draws in the
 * quiet ink; the destination that is open draws filled and in the primary ink.
 */
export const AppRailIcon = React.memo(function AppRailIcon(props: Readonly<{
    name: IconName;
    active?: boolean;
}>) {
    const ink = useAppRailGlyphInk(props.active === true);
    return (
        <Icon
            name={props.name}
            size={APP_RAIL_ICON_GLYPH_SIZE_PX}
            weight={props.active ? 'fill' : 'regular'}
            color={ink.color}
            style={ink.style}
        />
    );
});
