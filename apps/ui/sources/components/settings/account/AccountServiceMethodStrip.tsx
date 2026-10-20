import * as React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierSkeletonBlock } from '@happier-dev/plugin-ui/presentation';

import type { AccountDirectoryAuthenticationAction } from '@/auth/accountDirectory/accountDirectoryAuthClient';
import {
    describeAccountServiceAuthenticationAction,
    projectAccountServiceMethodStrip,
} from '@/components/account/auth/accountServiceAuthenticationActions';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { t } from '@/text';

/** The strip's height while the service's methods are still being checked: one primary, one secondary. */
const SKELETON_BUTTON_HEIGHT_PX = 32;
/** Below this width (phones) the ways in stack as full-width buttons. */
const STACKED_STRIP_MAX_WIDTH_PX = 420;

/**
 * The ways into the account service, inline in its section: one primary button, up to two more,
 * then "new here" as a quiet action. Past three ways in, the rest sit behind "More ways to sign in".
 * While the methods are unknown the strip keeps its space with placeholders, so nothing moves when
 * they arrive.
 */
export const AccountServiceMethodStrip = React.memo(function AccountServiceMethodStrip(props: Readonly<{
    /** Null while the service is still being checked. */
    actions: readonly AccountDirectoryAuthenticationAction[] | null;
    serviceName: string;
    /** The action whose sign-in is starting; every other button waits for it. */
    pendingSlug: string | null;
    onSelect: (entry: AccountDirectoryAuthenticationAction) => void;
}>) {
    const { theme } = useUnistyles();
    const reducedMotion = useReducedMotionPreference();
    const [showMore, setShowMore] = React.useState(false);
    const [stacked, setStacked] = React.useState(false);
    const onLayout = React.useCallback((event: LayoutChangeEvent) => {
        setStacked(event.nativeEvent.layout.width < STACKED_STRIP_MAX_WIDTH_PX);
    }, []);

    if (!props.actions) {
        return (
            <View
                testID="settings-account-service-methods-loading"
                style={styles.row}
                aria-hidden
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
            >
                <HappierSkeletonBlock color={theme.colors.surface.skeleton} width={168} height={SKELETON_BUTTON_HEIGHT_PX} radius={10} reducedMotion={reducedMotion} />
                <HappierSkeletonBlock color={theme.colors.surface.skeleton} width={110} height={SKELETON_BUTTON_HEIGHT_PX} radius={10} reducedMotion={reducedMotion} />
            </View>
        );
    }

    const strip = projectAccountServiceMethodStrip(props.actions);
    const createSlug = strip.create ? describeAccountServiceAuthenticationAction(strip.create, props.serviceName).slug : null;
    const button = (entry: AccountDirectoryAuthenticationAction, display: 'default' | 'secondary') => {
        const presentation = describeAccountServiceAuthenticationAction(entry, props.serviceName);
        const pending = props.pendingSlug === presentation.slug;
        return (
            <RoundButton
                key={presentation.slug}
                testID={`settings-account-service-method-${presentation.slug}`}
                size="small"
                display={display}
                title={presentation.title}
                leading={<Icon name={presentation.iconName} size={16} color={display === 'default' ? theme.colors.button.primary.tint : theme.colors.text.primary} />}
                loading={pending}
                disabled={props.pendingSlug !== null}
                style={stacked ? styles.stackedButton : undefined}
                onPress={() => props.onSelect(entry)}
            />
        );
    };

    const rowStyle = stacked ? styles.stack : styles.row;
    return (
        <View onLayout={onLayout}>
            <View style={rowStyle}>
                {strip.primary ? button(strip.primary, 'default') : null}
                {strip.secondary.map((entry) => button(entry, 'secondary'))}
                {strip.overflow.length > 0 ? (
                    <RoundButton
                        testID="settings-account-service-more-methods"
                        size="small"
                        display="inverted"
                        title={showMore ? t('settingsAccount.accountServiceFewerWays') : t('settingsAccount.accountServiceMoreWays')}
                        trailing={<Icon name={showMore ? 'caret-up' : 'caret-down'} size={14} color={theme.colors.text.secondary} />}
                        expanded={showMore}
                        onPress={() => setShowMore((current) => !current)}
                    />
                ) : null}
                {stacked ? null : <View style={styles.spacer} />}
                {strip.create ? (
                    <RoundButton
                        testID={`settings-account-service-method-${createSlug}`}
                        size="small"
                        display="inverted"
                        title={t('settingsAccount.accountServiceCreateAccount')}
                        textStyle={{ color: theme.colors.text.secondary }}
                        style={stacked ? styles.stackedLink : undefined}
                        loading={props.pendingSlug === createSlug}
                        disabled={props.pendingSlug !== null}
                        onPress={() => props.onSelect(strip.create!)}
                    />
                ) : null}
            </View>
            {showMore && strip.overflow.length > 0 ? (
                <View style={[rowStyle, styles.moreRow]}>
                    {strip.overflow.map((entry) => button(entry, 'secondary'))}
                </View>
            ) : null}
        </View>
    );
});

const styles = StyleSheet.create({
    row: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 8,
    },
    stack: {
        flexDirection: 'column',
        alignItems: 'stretch',
        gap: 8,
    },
    stackedButton: {
        alignSelf: 'stretch',
    },
    stackedLink: {
        alignSelf: 'center',
    },
    moreRow: {
        marginTop: 10,
    },
    spacer: {
        flexGrow: 1,
    },
});
