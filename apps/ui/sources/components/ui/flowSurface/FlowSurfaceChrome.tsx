import * as React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import { WizardCardLayout } from '@/components/onboarding/ui/WizardCardLayout';

/**
 * Horizontal inset of the card's content column. The action footer sits outside that
 * column in the DOM, so it reads the same value from here rather than carrying its own
 * copy and drifting to the card edge.
 */
export const FLOW_SURFACE_CONTENT_INSET = 24;

export type FlowSurfaceChromeProps = Readonly<{
    children: React.ReactNode;
    testID?: string;
    title?: React.ReactNode;
    subtitle?: React.ReactNode;
    titleLeading?: React.ReactNode;
    header?: React.ReactNode;
    footer?: React.ReactNode;
    presentation?: 'auto' | 'card' | 'fullscreen';
    showScrim?: boolean;
    scrollable?: boolean;
    contentStyle?: StyleProp<ViewStyle>;
    shellStyle?: StyleProp<ViewStyle>;
    titleAlignment?: 'center' | 'left';
    titleScale?: 'default' | 'wizard';
}>;

const stylesheet = StyleSheet.create((theme) => ({
    shell: {
        flexDirection: 'column',
        flexShrink: 1,
        minHeight: 0,
    },
    header: {
        width: '100%',
        gap: theme.space.s10,
    },
    content: {
        paddingHorizontal: FLOW_SURFACE_CONTENT_INSET,
        paddingTop: theme.space.s24,
        paddingBottom: theme.space.s24,
        gap: theme.space.s16,
    },
    titleBlock: {
        width: '100%',
        maxWidth: 440,
        alignSelf: 'center',
        alignItems: 'center',
        gap: theme.space.s8,
    },
    titleBlockLeft: {
        maxWidth: '100%',
        alignSelf: 'stretch',
        alignItems: 'flex-start',
    },
    titleLeading: {
        alignItems: 'center',
        justifyContent: 'center',
    },
    titleLeadingLeft: {
        alignItems: 'flex-start',
    },
    title: {
        ...Typography.variant('title'),
        color: theme.colors.text.primary,
        textAlign: 'center',
    },
    titleWizard: {
        fontSize: 30,
        lineHeight: 36,
    },
    titleLeft: {
        textAlign: 'left',
    },
    subtitle: {
        ...Typography.variant('reading'),
        color: theme.colors.text.secondary,
        textAlign: 'center',
    },
    subtitleLeft: {
        textAlign: 'left',
    },
    body: {
        width: '100%',
        gap: theme.space.s16,
    },
    footer: {
        width: '100%',
        gap: theme.space.s12,
    },
}));

export function FlowSurfaceChrome(props: FlowSurfaceChromeProps) {
    const styles = stylesheet;
    const hasHeader = props.header != null;
    const hasTitleBlock = props.titleLeading != null || props.title != null || props.subtitle != null;
    const hasFooter = props.footer != null;
    const titleAlignment = props.titleAlignment ?? 'center';
    const titleScale = props.titleScale ?? 'default';

    return (
        <WizardCardLayout
            testID={props.testID}
            presentation={props.presentation ?? 'card'}
            showScrim={props.showScrim}
            scrollable={props.scrollable}
        >
            <View style={[styles.shell, props.shellStyle]}>
                {hasHeader ? <View style={styles.header}>{props.header}</View> : null}
                <View style={[styles.content, props.contentStyle]}>
                    {hasTitleBlock ? (
                        <View style={[
                            styles.titleBlock,
                            titleAlignment === 'left' ? styles.titleBlockLeft : null,
                        ]}>
                            {props.titleLeading ? (
                                <View style={[
                                    styles.titleLeading,
                                    titleAlignment === 'left' ? styles.titleLeadingLeft : null,
                                ]}>
                                    {props.titleLeading}
                                </View>
                            ) : null}
                            {props.title ? (
                                <Text style={[
                                    styles.title,
                                    titleScale === 'wizard' ? styles.titleWizard : null,
                                    titleAlignment === 'left' ? styles.titleLeft : null,
                                ]}>
                                    {props.title}
                                </Text>
                            ) : null}
                            {props.subtitle ? (
                                <Text style={[
                                    styles.subtitle,
                                    titleAlignment === 'left' ? styles.subtitleLeft : null,
                                ]}>
                                    {props.subtitle}
                                </Text>
                            ) : null}
                        </View>
                    ) : null}
                    <View style={styles.body}>{props.children}</View>
                </View>
                {hasFooter ? <View style={styles.footer}>{props.footer}</View> : null}
            </View>
        </WizardCardLayout>
    );
}
