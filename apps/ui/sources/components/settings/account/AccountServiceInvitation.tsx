import * as React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

type Benefit = Readonly<{ icon: 'magnifying-glass' | 'key' | 'device-mobile'; title: string; description: string }>;

/** Below this width the three benefits shrink to one line of names instead of side-by-side columns. */
const BENEFIT_COLUMN_MIN_WIDTH_PX = 160;

/**
 * What the account service is, in one sentence beside its mark. The section keeps it in every
 * signed-out and trouble state, so the section never loses its reason to exist. The mark sits in the
 * section row's leading column (`SectionContentRow` `leading`), so this text starts on the rows' edge.
 */
export const AccountServiceInvitationIntro = React.memo(function AccountServiceInvitationIntro() {
    return (
        <View>
            <Text style={styles.title}>{t('settingsAccount.accountServiceInviteTitle')}</Text>
            <Text style={styles.body}>{t('settingsAccount.accountServiceInviteBody')}</Text>
        </View>
    );
});

/**
 * The service's real capabilities — finding linked Homes, opening them directly, and connecting
 * other devices — as three columns on wide sheets and one line of names on phones.
 */
export const AccountServiceBenefits = React.memo(function AccountServiceBenefits() {
    const { theme } = useUnistyles();
    const [columns, setColumns] = React.useState(true);
    const onLayout = React.useCallback((event: LayoutChangeEvent) => {
        setColumns(event.nativeEvent.layout.width >= BENEFIT_COLUMN_MIN_WIDTH_PX * 3);
    }, []);
    const benefits: readonly Benefit[] = [
        { icon: 'magnifying-glass', title: t('settingsAccount.accountServiceBenefitFindHomes'), description: t('settingsAccount.accountServiceBenefitFindHomesDescription') },
        { icon: 'key', title: t('settingsAccount.accountServiceBenefitSignIn'), description: t('settingsAccount.accountServiceBenefitSignInDescription') },
        { icon: 'device-mobile', title: t('settingsAccount.accountServiceBenefitDevices'), description: t('settingsAccount.accountServiceBenefitDevicesDescription') },
    ];
    return (
        <View onLayout={onLayout} style={columns ? styles.benefitColumns : styles.benefitLine}>
            {benefits.map((benefit, index) => columns ? (
                <View
                    key={benefit.icon}
                    style={[styles.benefitColumn, index > 0 ? styles.benefitColumnDivider : null]}
                >
                    <View style={styles.benefitHeading}>
                        <Icon name={benefit.icon} size={15} color={theme.colors.text.secondary} />
                        <Text style={styles.benefitTitle}>{benefit.title}</Text>
                    </View>
                    <Text style={styles.benefitDescription}>{benefit.description}</Text>
                </View>
            ) : (
                // On a phone the three capabilities are one quiet line of names: the intro above
                // already says what they add up to, so their descriptions are not repeated.
                <View key={benefit.icon} style={styles.benefitHeading}>
                    <Icon name={benefit.icon} size={14} color={theme.colors.text.secondary} />
                    <Text style={styles.benefitLineTitle}>{benefit.title}</Text>
                </View>
            ))}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    title: {
        ...Typography.default('medium'),
        color: theme.colors.text.primary,
        fontSize: 15,
        lineHeight: 20,
    },
    body: {
        color: theme.colors.text.secondary,
        ...Typography.variant('body'),
        marginTop: 3,
    },
    // Columns bleed to the sheet edges so their dividers meet the band's hairlines.
    benefitColumns: {
        flexDirection: 'row',
        marginHorizontal: -PAGE_LIST_METRICS.rowPaddingHorizontalPx,
    },
    benefitColumn: {
        flex: 1,
        minWidth: 0,
        paddingHorizontal: PAGE_LIST_METRICS.rowPaddingHorizontalPx,
    },
    benefitColumnDivider: {
        borderLeftWidth: StyleSheet.hairlineWidth,
        borderLeftColor: theme.colors.border.subtle,
    },
    benefitLine: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        columnGap: 14,
        rowGap: theme.space.s6,
    },
    benefitHeading: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s6,
    },
    benefitTitle: {
        color: theme.colors.text.primary,
        ...Typography.variant('body', 'medium'),
    },
    benefitDescription: {
        color: theme.colors.text.secondary,
        ...Typography.variant('meta'),
        marginTop: 3,
    },
    benefitLineTitle: {
        color: theme.colors.text.secondary,
        ...Typography.variant('body'),
    },
}));
