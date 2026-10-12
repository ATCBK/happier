import * as React from 'react';
import { View, ViewStyle, StyleProp } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { SurfaceCard } from './SurfaceCard';

export interface ActionCardProps {
    title: string;
    description?: string;
    primaryAction: { label: string; onPress: () => void | Promise<void> };
    secondaryAction?: { label: string; onPress: () => void };
    icon?: React.ReactNode;
    loading?: boolean;
    disabled?: boolean;
    testID?: string;
    style?: StyleProp<ViewStyle>;
    tone?: 'surface' | 'muted';
    /** A quiet, setup-like presentation for contextual recovery actions. */
    appearance?: 'default' | 'quiet';
}

export const ActionCard = React.memo<ActionCardProps>(
    ({ title, description, primaryAction, secondaryAction, icon, loading, disabled, testID, style, tone = 'surface', appearance = 'default' }) => {
        const styles = stylesheet;
        const quiet = appearance === 'quiet';

        return (
            <SurfaceCard
                testID={testID}
                tone={tone}
                padding="md"
                style={[quiet ? styles.quietSurface : null, style]}
            >
                <View style={[styles.container, quiet ? styles.quietContainer : null]}>
                {icon ? <View style={[styles.iconRow, quiet ? styles.quietIconRow : null]}>{icon}</View> : null}
                <Text style={[styles.title, quiet ? styles.quietTitle : null]}>{title}</Text>
                {description ? (
                    <Text style={[styles.description, quiet ? styles.quietDescription : null]}>
                        {description}
                    </Text>
                ) : null}
                <View style={[styles.buttonRow, quiet ? styles.quietButtonRow : null]}>
                    <RoundButton
                        title={primaryAction.label}
                        titleNumberOfLines="complete"
                        style={[styles.button, quiet ? styles.quietButton : null]}
                        size={quiet ? 'normal' : undefined}
                        loading={loading}
                        onPress={loading ? undefined : primaryAction.onPress}
                        disabled={disabled || loading}
                        testID={testID ? `${testID}-primary` : undefined}
                    />
                    {secondaryAction ? (
                        <RoundButton
                            title={secondaryAction.label}
                            titleNumberOfLines="complete"
                            style={[styles.button, quiet ? styles.quietButton : null]}
                            size={quiet ? 'normal' : undefined}
                            display="inverted"
                            loading={loading}
                            onPress={secondaryAction.onPress}
                            disabled={disabled || loading}
                            testID={testID ? `${testID}-secondary` : undefined}
                        />
                    ) : null}
                </View>
                </View>
            </SurfaceCard>
        );
    },
);

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        minWidth: 0,
        gap: 0,
    },
    quietSurface: {
        alignSelf: 'center',
        maxWidth: 560,
        padding: 0,
        borderRadius: 0,
        borderWidth: 0,
        borderColor: 'transparent',
        backgroundColor: 'transparent',
        boxShadow: 'none',
        shadowOpacity: 0,
        elevation: 0,
    },
    quietContainer: {
        alignItems: 'center',
        width: '100%',
    },
    iconRow: {
        marginBottom: theme.space.s12,
    },
    quietIconRow: {
        alignItems: 'center',
        marginBottom: theme.space.s16,
    },
    title: {

        ...Typography.variant('heading'),

        color: theme.colors.text.primary,
    },
    description: {
        ...Typography.variant('reading'),
        marginTop: theme.space.s4,
        color: theme.colors.text.secondary,
    },
    quietTitle: {
        width: '100%',
        textAlign: 'center',
        fontSize: 22,
        lineHeight: 28,
        letterSpacing: -0.25,
    },
    quietDescription: {
        width: '100%',
        maxWidth: 520,
        textAlign: 'center',
        fontSize: 15,
        lineHeight: 22,
        marginTop: theme.space.s8,
    },
    buttonRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: theme.space.s12,
        marginTop: theme.space.s16,
    },
    button: {
        maxWidth: '100%',
    },
    quietButtonRow: {
        width: '100%',
        justifyContent: 'center',
        alignItems: 'center',
        marginTop: theme.space.s24,
    },
    quietButton: {
        alignSelf: 'center',
        flexGrow: 0,
        flexShrink: 1,
    },
}));
