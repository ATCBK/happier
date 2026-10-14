import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Typography } from '@/constants/Typography';
import { Text } from '@/components/ui/text/Text';
import { Modal } from '@/modal';
import { createDeferredOnce } from '@/modal/async/createDeferredOnce';
import type { CustomModalInjectedProps } from '@/modal';
import { t } from '@/text';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation/pageMetrics';

export type SwitchBranchWithChangesDialogResolution = 'stash_on_current_branch' | 'bring_changes' | 'cancel';

export type SwitchBranchWithChangesDialogProps = CustomModalInjectedProps & Readonly<{
    currentBranch: string;
    targetBranch: string;
    onResolve: (resolution: SwitchBranchWithChangesDialogResolution) => void;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    body: {
        flex: 1,
        minHeight: 0,
        paddingHorizontal: theme.space.s16,
        paddingTop: 14,
        paddingBottom: theme.space.s12,
        gap: theme.space.s10,
    },
    button: {
        paddingVertical: theme.space.s12,
        paddingHorizontal: 14,
        borderRadius: 12,
        backgroundColor: theme.colors.surface.inset,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
    },
    buttonTitle: {
        ...Typography.variant('label', 'semiBold'),
        color: theme.colors.text.primary,
    },
    buttonSubtitle: {
        marginTop: theme.space.s4,
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
    cancelButton: {
        paddingVertical: theme.space.s10,
        paddingHorizontal: 14,
        borderRadius: 12,
    },
    cancelText: {
        ...Typography.variant('label', 'semiBold'),
        color: theme.colors.text.link,
    },
}));

export function SwitchBranchWithChangesDialog(props: SwitchBranchWithChangesDialogProps) {
    useUnistyles();
    const styles = stylesheet;

    const resolve = React.useCallback(
        (resolution: SwitchBranchWithChangesDialogResolution) => {
            props.onResolve(resolution);
            props.onClose();
        },
        [props],
    );

    return (
        <View style={styles.body}>
            <Pressable
                testID="switch-branch-leave-changes"
                onPress={() => resolve('stash_on_current_branch')}
                style={({ pressed }) => [styles.button, { opacity: pressed ? motionTokens.press.opacitySubtle : 1 }]}
            >
                <Text style={styles.buttonTitle}>
                    {t('files.branchSwitchDialog.leaveTitle', { branch: props.currentBranch })}
                </Text>
                <Text style={styles.buttonSubtitle}>{t('files.branchSwitchDialog.leaveSubtitle')}</Text>
            </Pressable>

            <Pressable
                testID="switch-branch-bring-changes"
                onPress={() => resolve('bring_changes')}
                style={({ pressed }) => [styles.button, { opacity: pressed ? motionTokens.press.opacitySubtle : 1 }]}
            >
                <Text style={styles.buttonTitle}>
                    {t('files.branchSwitchDialog.bringTitle', { branch: props.targetBranch })}
                </Text>
                <Text style={styles.buttonSubtitle}>{t('files.branchSwitchDialog.bringSubtitle')}</Text>
            </Pressable>

            <Pressable
                testID="switch-branch-cancel"
                onPress={() => resolve('cancel')}
                style={({ pressed }) => [styles.cancelButton, { opacity: pressed ? motionTokens.press.opacity : 1 }]}
            >
                <Text style={styles.cancelText}>{t('common.cancel')}</Text>
            </Pressable>
        </View>
    );
}

export async function showSwitchBranchWithChangesDialog(params: Readonly<{
    currentBranch: string;
    targetBranch: string;
}>): Promise<SwitchBranchWithChangesDialogResolution> {
    const deferred = createDeferredOnce<SwitchBranchWithChangesDialogResolution>();
    Modal.show({
        component: SwitchBranchWithChangesDialog,
        props: {
            currentBranch: params.currentBranch,
            targetBranch: params.targetBranch,
            onResolve: deferred.resolve,
        },
        onRequestClose: () => deferred.resolve('cancel'),
        chrome: {
            kind: 'card',
            title: t('files.branchSwitchDialog.title'),
            subtitle: t('files.branchSwitchDialog.body'),
            testID: 'switch-branch-with-changes-dialog',
            bodyScroll: 'auto',
            dimensions: { width: HAPPIER_PAGE_METRICS.dialogWidthPx.wide, maxHeightRatio: 0.85, size: 'md' },
        },
        closeOnBackdrop: true,
    });
    return await deferred.promise;
}
