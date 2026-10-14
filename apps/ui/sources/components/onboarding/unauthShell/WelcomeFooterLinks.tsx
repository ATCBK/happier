import * as React from 'react';
import { Linking, Pressable, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';
import { usePressFeedback } from '@/components/ui/interactions/usePressFeedback';

import { RelayRetentionDisclosure, type RelayRetentionDisclosureState } from './RelayRetentionDisclosure';

const DOCS_URL = 'https://docs.happier.dev';
const GITHUB_URL = 'https://github.com/happier-dev/happier';
const DISCORD_URL = 'https://discord.gg/W6Pb8KuHfg';
const MINIMUM_TOUCH_TARGET_STYLE = { minWidth: 44, minHeight: 44 } as const;

export type WelcomeFooterLinksProps = Readonly<{
    variant: 'desktop' | 'mobile';
    retentionDisclosure?: RelayRetentionDisclosureState | null;
}>;

/**
 * Welcome-step-only footer rendered at the bottom of the workflow pane.
 * The sign-in/Home authority controls live in the Welcome decision panel. This footer is limited
 * to help/community links so a focused Home cannot appear to select the sign-in destination.
 */
export const WelcomeFooterLinks = React.memo(function WelcomeFooterLinks(props: WelcomeFooterLinksProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;

    const openDocs = React.useCallback(() => { void Linking.openURL(DOCS_URL); }, []);
    const openGithub = React.useCallback(() => { void Linking.openURL(GITHUB_URL); }, []);
    const openDiscord = React.useCallback(() => { void Linking.openURL(DISCORD_URL); }, []);

    const labelColor = { color: theme.colors.text.secondary };
    const actionColor = { color: theme.colors.text.primary };
    const githubFeedback = usePressFeedback({ glyph: true });
    const discordFeedback = usePressFeedback({ glyph: true });
    const docsFeedback = usePressFeedback({ glyph: true });
    const iconColor = theme.colors.text.primary;
    const isMobile = props.variant === 'mobile';
    const footerGroupStyle = isMobile ? styles.groupMobile : styles.groupDesktop;

    return (
        <View
            style={isMobile ? styles.containerMobile : styles.containerDesktop}
            testID="welcome-footer-links"
        >
            {props.retentionDisclosure ? (
                <RelayRetentionDisclosure
                    testID="welcome-footer-retention"
                    disclosure={props.retentionDisclosure}
                />
            ) : null}
            <View style={isMobile ? styles.linksMobile : styles.linksDesktop}>
                <View style={footerGroupStyle} testID="welcome-footer-docs">
                    <Text style={[styles.label, labelColor]}>
                        {t('welcome.welcomeFooterDocs')}
                    </Text>
                    <View style={isMobile ? styles.actionsRowCenter : styles.actionsRowStart}>
                        <Pressable
                            onPress={openGithub}
                            accessibilityRole="link"
                            accessibilityLabel={t('welcome.welcomeFooterGithubLabel')}
                            testID="welcome-footer-github-action"
                            hitSlop={6}
                            onPressIn={githubFeedback.onPressIn}
                            onPressOut={githubFeedback.onPressOut}
                            style={[MINIMUM_TOUCH_TARGET_STYLE, styles.iconButton]}
                        >
                            <Animated.View style={githubFeedback.animatedStyle}>
                                <Icon name="github-logo" size={16} color={iconColor} />
                            </Animated.View>
                        </Pressable>
                        <Pressable
                            onPress={openDiscord}
                            accessibilityRole="link"
                            accessibilityLabel={t('welcome.welcomeFooterDiscordLabel')}
                            testID="welcome-footer-discord-action"
                            hitSlop={6}
                            onPressIn={discordFeedback.onPressIn}
                            onPressOut={discordFeedback.onPressOut}
                            style={[MINIMUM_TOUCH_TARGET_STYLE, styles.iconButton]}
                        >
                            <Animated.View style={discordFeedback.animatedStyle}>
                                <Icon name="discord-logo" size={16} color={iconColor} />
                            </Animated.View>
                        </Pressable>
                        <Pressable
                            onPress={openDocs}
                            accessibilityRole="link"
                            accessibilityLabel={t('welcome.welcomeFooterDocsAction')}
                            testID="welcome-footer-docs-action"
                            onPressIn={docsFeedback.onPressIn}
                            onPressOut={docsFeedback.onPressOut}
                            style={[MINIMUM_TOUCH_TARGET_STYLE, styles.textButton]}
                        >
                            <Animated.View style={docsFeedback.animatedStyle}>
                                <Text style={[styles.action, actionColor]}>{t('welcome.welcomeFooterDocsAction')}</Text>
                            </Animated.View>
                        </Pressable>
                    </View>
                </View>
            </View>
        </View>
    );
});

const stylesheet = StyleSheet.create(() => ({
    containerDesktop: {
        width: '100%',
        flexDirection: 'column',
        alignItems: 'stretch',
        paddingTop: 20,
        paddingBottom: 28,
        gap: 14,
    },
    containerMobile: {
        width: '100%',
        flexDirection: 'column',
        alignItems: 'stretch',
        gap: 14,
        paddingTop: 18,
    },
    linksDesktop: {
        width: '100%',
        flexDirection: 'row',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 24,
    },
    linksMobile: {
        width: '100%',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 18,
    },
    groupDesktop: {
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: 4,
    },
    groupMobile: {
        flexDirection: 'column',
        alignItems: 'center',
        gap: 4,
    },
    actionsRowStart: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
    },
    actionsRowCenter: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
    },
    label: {
        ...Typography.variant('body'),
    },
    action: {
        ...Typography.variant('body'),
        textDecorationLine: 'underline',
    },
    iconButton: {
        minWidth: 44,
        minHeight: 44,
        alignItems: 'center',
        justifyContent: 'center',
    },
    textButton: {
        minWidth: 44,
        minHeight: 44,
        alignItems: 'center',
        justifyContent: 'center',
    },
}));
