import { StyleSheet } from 'react-native-unistyles';

import { Typography } from '@/constants/Typography';

export const browserFrameStyles = StyleSheet.create((theme) => ({
    root: {
        flex: 1,
        minHeight: 0,
        backgroundColor: theme.colors.surface.base,
    },
    centered: {
        flex: 1,
        minHeight: 0,
        alignItems: 'center',
        justifyContent: 'center',
        padding: theme.space.s24,
        backgroundColor: theme.colors.surface.base,
    },
    statusText: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
        textAlign: 'center',
    },
}));
