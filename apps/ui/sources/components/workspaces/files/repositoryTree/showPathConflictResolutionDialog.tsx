import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Modal } from '@/modal';
import { createDeferredOnce } from '@/modal/async/createDeferredOnce';
import type { CustomModalInjectedProps } from '@/modal';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';
import { Text } from '@/components/ui/text/Text';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation/pageMetrics';

export type PathConflictResolutionStrategy = 'keep_both' | 'replace' | 'skip' | 'cancel';

const stylesheet = StyleSheet.create((theme) => ({
    options: {
        flex: 1,
        minHeight: 0,
        paddingHorizontal: theme.space.s12,
        paddingTop: 14,
        paddingBottom: 14,
        gap: theme.space.s10,
    },
    optionButton: {
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.inset,
        paddingHorizontal: 14,
        paddingVertical: theme.space.s12,
        gap: theme.space.s2,
    },
    optionTitle: {
        ...Typography.variant('body', 'semiBold'),
        color: theme.colors.text.primary,
    },
    optionSubtitle: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
    optionPrimaryBorder: {
        borderColor: theme.colors.text.link,
    },
    cancelRow: {
        paddingVertical: theme.space.s10,
        alignItems: 'center',
    },
    cancelText: {
        ...Typography.variant('body', 'semiBold'),
        color: theme.colors.text.secondary,
    },
}));

function PathConflictOption(props: Readonly<{
    testID: string;
    title: string;
    subtitle: string;
    primary?: boolean;
    onPress: () => void;
}>): React.ReactElement {
    const styles = stylesheet;
    return (
        <Pressable
            testID={props.testID}
            accessibilityRole="button"
            onPress={props.onPress}
            style={({ pressed }) => ([
                styles.optionButton,
                props.primary ? styles.optionPrimaryBorder : null,
                pressed ? { opacity: motionTokens.press.opacitySubtle } : null,
            ])}
        >
            <Text style={styles.optionTitle}>{props.title}</Text>
            <Text style={styles.optionSubtitle}>{props.subtitle}</Text>
        </Pressable>
    );
}

type PathConflictResolutionDialogProps = CustomModalInjectedProps & Readonly<{
    allowSkip: boolean;
    primaryStrategy?: Exclude<PathConflictResolutionStrategy, 'cancel'> | null;
    testIdPrefix: string;
    onResolve: (strategy: PathConflictResolutionStrategy) => void;
}>;

const PathConflictResolutionDialog: React.FC<PathConflictResolutionDialogProps> = (props) => {
    const styles = stylesheet;
    useUnistyles();

    return (
        <View style={styles.options}>
            <PathConflictOption
                testID={`${props.testIdPrefix}-keep-both`}
                title={t('files.upload.conflicts.keepBoth.title')}
                subtitle={t('files.upload.conflicts.keepBoth.subtitle')}
                primary={props.primaryStrategy === 'keep_both'}
                onPress={() => {
                    props.onResolve('keep_both');
                    props.onClose();
                }}
            />
            <PathConflictOption
                testID={`${props.testIdPrefix}-replace`}
                title={t('files.upload.conflicts.replace.title')}
                subtitle={t('files.upload.conflicts.replace.subtitle')}
                primary={props.primaryStrategy === 'replace'}
                onPress={() => {
                    props.onResolve('replace');
                    props.onClose();
                }}
            />
            {props.allowSkip ? (
                <PathConflictOption
                    testID={`${props.testIdPrefix}-skip`}
                    title={t('files.upload.conflicts.skip.title')}
                    subtitle={t('files.upload.conflicts.skip.subtitle')}
                    primary={props.primaryStrategy === 'skip'}
                    onPress={() => {
                        props.onResolve('skip');
                        props.onClose();
                    }}
                />
            ) : null}
            <Pressable
                testID={`${props.testIdPrefix}-cancel`}
                accessibilityRole="button"
                onPress={() => {
                    props.onResolve('cancel');
                    props.onClose();
                }}
                style={({ pressed }) => [
                    styles.cancelRow,
                    pressed ? { opacity: motionTokens.press.opacitySubtle } : null,
                ]}
            >
                <Text style={styles.cancelText}>{t('common.cancel')}</Text>
            </Pressable>
        </View>
    );
};

export async function showPathConflictResolutionDialog(params: Readonly<{
    title: string;
    body: string;
    allowSkip: boolean;
    primaryStrategy?: Exclude<PathConflictResolutionStrategy, 'cancel'> | null;
    testIdPrefix?: string;
    signal?: AbortSignal | null;
}>): Promise<PathConflictResolutionStrategy> {
    if (params.signal?.aborted) return 'cancel';

    const deferred = createDeferredOnce<PathConflictResolutionStrategy>();
    let modalId: string | null = null;
    let settled = false;

    const settle = (strategy: PathConflictResolutionStrategy) => {
        if (settled) return;
        settled = true;
        params.signal?.removeEventListener('abort', onAbort);
        deferred.resolve(strategy);
    };
    const onAbort = () => {
        if (settled) return;
        if (modalId) Modal.hide(modalId);
        settle('cancel');
    };

    params.signal?.addEventListener('abort', onAbort, { once: true });
    modalId = Modal.show({
        component: PathConflictResolutionDialog,
        props: {
            allowSkip: params.allowSkip,
            primaryStrategy: params.primaryStrategy ?? null,
            testIdPrefix: params.testIdPrefix ?? 'path-conflicts',
            onResolve: settle,
        },
        onRequestClose: () => settle('cancel'),
        chrome: {
            kind: 'card',
            title: params.title,
            subtitle: params.body,
            testID: `${params.testIdPrefix ?? 'path-conflicts'}-modal`,
            bodyScroll: 'auto',
            dimensions: { width: HAPPIER_PAGE_METRICS.dialogWidthPx.default, maxHeightRatio: 0.85, size: 'md' },
        },
        closeOnBackdrop: true,
    });
    if (params.signal?.aborted) onAbort();
    return await deferred.promise;
}
