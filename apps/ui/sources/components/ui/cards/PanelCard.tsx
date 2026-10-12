import * as React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import { SurfaceCard } from './SurfaceCard';

type PanelCardProps = Readonly<{
    title?: string;
    subtitle?: string;
    headerEyebrow?: string;
    headerAccessory?: React.ReactNode;
    children: React.ReactNode;
    testID?: string;
    tone?: 'surface' | 'muted';
    padding?: 'none' | 'sm' | 'md' | 'lg';
    style?: StyleProp<ViewStyle>;
    bodyStyle?: StyleProp<ViewStyle>;
}>;

const styles = StyleSheet.create((theme) => ({
    card: {
        gap: theme.space.s12,
        minWidth: 0,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: theme.space.s12,
        minWidth: 0,
    },
    headerText: {
        flex: 1,
        minWidth: 0,
        gap: theme.space.s4,
    },
    eyebrow: {

        ...Typography.variant('body', 'semiBold'),

        color: theme.colors.text.secondary,

    },
    title: {

        ...Typography.variant('display'),


        color: theme.colors.text.primary,
    },
    subtitle: {
        ...Typography.variant('reading'),
        color: theme.colors.text.secondary,
    },
}));

export const PanelCard = React.memo(function PanelCard(props: PanelCardProps) {
    const {
        title,
        subtitle,
        headerEyebrow,
        headerAccessory,
        children,
        testID,
        tone = 'surface',
        padding = 'lg',
        style,
        bodyStyle,
    } = props;

    const hasHeader = Boolean(title || subtitle || headerEyebrow || headerAccessory);

    return (
        <SurfaceCard
            testID={testID}
            tone={tone}
            padding={padding}
            style={style}
        >
            <View style={styles.card}>
                {hasHeader ? (
                    <View style={styles.header}>
                        <View style={styles.headerText}>
                            {headerEyebrow ? <Text style={styles.eyebrow}>{headerEyebrow}</Text> : null}
                            {title ? (
                                <Text numberOfLines={2} adjustsFontSizeToFit style={styles.title}>
                                    {title}
                                </Text>
                            ) : null}
                            {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
                        </View>
                        {headerAccessory}
                    </View>
                ) : null}
                <View style={bodyStyle}>{children}</View>
            </View>
        </SurfaceCard>
    );
});
