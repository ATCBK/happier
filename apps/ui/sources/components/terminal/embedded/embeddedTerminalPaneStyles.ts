import { StyleSheet } from 'react-native-unistyles';

import { Typography } from '@/constants/Typography';
import { glassSurfaceBackgroundColor } from '@/components/ui/glass/glassSurfacePaint';

export const embeddedTerminalPaneStyles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        backgroundColor: glassSurfaceBackgroundColor(theme.colors.surface.base, 'content', true),
    },
    toolbar: {
        paddingHorizontal: theme.space.s12,
        paddingTop: theme.space.s10,
        paddingBottom: theme.space.s10,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border.default,
        backgroundColor: glassSurfaceBackgroundColor(theme.colors.surface.inset, 'content', true),
        gap: theme.space.s10,
    },
    // A borrowed output keeps only its actions: no title (the owning row names it), no rule, no inset fill.
    toolbarReadOnly: {
        paddingHorizontal: theme.space.s8,
        paddingTop: theme.space.s6,
        paddingBottom: theme.space.s2,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-end',
    },
    toolbarLeft: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s10,
        minWidth: 0,
        flex: 1,
    },
    toolbarTitle: {
        ...Typography.variant('body', 'semiBold'),
        color: theme.colors.text.secondary,
    },
    toolbarRight: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s12,
    },
    banner: {
        paddingHorizontal: theme.space.s12,
        paddingTop: theme.space.s8,
        paddingBottom: theme.space.s8,
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s10,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border.default,
        backgroundColor: glassSurfaceBackgroundColor(theme.colors.surface.base, 'content', true),
    },
    bannerUrl: {
        flex: 1,
        minWidth: 0,
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
    bannerActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
        flexShrink: 0,
    },
    terminalSurface: {
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        padding: theme.space.s8,
    },
    renderer: {
        flex: 1,
        minHeight: 0,
        minWidth: 0,
    },
    rendererCovered: {
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        opacity: 0,
    },
    overlay: {
        ...StyleSheet.absoluteFillObject,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: theme.space.s16,
        backgroundColor: glassSurfaceBackgroundColor(theme.colors.surface.base, 'content', true),
        opacity: 0.96,
    },
}));
