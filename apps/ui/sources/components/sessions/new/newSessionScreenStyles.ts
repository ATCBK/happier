import { Platform } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';

export const newSessionScreenStyles = StyleSheet.create((theme, rt) => ({
    container: {
        flex: 1,
        justifyContent: Platform.OS === 'web' ? 'center' : 'flex-end',
        paddingTop: Platform.OS === 'web' ? 20 : 10,
        ...(Platform.select({
            web: { minHeight: 0 },
            default: {},
        }) as any),
    },
    scrollContainer: {
        flex: 1,
        ...(Platform.select({
            web: { minHeight: 0 },
            default: {},
        }) as any),
    },
    contentContainer: {
        width: '100%',
        alignSelf: 'center',
        paddingTop: 0,
        paddingBottom: theme.space.s16,
    },
    wizardSelectionPair: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: theme.space.s16,
    },
    wizardSelectionPairColumn: {
        flex: 1,
        minWidth: 0,
    },
    profileListItem: {
        backgroundColor: theme.colors.input.background,
        borderRadius: 12,
        padding: theme.space.s8,
        marginBottom: theme.space.s8,
        flexDirection: 'row',
        alignItems: 'center',
        borderWidth: 2,
        borderColor: 'transparent',
    },
    profileListItemSelected: {
        borderWidth: 2,
        borderColor: theme.colors.text.primary,
    },
    profileIcon: {
        width: 20,
        height: 20,
        borderRadius: 10,
        backgroundColor: theme.colors.button.primary.background,
        justifyContent: 'center',
        alignItems: 'center',
        marginRight: theme.space.s10,
    },
    profileListName: {
        ...Typography.variant('body', 'semiBold'),
        color: theme.colors.text.primary,
    },
    profileListDetails: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
        marginTop: theme.space.s2,
    },
    addProfileButton: {
        backgroundColor: theme.colors.surface.base,
        borderRadius: 12,
        padding: theme.space.s12,
        marginBottom: theme.space.s12,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
    },
    addProfileButtonText: {
        ...Typography.variant('body', 'semiBold'),
        color: theme.colors.button.secondary.tint,
        marginLeft: theme.space.s8,
    },
    selectorButton: {
        backgroundColor: theme.colors.input.background,
        borderRadius: 8,
        padding: theme.space.s10,
        marginBottom: theme.space.s12,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
    },
    selectorButtonText: {
        color: theme.colors.text.primary,
        ...Typography.variant('body'),
        flex: 1,
    },
    permissionGrid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        justifyContent: 'space-between',
        marginBottom: theme.space.s16,
    },
    permissionButton: {
        width: '48%',
        backgroundColor: theme.colors.input.background,
        borderRadius: 12,
        padding: theme.space.s16,
        marginBottom: theme.space.s12,
        alignItems: 'center',
        borderWidth: 2,
        borderColor: 'transparent',
    },
    permissionButtonSelected: {
        borderColor: theme.colors.button.primary.background,
        backgroundColor: theme.colors.button.primary.background + '10',
    },
    permissionButtonText: {
        ...Typography.variant('label', 'semiBold'),
        color: theme.colors.text.primary,
        marginTop: theme.space.s8,
        textAlign: 'center',
    },
    permissionButtonTextSelected: {
        color: theme.colors.button.primary.background,
    },
    permissionButtonDesc: {
        ...Typography.variant('micro'),
        color: theme.colors.text.secondary,
        marginTop: theme.space.s4,
        textAlign: 'center',
    },
}));
