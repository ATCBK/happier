import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Header, DefaultBackButton } from '@/components/navigation/Header';
import { HeaderTitleWithAction } from '@/components/navigation/HeaderTitleWithAction';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { resolveSessionScmReviewViewLabel, type SessionScmReviewView } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import { t } from '@/text';
import { ScmComparisonScopePicker, type ScmComparisonScopePickerProps } from './ScmComparisonScopePicker';
import { scmComparisonMenuSectionItems, selectScmComparisonMenuItem, type ScmComparisonMenuSection } from './ScmComparisonMoreMenu';

export type { ScmComparisonMenuSection } from './ScmComparisonMoreMenu';

/** Phone comparison navigation: the standard header, with the same scope and actions as the wide bar. */
export function ScmComparisonPhoneHeader(props: Readonly<{
    view: SessionScmReviewView;
    views: readonly SessionScmReviewView[];
    scope: ScmComparisonScopePickerProps;
    onSelectView: (view: SessionScmReviewView) => void;
    /** Leaves the comparison (closes its Details tab). A host with nowhere to go back to (the Project companion) passes none, and no arrow is drawn. */
    onBack?: (() => void) | null;
    /** Null when the comparison has nothing to review: the row is not offered. */
    onStartReview: (() => void) | null;
    reviewDisabled?: boolean;
    reviewDisabledReason?: string | null;
    onProposeCommits?: (() => void) | null;
    /** The view's own menu rows, after the comparison's actions and its view choice. */
    sections?: readonly ScmComparisonMenuSection[];
    /** View-owned content that is not a menu row (a walkthrough's review progress), under the rows. */
    extraActions?: React.ReactNode;
}>) {
    const { theme } = useUnistyles();
    const [open, setOpen] = React.useState(false);
    // One menu, in the order it is used: what to do with these changes, which view of them, how they are drawn.
    const sections = props.sections ?? [];
    const untitled = sections.filter((section) => !section.title);
    const titled = sections.filter((section) => section.title);
    const sectionItems = scmComparisonMenuSectionItems;
    const items: DropdownMenuItem[] = [
        ...untitled.flatMap((section) => sectionItems(section, '')),
        ...(props.onStartReview ? [{ id: 'start-review', testID: 'scm-comparison-start-review', title: t('scmComparison.startReview'), category: '',
            icon: <Icon name="shield-check" size={ICON_SIZE.sm} color={theme.colors.text.secondary} />,
            disabled: props.reviewDisabled, subtitle: props.reviewDisabledReason ?? undefined }] : []),
        ...(props.onProposeCommits ? [{ id: 'propose-commits', title: t('scmComparison.proposeCommits'), category: '',
            icon: <Icon name="git-commit" size={ICON_SIZE.sm} color={theme.colors.text.secondary} /> }] : []),
        ...props.views.map((view) => ({ id: `view:${view}`, title: resolveSessionScmReviewViewLabel(view),
            checked: props.view === view, category: t('scmComparison.viewA11y') })),
        ...titled.flatMap((section) => sectionItems(section, section.title!)),
    ];
    const subtitle = [props.scope.currentLabel, props.scope.fileCount === null ? null
        : t('scmComparison.fileCount', { count: props.scope.fileCount })].filter(Boolean).join(' · ');
    const onBack = props.onBack;
    return <Header safeAreaEnabled={false} headerShadowVisible={false}
        headerLeft={onBack ? () => <DefaultBackButton testID="scm-comparison-phone-back" tintColor={theme.colors.text.primary} onPress={onBack} /> : null}
        title={<ScmComparisonScopePicker {...props.scope} renderTrigger={({ toggle, open: scopeOpen }) => <HeaderTitleWithAction
            title={resolveSessionScmReviewViewLabel(props.view)} subtitle={subtitle} actionLabel={t('scmComparison.scopePicker.a11y')}
            actionIconName={scopeOpen ? 'caret-up' : 'caret-down'} onActionPress={toggle} />} />}
        headerRight={() => <DropdownMenu testID="scm-comparison-phone-actions" open={open} onOpenChange={setOpen}
            items={items} search={false} matchTriggerWidth={false} placement="bottom" popoverAnchorAlign="end"
            showCategoryTitles
            footer={props.extraActions ? <View style={styles.extraActions}>{props.extraActions}</View> : undefined}
            onSelect={(id) => {
                const view = props.views.find((candidate) => id === `view:${candidate}`);
                if (selectScmComparisonMenuItem(sections, id)) return;
                if (view) props.onSelectView(view);
                else if (id === 'start-review' && !props.reviewDisabled) props.onStartReview?.();
                else if (id === 'propose-commits') props.onProposeCommits?.();
            }}
            trigger={({ toggle }) => <IconButton testID="scm-comparison-phone-more" iconName="dots-three" variant="plain"
                accessibilityLabel={t('common.more')} onPress={toggle} />} />} />;
}

const styles = StyleSheet.create(() => ({ extraActions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: 12 } }));
