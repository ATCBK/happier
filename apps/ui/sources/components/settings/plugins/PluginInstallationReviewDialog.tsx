import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Switch } from '@/components/ui/forms/Switch';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Typography } from '@/constants/Typography';
import { Modal, type CustomModalInjectedProps } from '@/modal';
import { createDeferredOnce } from '@/modal/async/createDeferredOnce';
import { t } from '@/text';
import type {
    PluginChangePendingReviewResult,
    PluginInstallationReview,
} from '@happier-dev/protocol/marketplace/internal';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation/pageMetrics';
import { describePluginInstallationReviewFacts, type PluginInstallationReviewFactSection } from './model/pluginInstallationReviewFacts';

type AuthorityExpansion = Extract<PluginChangePendingReviewResult, Readonly<{
    kind: 'reviewRequired';
    reviewKind: 'installation';
}>>['authorityExpansion'];

export type PluginInstallationReviewResolution =
    | Readonly<{
        approved: true;
        optionalSelections: readonly Readonly<{ accessId: string; selected: boolean }>[];
    }>
    | Readonly<{
        approved: false;
        optionalSelections: readonly [];
    }>;

type PluginInstallationReviewDialogProps = CustomModalInjectedProps & Readonly<{
    review: PluginInstallationReview;
    reason?: 'firstInstall' | 'authorityExpansion';
    currentVersion?: string | null;
    authorityExpansion?: AuthorityExpansion;
    /**
     * The exact machine and server this install-and-trust decision lands on.
     *
     * Trust is granted on ONE machine reached through ONE server. A review that
     * names only the package describes a decision the user cannot locate, and
     * the identical wording against a different selected target is a different,
     * irreversible grant.
     */
    target: Readonly<{ machine: string; server: string }>;
    onResolve: (resolution: PluginInstallationReviewResolution) => void;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    body: {
        flexGrow: 1,
        paddingHorizontal: theme.space.s20,
        paddingTop: theme.space.s16,
        paddingBottom: theme.space.s20,
        gap: theme.space.s16,
    },
    reviewBody: {
        ...Typography.default(),
        color: theme.colors.text.primary,
    },
    section: {
        gap: theme.space.s6,
    },
    sectionTitle: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
    },
    sectionBody: {
        ...Typography.default(),
        color: theme.colors.text.secondary,
    },
    reviewTarget: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.secondary,
    },
    optionalList: {
        gap: theme.space.s8,
    },
    optionalRow: {
        minHeight: 56,
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s12,
        paddingHorizontal: theme.space.s12,
        paddingVertical: theme.space.s8,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.inset,
    },
    optionalCopy: {
        flex: 1,
        gap: theme.space.s2,
    },
    optionalTitle: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
    },
    optionalReason: {
        ...Typography.default(),
        color: theme.colors.text.secondary,
    },
    actions: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        justifyContent: 'flex-end',
        gap: theme.space.s8,
    },
}));

function ReviewSection(props: Readonly<{
    testID: string;
    section: PluginInstallationReviewFactSection;
}>): React.ReactElement {
    return (
        <View testID={props.testID} style={stylesheet.section}>
            <Text style={stylesheet.sectionTitle} accessibilityRole="header">{props.section.title}</Text>
            <Text style={stylesheet.sectionBody}>{props.section.lines.join('\n')}</Text>
        </View>
    );
}

