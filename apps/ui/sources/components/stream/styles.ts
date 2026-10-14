import { StyleSheet } from 'react-native-unistyles';

import { Typography } from '@/constants/Typography';

export const streamPlayerStyles = StyleSheet.create((theme) => ({
    root: {
        flex: 1,
        minHeight: 0,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
    },
    surface: {
        flex: 1,
        minHeight: 0,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.surface.inset,
    },
    frame: {
        width: '100%',
        height: '100%',
    },
    centered: {
        flex: 1,
        width: '100%',
        minHeight: 180,
        alignItems: 'center',
        justifyContent: 'center',
        gap: theme.space.s8,
        padding: theme.space.s20,
    },
    titleText: {
        color: theme.colors.text.primary,
        textAlign: 'center',
        ...Typography.default('semiBold'),
    },
    metaText: {
        color: theme.colors.text.secondary,
        textAlign: 'center',
        ...Typography.default(),
    },
    overlay: {
        position: 'absolute',
        left: 12,
        right: 12,
        bottom: 12,
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: theme.space.s8,
    },
    statusPill: {
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
        paddingHorizontal: theme.space.s10,
        paddingVertical: theme.space.s6,
    },
    statusPillRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s6,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
        paddingHorizontal: theme.space.s10,
        paddingVertical: theme.space.s6,
    },
    statusText: {
        color: theme.colors.text.secondary,
        ...Typography.default('semiBold'),
    },
}));
