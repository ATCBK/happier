import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { GitPullRequestBodyDraftAction } from '@/components/sessions/panes/git/pullRequest/GitPullRequestBodyDraftAction';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import type { WalkthroughSpecimenFrame } from './WalkthroughSpecimen';

const noop = () => {};
const BODY = 'Discounts now apply per line, so a coupon no longer changes the shipping total.';

/**
 * The new pull request form's description zone at static props: the real title and body fields with the real
 * draft action beneath them, in the sidebar's card. The form itself needs a Session, a Machine and a saved
 * summary, so the states a person cannot be put into on demand (a request the Machine may not have received, a
 * stop that was refused) are shown here.
 */
function FormFrame(props: Readonly<{ phone: boolean; action: React.ComponentProps<typeof GitPullRequestBodyDraftAction> }>) {
    return (
        <View style={[styles.card, props.phone ? styles.cardPhone : null]}>
            <Text style={styles.title}>{t('sessionGitPullRequest.form.title')}</Text>
            <FieldTextInput value="Apply coupons per line" onChangeText={noop} placeholder={t('sessionGitPullRequest.form.titlePlaceholder')} accessibilityLabel={t('sessionGitPullRequest.form.titlePlaceholder')} editable={false} />
            <FieldTextInput value={BODY} onChangeText={noop} placeholder={t('sessionGitPullRequest.form.bodyPlaceholder')} accessibilityLabel={t('sessionGitPullRequest.form.bodyPlaceholder')} editable={false} multiline minLines={4} />
            <GitPullRequestBodyDraftAction {...props.action} />
        </View>
    );
}

const PENDING = { drafting: true, canDraft: false, prerequisite: null, uncertain: false, message: null, onDraft: noop, onCheckAdmission: noop } as const;

export const PULL_REQUEST_FORM_SPECIMEN_FRAMES: readonly WalkthroughSpecimenFrame[] = [
    { id: 'TPD0', title: 'PR form · description idle', render: (phone) => <FormFrame phone={phone} action={{ ...PENDING, drafting: false, canDraft: true }} /> },
    { id: 'TPD1', title: 'PR form · description pending with a matching Run (Cancel)', render: (phone) => <FormFrame phone={phone} action={{ ...PENDING, onCancel: noop }} /> },
    { id: 'TPD2', title: 'PR form · description pending, the Machine may not have received it', render: (phone) => <FormFrame phone={phone} action={{ ...PENDING, uncertain: true, onCancel: noop }} /> },
];

const styles = StyleSheet.create((theme) => ({
    card: {
        width: 380,
        alignSelf: 'center',
        padding: theme.space.s12,
        gap: theme.space.s10,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.elevated,
    },
    cardPhone: { width: 'auto', alignSelf: 'stretch' },
    title: { ...Typography.variant('heading'), color: theme.colors.text.primary },
}));