export function PluginInstallationReviewDialog(props: PluginInstallationReviewDialogProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const [selectedByAccessId, setSelectedByAccessId] = React.useState<Readonly<Record<string, boolean>>>({});
    const [evidenceExpanded, setEvidenceExpanded] = React.useState(false);
    const isAuthorityExpansion = props.reason === 'authorityExpansion';
    // One presentation owner decides which facts this decision shows and how they read.
    const facts = describePluginInstallationReviewFacts(props.review, {
        reason: props.reason,
        currentVersion: props.currentVersion,
        authorityExpansion: props.authorityExpansion,
    });
    const showsOptionalAccess = facts.optionalAccess !== null;

    const resolve = React.useCallback((resolution: PluginInstallationReviewResolution) => {
        props.onResolve(resolution);
        props.onClose();
    }, [props]);

    const approve = React.useCallback(() => {
        const optionalSelections = isAuthorityExpansion
            ? Object.entries(selectedByAccessId).map(([accessId, selected]) => ({ accessId, selected }))
            : props.review.optionalHostAccess.map((entry) => ({
                accessId: entry.id,
                selected: selectedByAccessId[entry.id] === true,
            }));
        resolve({
            approved: true,
            optionalSelections: showsOptionalAccess ? optionalSelections : [],
        });
    }, [isAuthorityExpansion, props.review.optionalHostAccess, resolve, selectedByAccessId, showsOptionalAccess]);

    return (
        <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={styles.body}
            keyboardShouldPersistTaps="handled"
        >
            <ReviewSection testID="settings.plugins.installReview.identity" section={facts.identity} />
            <Text
                testID="settings.plugins.installReview.target"
                style={styles.reviewTarget}
            >
                {t('settingsPlugins.pluginChangeConfirmTarget', {
                    machine: props.target.machine,
                    server: props.target.server,
                })}
            </Text>
            {facts.archiveUrlRetention ? (
                <Text testID="settings.plugins.installReview.archiveUrlRetention" style={styles.reviewBody}>
                    {facts.archiveUrlRetention}
                </Text>
            ) : null}
            {facts.trustedCode ? <ReviewSection testID="settings.plugins.installReview.trustedCode" section={facts.trustedCode} /> : null}
            {facts.executableCode ? <ReviewSection testID="settings.plugins.installReview.executableCode" section={facts.executableCode} /> : null}
            {facts.requiredAccess ? <ReviewSection testID="settings.plugins.installReview.requiredAccess" section={facts.requiredAccess} /> : null}
            {facts.optionalAccess && facts.optionalAccess.entries.length > 0 ? (
                <View testID="settings.plugins.installReview.optionalAccess" style={styles.optionalList}>
                    <Text style={styles.sectionTitle} accessibilityRole="header">{facts.optionalAccess.title}</Text>
                    {facts.optionalAccess.entries.map((entry) => {
                        const selected = selectedByAccessId[entry.id] === true;
                        const accessibilityLabel = `${entry.capability}: ${entry.reason}`;
                        return (
                            <View key={entry.id} style={styles.optionalRow}>
                                <View style={styles.optionalCopy}>
                                    <Text style={styles.optionalTitle}>{entry.capability}</Text>
                                    <Text style={styles.optionalReason}>{entry.reason}</Text>
                                    <Text style={styles.optionalReason}>{entry.scope}</Text>
                                </View>
                                <Switch
                                    testID={`settings.plugins.installReview.optional.${entry.id}`}
                                    accessibilityRole="switch"
                                    accessibilityLabel={accessibilityLabel}
                                    accessibilityState={{ checked: selected }}
                                    value={selected}
                                    onValueChange={(next) => {
                                        setSelectedByAccessId((current) => ({
                                            ...current,
                                            [entry.id]: next,
                                        }));
                                    }}
                                />
                            </View>
                        );
                    })}
                </View>
            ) : null}
            {facts.requestInterceptors ? <ReviewSection testID="settings.plugins.installReview.requestInterceptors" section={facts.requestInterceptors} /> : null}
            {facts.rawCredentials ? <ReviewSection testID="settings.plugins.installReview.rawCredentials" section={facts.rawCredentials} /> : null}
            <ExpandableItem
                expanded={evidenceExpanded}
                onExpandedChange={setEvidenceExpanded}
                showDivider={false}
                header={({ expanded, headerProps }) => (
                    <Item
                        {...headerProps}
                        testID="settings.plugins.installReview.evidenceToggle"
                        title={facts.evidence.title}
                        accessibilityExpanded={expanded}
                        showChevron={false}
                        rightElement={<Icon name={expanded ? 'caret-up' : 'caret-down'} size={20} color={theme.colors.text.secondary} />}
                    />
                )}
            >
                <View testID="settings.plugins.installReview.evidence" style={styles.section}>
                    <Text style={styles.sectionBody}>{facts.evidence.lines.join('\n')}</Text>
                </View>
            </ExpandableItem>
            <View style={styles.actions}>
                <RoundButton
                    testID="settings.plugins.installReview.cancel"
                    display="secondary"
                    title={t('common.cancel')}
                    accessibilityLabel={t('common.cancel')}
                    onPress={() => resolve({ approved: false, optionalSelections: [] })}
                />
                <RoundButton
                    testID="settings.plugins.installReview.confirm"
                    title={isAuthorityExpansion ? t('common.update') : t('settingsPlugins.installAndTrust')}
                    accessibilityLabel={isAuthorityExpansion ? t('common.update') : t('settingsPlugins.installAndTrust')}
                    onPress={approve}
                />
            </View>
        </ScrollView>
    );
}

export async function showPluginInstallationReviewDialog(params: Readonly<{
    title: string;
    review: PluginInstallationReview;
    reason?: 'firstInstall' | 'authorityExpansion';
    currentVersion?: string | null;
    authorityExpansion?: AuthorityExpansion;
    target: Readonly<{ machine: string; server: string }>;
}>): Promise<PluginInstallationReviewResolution> {
    const deferred = createDeferredOnce<PluginInstallationReviewResolution>();
    Modal.show({
        component: PluginInstallationReviewDialog,
        props: {
            review: params.review,
            reason: params.reason,
            currentVersion: params.currentVersion,
            authorityExpansion: params.authorityExpansion,
            target: params.target,
            onResolve: deferred.resolve,
        },
        onRequestClose: () => deferred.resolve({ approved: false, optionalSelections: [] }),
        onHostUnmount: () => deferred.resolve({ approved: false, optionalSelections: [] }),
        chrome: {
            kind: 'card',
            title: params.title,
            testID: 'settings.plugins.installReview',
            scrollHost: 'body',
            bodyScroll: 'none',
            dimensions: { width: HAPPIER_PAGE_METRICS.dialogWidthPx.wide, maxHeightRatio: 0.9, size: 'lg' },
        },
        closeOnBackdrop: true,
    });
    return await deferred.promise;
}
